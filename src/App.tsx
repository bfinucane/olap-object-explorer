import { useCallback, useEffect, useState } from 'react';
import {
  engineApi,
  engineBase,
  engineLabel,
  engineTarget,
  errorCode,
  errorText,
  isUnauthorized,
} from './api';
import {
  clearAuth,
  getSession,
  hasToken,
  restoreSession,
  seedTokenFromUrl,
  setAuth,
  setUnauthorizedHandler,
  type SessionInfo,
} from './auth';
import { discovery, resetDiscoveryCache, type DimensionInfo, type MemberTree } from './discovery';
import { DetailsPane } from './details';
import { ErrorNotice } from './errorNotice';
import { formatCount, formatWeight } from './format';
import { LoginScreen } from './login';
import type { MemberNode } from './memberTree';
import { PreviewPane } from './preview';
import type { Selection } from './selection';
import { SqlConsole } from './sql';
import { Tree, type TreeNodeModel } from './tree';
import type { Capabilities, ColumnDescription, DatasetDescription } from './types';

type LoadState<T> = { status: 'loading' } | { status: 'ready'; data: T } | { status: 'error'; error: unknown };

interface TreeSource {
  datasets: string[];
  dimensions: DimensionInfo[];
}

type TabId = 'details' | 'preview' | 'sql';

/**
 * Whether the shell may show data: an engine with auth enabled and no token gets
 * the login screen instead of a tree full of 401 errors.
 */
type AuthView = { status: 'checking' } | { status: 'login'; reason: 'required' | 'expired' } | { status: 'active' };

/**
 * Shell for the standalone object explorer.
 *
 * Data flow: every tree level is loaded on first expand through `discovery` (one
 * engine query per level, promise-cached). Selection is mirrored into the right
 * pane; nothing is fetched up front, and nothing is ever written.
 *
 * Auth flow: `capabilities` is public, so it is read first. If the engine reports
 * `authRequired: true` and there is no token, the login screen replaces the shell;
 * a 401 from any later request (engine restart, 12h expiry) sends the user back
 * there with an "expired" explanation. Anonymous engines (`--allow-anonymous`,
 * or the older binary on 8080 today) never see a login screen.
 */
