import { useEffect, useState } from 'react';
import { discovery, type DimensionInfo } from './discovery';
import { ErrorNotice } from './errorNotice';
import {
  formatCount,
  formatPrimaryKey,
  formatRange,
  formatType,
  formatWeight,
} from './format';
import type { Selection } from './selection';
import type { ColumnDescription, DatasetDescription } from './types';

export interface DetailsPaneProps {
  selection: Selection;
  onSelectCube: (name: string) => void;
  onSelectColumn: (dataset: DatasetDescription, column: ColumnDescription) => void;
  onSelectDimension: (dimension: DimensionInfo) => void;
  onSelectHierarchy: (dimension: string, hierarchy: string) => void;
  onShowPreview: () => void;
  onRetry: () => void;
}

/**
 * The SSMS-style properties pane. Every branch is driven by data the engine
 * actually returned: no field is invented and no write affordance exists,
 * because the engine has no write API (handoff §5.9).
 */
export function DetailsPane(props: DetailsPaneProps) {
  const { selection } = props;

  switch (selection.kind) {
    case 'empty':
      return <EmptyDetails />;
    case 'loading':
      return (
        <div className="details">
          <p className="muted">Loading {selection.label}…</p>
        </div>
      );
    case 'error':
      return (
        <div className="details">
          <ErrorNotice
            title={`Could not load ${selection.label}`}
            error={selection.error}
            onRetry={props.onRetry}
          />
        </div>
      );
    case 'cube':
      return <CubeDetails {...props} dataset={selection.dataset} />;
    case 'column':
      return (
        <ColumnDetails
          dataset={selection.dataset}
          column={selection.column}
          onSelectCube={props.onSelectCube}
        />
      );
    case 'dimension':
      return <DimensionDetails {...props} dimension={selection.dimension} />;
    case 'hierarchy':
      return (
        <HierarchyDetails
          dimension={selection.dimension}
          hierarchy={selection.hierarchy}
          onSelectDimension={props.onSelectDimension}
        />
      );
    case 'member':
      return <MemberDetails {...props} selection={selection} />;
  }
}

function EmptyDetails() {
  return (
    <div className="details">
      <h2>Nothing selected</h2>
      <p className="muted">
        Pick a cube for its columns and metadata, or expand <strong>Dimensions</strong> for
        hierarchies and their nested members.
      </p>
      <ul className="tips">
        <li>Each expansion is one engine query — nothing is fetched up front.</li>
        <li>
          Members nest through <code>#Members</code> + <code>#Edges</code>; the number beside a
          member is its rollup weight.
        </li>
        <li>
          System cubes (<code>#Columns</code>, <code>#Cubes</code>, <code>#Dimensions</code>,{' '}
          <code>#Hierarchies</code>, <code>#Members</code>, <code>#Edges</code>) describe the
          database itself.
        </li>
      </ul>
    </div>
  );
}

interface CubeDetailsProps extends DetailsPaneProps {
  dataset: DatasetDescription;
}

function CubeDetails({ dataset, onSelectColumn, onShowPreview }: CubeDetailsProps) {
  return (
    <div className="details">
      <div className="detail-head">
        <h2>{dataset.dataset}</h2>
        <span className={`chip ${dataset.isSystem ? 'chip-system' : 'chip-cube'}`}>
          {dataset.isSystem ? 'system cube' : 'cube'}
        </span>
        {dataset.isAttributeTable && <span className="chip">attribute table</span>}
      </div>

      {dataset.isSystem && (
        <p className="hint">
          One of the engine&apos;s six self-describing system cubes. Read-only; it lists every row
          unless filtered.
        </p>
      )}

      <dl className="meta-grid">
        <div>
          <dt>Rows</dt>
          <dd>{formatCount(dataset.rowCount)}</dd>
        </div>
        <div>
          <dt>Columns</dt>
          <dd>{formatCount(dataset.columns.length)}</dd>
        </div>
        <div>
          <dt>Measure dimension</dt>
          <dd>{dataset.measureDimension ?? '—'}</dd>
        </div>
        <div>
          <dt>Attribute table</dt>
          <dd>{dataset.isAttributeTable ? 'yes' : 'no'}</dd>
        </div>
        <div>
          <dt>Primary key</dt>
          <dd>{formatPrimaryKey(dataset.primaryKey)}</dd>
        </div>
        <div>
          <dt>System</dt>
          <dd>{dataset.isSystem ? 'yes' : 'no'}</dd>
        </div>
      </dl>

      <div className="detail-actions">
        <button type="button" className="btn btn-primary" onClick={onShowPreview}>
          Preview {Math.min(10, dataset.rowCount)} rows →
        </button>
      </div>

      <h3>
        Columns <span className="count">{dataset.columns.length}</span>
      </h3>

      {dataset.columns.length === 0 ? (
        <p className="muted">This cube reports no columns.</p>
      ) : (
        <div className="grid-scroll">
          <table className="grid">
            <thead>
              <tr>
                <th>Column</th>
                <th>Kind</th>
                <th>Type</th>
                <th className="num">Cardinality</th>
                <th>Nullable</th>
                <th>Range</th>
              </tr>
            </thead>
            <tbody>
              {dataset.columns.map((column) => (
                <tr
                  key={column.name}
                  className="grid-row-click"
                  data-column-name={column.name}
                  title="Show this column's details"
                  onClick={() => onSelectColumn(dataset, column)}
                >
                  <td className="cell-name">{column.name}</td>
                  <td>
                    <span
                      className={`chip chip-small ${
                        column.suggestedKind === 'measure' ? 'chip-measure' : 'chip-dimension'
                      }`}
                    >
                      {column.suggestedKind}
                    </span>
                  </td>
                  <td>{formatType(column.dataType, column.logicalType)}</td>
                  <td className="num">{formatCount(column.cardinality)}</td>
                  <td>{column.nullable ? 'yes' : 'no'}</td>
                  <td>{formatRange(column.min, column.max)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

interface ColumnDetailsProps {
  dataset: DatasetDescription;
  column: ColumnDescription;
  onSelectCube: (name: string) => void;
}

function ColumnDetails({ dataset, column, onSelectCube }: ColumnDetailsProps) {
  return (
    <div className="details">
      <nav className="crumb">
        <button type="button" className="link" onClick={() => onSelectCube(dataset.dataset)}>
          ← {dataset.dataset}
        </button>
        <span> / </span>
        <span>{column.name}</span>
      </nav>

      <div className="detail-head">
        <h2>{column.name}</h2>
        <span
          className={`chip ${
            column.suggestedKind === 'measure' ? 'chip-measure' : 'chip-dimension'
          }`}
        >
          {column.suggestedKind}
        </span>
      </div>

      <dl className="meta-grid">
        <div>
          <dt>Data type</dt>
          <dd>{column.dataType}</dd>
        </div>
        <div>
          <dt>Logical type</dt>
          <dd>{column.logicalType}</dd>
        </div>
        <div>
          <dt>Cardinality</dt>
          <dd>{formatCount(column.cardinality)}</dd>
        </div>
        <div>
          <dt>Nullable</dt>
          <dd>{column.nullable ? 'yes' : 'no'}</dd>
        </div>
        <div>
          <dt>Not null</dt>
          <dd>{column.notNull ? 'yes' : 'no'}</dd>
        </div>
        <div>
          <dt>Range</dt>
          <dd>{formatRange(column.min, column.max)}</dd>
        </div>
      </dl>
    </div>
  );
}

function DimensionDetails({
  dimension,
  onSelectHierarchy,
}: DetailsPaneProps & { dimension: DimensionInfo }) {
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'ready'; names: string[] } | { status: 'error'; error: unknown }
  >({ status: 'loading' });

  useEffect(() => {
    let alive = true;
    setState({ status: 'loading' });
    discovery.hierarchies(dimension.name).then(
      (names) => {
        if (alive) setState({ status: 'ready', names });
      },
      (error: unknown) => {
        if (alive) setState({ status: 'error', error });
      },
    );
    return () => {
      alive = false;
    };
  }, [dimension.name]);

  return (
    <div className="details">
      <div className="detail-head">
        <h2>{dimension.name}</h2>
        <span className="chip chip-dimension">dimension</span>
      </div>

      <dl className="meta-grid">
        <div>
          <dt>Hierarchies</dt>
          <dd>
            {state.status === 'ready'
              ? formatCount(state.names.length)
              : formatCount(dimension.hierarchyCount)}
          </dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>
            <code>#Dimensions</code>
          </dd>
        </div>
      </dl>

      <h3>Hierarchies</h3>
      {state.status === 'loading' && <p className="muted">Loading hierarchies…</p>}
      {state.status === 'error' && <ErrorNotice error={state.error} title="Could not load hierarchies" />}
      {state.status === 'ready' && state.names.length === 0 && (
        <p className="muted">This dimension reports no hierarchies.</p>
      )}
      {state.status === 'ready' && state.names.length > 0 && (
        <div className="chip-row">
          {state.names.map((name) => (
            <button
              key={name}
              type="button"
              className="btn btn-chip"
              onClick={() => onSelectHierarchy(dimension.name, name)}
            >
              {name}
            </button>
          ))}
        </div>
      )}

      <p className="hint">
        Members of a hierarchy come from <code>#Members</code>, and their nesting from{' '}
        <code>#Edges</code>. Expand the hierarchy in the tree to see them.
      </p>
    </div>
  );
}

function HierarchyDetails({
  dimension,
  hierarchy,
  onSelectDimension,
}: {
  dimension: string;
  hierarchy: string;
  onSelectDimension: (dimension: DimensionInfo) => void;
}) {
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'ready'; count: number } | { status: 'error'; error: unknown }
  >({ status: 'loading' });

  useEffect(() => {
    let alive = true;
    setState({ status: 'loading' });
    discovery.members(hierarchy).then(
      (names) => {
        if (alive) setState({ status: 'ready', count: names.length });
      },
      (error: unknown) => {
        if (alive) setState({ status: 'error', error });
      },
    );
    return () => {
      alive = false;
    };
  }, [hierarchy]);

  return (
    <div className="details">
      <nav className="crumb">
        <button
          type="button"
          className="link"
          onClick={() => onSelectDimension({ name: dimension, hierarchyCount: 0 })}
        >
          ← {dimension}
        </button>
        <span> / </span>
        <span>{hierarchy}</span>
      </nav>

      <div className="detail-head">
        <h2>{hierarchy}</h2>
        <span className="chip chip-hierarchy">hierarchy</span>
      </div>

      <dl className="meta-grid">
        <div>
          <dt>Dimension</dt>
          <dd>{dimension}</dd>
        </div>
        <div>
          <dt>Members</dt>
          <dd>
            {state.status === 'ready' ? formatCount(state.count) : state.status === 'loading' ? '…' : '—'}
          </dd>
        </div>
      </dl>

      {state.status === 'error' && <ErrorNotice error={state.error} title="Could not load members" />}

      <p className="hint">
        Expand this hierarchy in the tree to load its members and their parent/child structure with
        rollup weights.
      </p>
    </div>
  );
}

function MemberDetails({
  selection,
  onSelectHierarchy,
  onSelectDimension,
}: DetailsPaneProps & { selection: Extract<Selection, { kind: 'member' }> }) {
  const { dimension, hierarchy, path, weight, childCount } = selection;
  const name = path[path.length - 1];

  return (
    <div className="details">
      <nav className="crumb">
        <button
          type="button"
          className="link"
          onClick={() => onSelectDimension({ name: dimension, hierarchyCount: 0 })}
        >
          {dimension}
        </button>
        <span> / </span>
        <button type="button" className="link" onClick={() => onSelectHierarchy(dimension, hierarchy)}>
          {hierarchy}
        </button>
        {path.length > 1 && (
          <>
            <span> / </span>
            <span className="crumb-path">{path.slice(0, -1).join(' › ')}</span>
          </>
        )}
      </nav>

      <div className="detail-head">
        <h2>{name}</h2>
        <span className="chip chip-member">{childCount > 0 ? 'consolidated member' : 'leaf member'}</span>
      </div>

      <dl className="meta-grid">
        <div>
          <dt>Dimension</dt>
          <dd>{dimension}</dd>
        </div>
        <div>
          <dt>Hierarchy</dt>
          <dd>{hierarchy}</dd>
        </div>
        <div>
          <dt>Rollup weight</dt>
          <dd>{formatWeight(weight)}</dd>
        </div>
        <div>
          <dt>Children</dt>
          <dd>{formatCount(childCount)}</dd>
        </div>
        <div className="meta-wide">
          <dt>Path</dt>
          <dd>{path.join(' › ')}</dd>
        </div>
      </dl>

      <p className="hint">
        The weight is the cell value on the <code>#Edges</code> row that leads to this member; it is
        what the engine rolls this member up with.
      </p>
    </div>
  );
}