export default function App() {
  const [capabilities, setCapabilities] = useState<LoadState<Capabilities>>({ status: 'loading' });
  const [source, setSource] = useState<LoadState<TreeSource>>({ status: 'loading' });
  const [authView, setAuthView] = useState<AuthView>({ status: 'checking' });
  const [session, setSession] = useState<SessionInfo | null>(() => getSession());
  const [tab, setTab] = useState<TabId>('details');
  const [selection, setSelection] = useState<Selection>({ kind: 'empty' });
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const loadTree = useCallback(async () => {
    setSource({ status: 'loading' });
    try {
      const [datasets, dimensions] = await Promise.all([discovery.datasets(), discovery.dimensions()]);
      setSource({ status: 'ready', data: { datasets, dimensions } });
    } catch (error) {
      setSource({ status: 'error', error });
    }
  }, []);

  /**
   * Read capabilities (public) and decide between login and data. If a stored
   * token is rejected, retry anonymously to distinguish "session expired" from
   * "this engine never needed auth" (a stale token against `-Anonymous` must not
   * strand the user on a login screen that can never succeed).
   */
  const bootstrap = useCallback(async () => {
    setAuthView({ status: 'checking' });
    setCapabilities({ status: 'loading' });
    setSession(getSession());

    const offline = (error: unknown) => {
      setCapabilities({ status: 'error', error });
      setAuthView({ status: 'active' });
    };

    try {
      const caps = await engineApi.capabilities({ suppressUnauthorized: true });
      setCapabilities({ status: 'ready', data: caps });
      if (caps.authRequired === true && !hasToken()) {
        setAuthView({ status: 'login', reason: 'required' });
        return;
      }
      setAuthView({ status: 'active' });
      await loadTree();
    } catch (error) {
      if (!isUnauthorized(error)) {
        offline(error);
        return;
      }

      const hadToken = hasToken();
      if (hadToken) {
        clearAuth();
        setSession(null);
      }
      try {
        const caps = await engineApi.capabilities({ suppressUnauthorized: true });
        setCapabilities({ status: 'ready', data: caps });
        if (caps.authRequired === true) {
          setAuthView({ status: 'login', reason: hadToken ? 'expired' : 'required' });
          return;
        }
        setAuthView({ status: 'active' });
        await loadTree();
      } catch (retryError) {
        if (isUnauthorized(retryError)) {
          setAuthView({ status: 'login', reason: hadToken ? 'expired' : 'required' });
          return;
        }
        offline(retryError);
      }
    }
  }, [loadTree]);

  useEffect(() => {
    restoreSession();
    seedTokenFromUrl();
    setSession(getSession());
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    setUnauthorizedHandler((reason) => {
      // Session died under us (engine restart or expiry): drop everything that
      // was fetched with that token and show the login screen.
      resetDiscoveryCache();
      setSession(null);
      setSelection({ kind: 'empty' });
      setSelectedId(null);
      setSource({ status: 'loading' });
      setAuthView({ status: 'login', reason });
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  const refresh = useCallback(() => {
    resetDiscoveryCache();
    setSelection({ kind: 'empty' });
    setSelectedId(null);
    void bootstrap();
  }, [bootstrap]);

  const login = useCallback(
    async (user: string, password: string) => {
      const result = await engineApi.login(user, password);
      const nextSession: SessionInfo = {
        user: result.user,
        roles: result.roles,
        expiresAt: result.expiresAt,
      };
      setAuth(result.token, nextSession);
      setSession(nextSession);
      try {
        setCapabilities({ status: 'ready', data: await engineApi.capabilities({ suppressUnauthorized: true }) });
      } catch (error) {
        setCapabilities({ status: 'error', error });
      }
      setAuthView({ status: 'active' });
      await loadTree();
    },
    [loadTree],
  );

  const logout = useCallback(() => {
    clearAuth();
    resetDiscoveryCache();
    setSession(null);
    setSelection({ kind: 'empty' });
    setSelectedId(null);
    setSource({ status: 'loading' });
    setAuthView({ status: 'login', reason: 'required' });
  }, []);

  const selectCube = useCallback(async (name: string) => {
    setSelectedId(`cube:${name}`);
    setSelection({ kind: 'loading', label: name });
    try {
      setSelection({ kind: 'cube', dataset: await discovery.describe(name) });
    } catch (error) {
      setSelection({ kind: 'error', label: name, error });
    }
  }, []);

  const selectColumn = useCallback((dataset: DatasetDescription, column: ColumnDescription) => {
    setSelectedId(`column:${dataset.dataset}:${column.name}`);
    setSelection({ kind: 'column', dataset, column });
  }, []);

  const selectDimension = useCallback((dimension: DimensionInfo) => {
    setSelectedId(`dimension:${dimension.name}`);
    setSelection({ kind: 'dimension', dimension });
  }, []);

  const selectHierarchy = useCallback((dimension: string, hierarchy: string) => {
    setSelectedId(`hierarchy:${dimension}:${hierarchy}`);
    setSelection({ kind: 'hierarchy', dimension, hierarchy });
  }, []);

  const selectMember = useCallback(
    (dimension: string, hierarchy: string, path: string[], node: MemberNode) => {
      setSelectedId(`member:${hierarchy}:${path.join('/')}`);
      setSelection({
        kind: 'member',
        dimension,
        hierarchy,
        path,
        weight: node.weight,
        childCount: node.children.length,
      });
    },
    [],
  );

  const handleTreeSelect = useCallback((node: TreeNodeModel) => {
    setSelectedId(node.id);
    node.onSelect?.();
  }, []);

  // --- tree models ---------------------------------------------------------

  const buildColumnModel = (dataset: DatasetDescription, column: ColumnDescription): TreeNodeModel => ({
    id: `column:${dataset.dataset}:${column.name}`,
    label: column.name,
    kind: column.suggestedKind === 'measure' ? 'column-measure' : 'column-dimension',
    detail: `${column.dataType} · ${formatCount(column.cardinality)}`,
    onSelect: () => selectColumn(dataset, column),
  });

  const buildMemberModels = (
    dimension: string,
    hierarchy: string,
    nodes: MemberNode[],
    prefix: string[],
  ): TreeNodeModel[] =>
    nodes.map((node) => {
      const path = [...prefix, node.name];
      return {
        id: `member:${hierarchy}:${path.join('/')}`,
        label: node.name,
        kind: 'member',
        glyph: node.children.length > 0 ? '⊕' : '·',
        detail: node.weight !== null ? `×${formatWeight(node.weight)}` : undefined,
        loadChildren:
          node.children.length > 0
            ? () => Promise.resolve(buildMemberModels(dimension, hierarchy, node.children, path))
            : undefined,
        onSelect: () => selectMember(dimension, hierarchy, path, node),
      };
    });

  const buildHierarchyModel = (dimension: string, hierarchy: string): TreeNodeModel => ({
    id: `hierarchy:${dimension}:${hierarchy}`,
    label: hierarchy,
    kind: 'hierarchy',
    loadChildren: async () => {
      const tree: MemberTree = await discovery.memberTree(hierarchy);
      const models = buildMemberModels(dimension, hierarchy, tree.forest, []);
      if (tree.truncated) {
        models.unshift({
          id: `note:truncated:${hierarchy}`,
          label: 'partial: engine truncated #Members/#Edges',
          kind: 'note',
        });
      }
      return models;
    },
    onSelect: () => selectHierarchy(dimension, hierarchy),
  });

  const buildDimensionModel = (dimension: DimensionInfo): TreeNodeModel => ({
    id: `dimension:${dimension.name}`,
    label: dimension.name,
    kind: 'dimension',
    detail: dimension.hierarchyCount === 1 ? '1 hierarchy' : `${dimension.hierarchyCount} hierarchies`,
    loadChildren: async () =>
      (await discovery.hierarchies(dimension.name)).map((hierarchy) =>
        buildHierarchyModel(dimension.name, hierarchy),
      ),
    onSelect: () => selectDimension(dimension),
  });

  const buildCubeModel = (name: string, isSystem: boolean): TreeNodeModel => ({
    id: `cube:${name}`,
    label: name,
    kind: isSystem ? 'system-cube' : 'cube',
    loadChildren: async () => {
      const description = await discovery.describe(name);
      return description.columns.map((column) => buildColumnModel(description, column));
    },
    onSelect: () => {
      void selectCube(name);
    },
  });

  const groups: TreeNodeModel[] = [];
  if (source.status === 'ready') {
    const userCubes = source.data.datasets.filter((name) => !name.startsWith('#'));
    const systemCubes = source.data.datasets.filter((name) => name.startsWith('#'));
    groups.push(
      {
        id: 'section:cubes',
        label: 'Cubes',
        kind: 'section',
        detail: String(userCubes.length),
        expandedByDefault: true,
        children: userCubes.map((name) => buildCubeModel(name, false)),
      },
      {
        id: 'section:system',
        label: 'System cubes',
        kind: 'section',
        detail: String(systemCubes.length),
        expandedByDefault: true,
        children: systemCubes.map((name) => buildCubeModel(name, true)),
      },
      {
        id: 'section:dimensions',
        label: 'Dimensions',
        kind: 'section',
        detail: String(source.data.dimensions.length),
        expandedByDefault: true,
        children: source.data.dimensions.map((dimension) => buildDimensionModel(dimension)),
      },
    );
  }

  // --- header / banner -----------------------------------------------------

  const connectionState =
    capabilities.status === 'error' ? 'offline' : capabilities.status === 'ready' ? 'online' : 'connecting';

  const firstError =
    capabilities.status === 'error'
      ? capabilities.error
      : source.status === 'error'
        ? source.error
        : null;

  const previewDataset =
    selection.kind === 'cube' || selection.kind === 'column' ? selection.dataset.dataset : null;

  const contextLabel = describeSelection(selection);

  // When ?engine= overrides the proxy target, show what is actually being called.
  const effectiveEngine = engineBase() === '' ? engineTarget() : engineBase();

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            ▤
          </span>
          <div>
            <h1>OLAP Object Explorer</h1>
            <p className="brand-sub">Patricia engine · read-only</p>
          </div>
        </div>

        <div className="header-right">
          <span className={`pill pill-${connectionState}`}>
            {connectionState === 'online' ? 'online' : connectionState === 'offline' ? 'offline' : 'connecting…'}
          </span>
          {capabilities.status === 'ready' && (
            <span className="header-meta">
              protocol v{capabilities.data.protocolVersion} · max {formatCount(capabilities.data.maxRows)} rows
            </span>
          )}
          {capabilities.status === 'ready' && capabilities.data.authRequired === false && (
            <span className="header-auth" title="Engine started with --allow-anonymous: no token required.">
              anonymous
            </span>
          )}
          {session !== null && (
            <span
              className="header-user"
              data-testid="header-user"
              title={session.roles.length === 0 ? 'No roles' : `Roles: ${session.roles.join(', ')}`}
            >
              {session.user}
            </span>
          )}
          <span
            className="engine-target"
            title={
              engineBase() === ''
                ? `The Vite proxy forwards /v1 to ${engineTarget()}, so the browser never makes a cross-origin request.`
                : 'Engine base URL set with ?engine=; requests go straight there and need CORS on the engine.'
            }
          >
            {effectiveEngine}
          </span>
          {session !== null && (
            <button type="button" className="btn btn-header" data-testid="logout" onClick={logout}>
              Sign out
            </button>
          )}
          <button type="button" className="btn btn-header" onClick={refresh}>
            Refresh
          </button>
        </div>
      </header>

      {authView.status === 'active' && firstError !== null && (
        <div className="banner banner-error" role="alert">
          <div className="banner-text">
            <strong>Engine unreachable.</strong> {errorText(firstError)}
            {errorCode(firstError) !== null && <code>{errorCode(firstError)}</code>}
            <span>
              {' '}
              Start it in your own terminal with <code>start-engine.cmd</code> (port 8080), then retry.
            </span>
          </div>
          <button type="button" className="btn" onClick={refresh}>
            Retry
          </button>
        </div>
      )}

      {authView.status === 'checking' && (
        <div className="main-message" data-testid="connecting">
          <p className="muted">Connecting to {engineLabel()}…</p>
        </div>
      )}

      {authView.status === 'login' && (
        <LoginScreen engineLabel={engineLabel()} reason={authView.reason} onSubmit={login} />
      )}

      {authView.status === 'active' && (
        <main className="app-main">
        <aside className="tree-pane">
          <div className="pane-heading">
            Explorer
            <span className="pane-hint">click to expand · one query per level</span>
          </div>
          <div className="tree-scroll">
            {source.status === 'loading' && <p className="tree-fallback">Loading datasets…</p>}
            {source.status === 'error' && (
              <div className="tree-fallback">
                <ErrorNotice error={source.error} title="Could not load datasets" onRetry={refresh} />
              </div>
            )}
            {source.status === 'ready' && (
              <Tree groups={groups} selectedId={selectedId} onSelect={handleTreeSelect} />
            )}
          </div>
          <div className="tree-footer">
            <span title="Engine label">{engineLabel()}</span>
          </div>
        </aside>

        <section className="work-pane">
          <nav className="tabs" role="tablist" aria-label="Panels">
            <TabButton id="details" label="Details" active={tab} onSelect={setTab} />
            <TabButton id="preview" label="Preview" active={tab} onSelect={setTab} />
            <TabButton id="sql" label="SQL console" active={tab} onSelect={setTab} />
            <span className="tab-context" title={contextLabel}>
              {contextLabel}
            </span>
          </nav>

          <div className="tab-body" role="tabpanel">
            {tab === 'details' && (
              <DetailsPane
                selection={selection}
                onSelectCube={(name) => {
                  void selectCube(name);
                }}
                onSelectColumn={selectColumn}
                onSelectDimension={selectDimension}
                onSelectHierarchy={selectHierarchy}
                onShowPreview={() => setTab('preview')}
                onRetry={refresh}
              />
            )}
            {tab === 'preview' && (
              <PreviewPane datasetName={previewDataset} onOpenDetails={() => setTab('details')} />
            )}
            {tab === 'sql' && <SqlConsole />}
          </div>
        </section>
        </main>
      )}

      <footer className="app-footer">
        <span>
          Read-only HTTP client · discovery via <code>#Columns</code> <code>#Dimensions</code>{' '}
          <code>#Hierarchies</code> <code>#Members</code> <code>#Edges</code>
        </span>
        <span>No write API is called.</span>
      </footer>
    </div>
  );
}

function TabButton({
  id,
  label,
  active,
  onSelect,
}: {
  id: TabId;
  label: string;
  active: TabId;
  onSelect: (id: TabId) => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active === id}
      className={`tab${active === id ? ' is-active' : ''}`}
      data-testid={`tab-${id}`}
      onClick={() => onSelect(id)}
    >
      {label}
    </button>
  );
}

function describeSelection(selection: Selection): string {
  switch (selection.kind) {
    case 'empty':
      return 'nothing selected';
    case 'loading':
      return `loading ${selection.label}…`;
    case 'error':
      return selection.label;
    case 'cube':
      return `${selection.dataset.dataset} · ${formatCount(selection.dataset.rowCount)} rows`;
    case 'column':
      return `${selection.dataset.dataset}.${selection.column.name}`;
    case 'dimension':
      return `dimension ${selection.dimension.name}`;
    case 'hierarchy':
      return `${selection.dimension} › ${selection.hierarchy}`;
    case 'member':
      return `${selection.hierarchy} › ${selection.path.join(' › ')}`;
  }
}
