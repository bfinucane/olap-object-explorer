import { useCallback, useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { EngineError, engineApi, errorText } from './api';
import { discovery } from './discovery';
import { insertName, readNameDrag } from './drag';
import { buildRowSample, buildTemplates, type SqlTemplate } from './sqlTemplates';
import { parseSqlTable } from './sqlTable';
import type { DatasetDescription, SqlResponse } from './types';

interface SqlConsoleProps {
  datasets: string[];
  /**
   * The cube the console should target: the cube/column currently selected in
   * the tree, or the last explicitly selected cube while a global
   * dimension/hierarchy/member is selected. Null only before any cube selection.
   */
  selectedCube: string | null;
  /** A dimension name implied by the selection, for the "By <dimension>" template. */
  selectedDimension: string | null;
}

type DescribeState =
  | { status: 'loading' }
  | { status: 'ready'; description: DatasetDescription }
  | { status: 'error'; error: unknown };

function pickDefaultCube(datasets: string[]): string {
  return datasets.find((name) => !name.startsWith('#')) ?? datasets[0] ?? '';
}

/**
 * SQL console passthrough: `POST /v1/sql` returns a formatted TEXT table, not
 * rows (PROTOCOL §0.5). The text is parsed into a real HTML table for display;
 * the raw engine text remains available with the "Raw text" toggle and is the
 * fallback whenever the format does not parse unambiguously.
 *
 * The contract (PROTOCOL §0.5) classes this as engine tooling (tier T3), not a
 * client data path: clients MUST NOT depend on it. Known engine gaps remain
 * (§11.6 GROUP BY/HAVING parsed but ignored; §11.7 COUNT over text; §11.8
 * no-measure duplication), so the console states them in the UI instead of
 * letting a user trust a silent wrong answer.
 *
 * Default-member semantics changed in engine `0e4214d` (contract D22): an omitted
 * dimension is NO LONGER pinned to its first member — it aggregates across all
 * base members unless the model defines an explicit default. The hint below and
 * the templates follow the current contract, not the older first-member wording.
 *
 * The starter statement is generated from `describe`, so it follows the model
 * (Orders today) and the tree selection: selecting a cube/column re-targets the
 * console, and a pristine editor is regenerated automatically.
 */
export function SqlConsole({ datasets, selectedCube, selectedDimension }: SqlConsoleProps) {
  const [cube, setCube] = useState<string>(() => selectedCube ?? pickDefaultCube(datasets));
  const [description, setDescription] = useState<DescribeState>({ status: 'loading' });
  const [sql, setSql] = useState('');
  const [result, setResult] = useState<SqlResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [running, setRunning] = useState(false);
  const [templateMenuOpen, setTemplateMenuOpen] = useState(false);
  const [pendingCube, setPendingCube] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  const appliedSql = useRef('');
  const lastSelectedCube = useRef<string | null>(selectedCube);
  const textarea = useRef<HTMLTextAreaElement | null>(null);

  const applySql = useCallback((next: string) => {
    appliedSql.current = next;
    setSql(next);
    setPendingCube(null);
  }, []);

  // Datasets arrive after the first render; if nothing is usable yet, fall back
  // to the engine's first user cube (then any cube, including system cubes).
  useEffect(() => {
    if (cube === '' && datasets.length > 0) {
      setCube(selectedCube ?? pickDefaultCube(datasets));
    } else if (cube !== '' && datasets.length > 0 && !datasets.includes(cube)) {
      setCube(selectedCube ?? pickDefaultCube(datasets));
    }
  }, [datasets, cube, selectedCube]);

  // Follow the tree selection: a cube/column row re-targets the console. A
  // changed prop wins over a manual dropdown choice; selecting a global
  // dimension/member (prop null) keeps the current cube.
  useEffect(() => {
    if (selectedCube === null) return;
    if (selectedCube === lastSelectedCube.current) return;
    lastSelectedCube.current = selectedCube;
    setCube(selectedCube);
  }, [selectedCube]);

  // Load the description of the current cube (discovery memoises it).
  useEffect(() => {
    if (cube === '') return;
    let active = true;
    setDescription({ status: 'loading' });
    discovery
      .describe(cube)
      .then((next) => {
        if (active) setDescription({ status: 'ready', description: next });
      })
      .catch((loadError) => {
        if (active) setDescription({ status: 'error', error: loadError });
      });
    return () => {
      active = false;
    };
  }, [cube]);

  // Regenerate a pristine editor when the cube's description becomes available
  // (initial open, selection change, dropdown change). A user's edit is never
  // overwritten; the stale note offers the regeneration instead.
  useEffect(() => {
    if (description.status !== 'ready') return;
    const next = buildRowSample(description.description);
    if (sql.trim() === '' || sql === appliedSql.current) {
      applySql(next);
    } else {
      setPendingCube(description.description.dataset);
    }
    // `sql` is read as the value at the moment the cube finishes loading; adding
    // it to the dependencies would re-run the effect on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [description, applySql]);

  const run = async () => {
    if (running) return;
    setRunning(true);
    setError(null);
    setShowRaw(false);
    try {
      setResult(await engineApi.sql(sql));
    } catch (runError) {
      setResult(null);
      setError(runError);
    } finally {
      setRunning(false);
    }
  };

  const applyTemplate = (template: SqlTemplate) => {
    applySql(template.sql);
    setTemplateMenuOpen(false);
  };

  const regenerate = () => {
    if (description.status === 'ready') applySql(buildRowSample(description.description));
  };

  const insertDrop = (event: DragEvent<HTMLTextAreaElement>) => {
    const name = readNameDrag(event);
    setDragOver(false);
    if (name === '') return;
    event.preventDefault();
    const element = event.currentTarget;
    const start = element.selectionStart ?? sql.length;
    const end = element.selectionEnd ?? start;
    const next = insertName(sql, start, end, name);
    setSql(next.text);
    // Restore the caret after React writes the new value.
    requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  const status = (() => {
    if (running) return 'running…';
    if (error !== null) {
      const code = error instanceof EngineError ? error.code : 'error';
      return `failed · ${code}`;
    }
    if (result !== null) return `${result.elapsedMs} ms`;
    return 'idle';
  })();

  const templates =
    description.status === 'ready' ? buildTemplates(description.description, selectedDimension) : null;
  const canRun = cube !== '' && description.status === 'ready';
  const parsed = result === null ? null : parseSqlTable(result.output);
  const dimensionSelectionUsable =
    description.status === 'ready' &&
    selectedDimension !== null &&
    description.description.columns.some(
      (column) => column.suggestedKind === 'dimension' && column.name === selectedDimension,
    );

  return (
    <div className="sql">
      <div className="sql-head">
        <h2>SQL console</h2>
        <span className="muted">
          <code>POST /v1/sql</code> — read-only, formatted text output
        </span>
      </div>

      <div className="sql-toolbar">
        <label className="sql-cube-label">
          Cube
          <select
            className="sql-cube"
            data-testid="sql-cube"
            value={cube}
            aria-label="SQL console cube"
            disabled={datasets.length === 0}
            onChange={(event) => setCube(event.target.value)}
          >
            {datasets.length === 0 && <option value="">(no cubes)</option>}
            {datasets.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>

        <div className="sql-template-wrap">
          <button
            type="button"
            className="btn sql-template-button"
            data-testid="sql-template-menu"
            aria-haspopup="menu"
            aria-expanded={templateMenuOpen}
            disabled={templates === null}
            onClick={() => setTemplateMenuOpen((open) => !open)}
          >
            Templates ▾
          </button>
          {templateMenuOpen && templates !== null && (
            <div className="sql-template-menu" role="menu" data-testid="sql-template-list">
              <button
                type="button"
                role="menuitem"
                data-testid="sql-template-rows"
                onClick={() => applyTemplate(templates.templates.find((t) => t.id === 'rows')!)}
              >
                Row sample <span className="muted">every dimension + value</span>
              </button>
              <button
                type="button"
                role="menuitem"
                data-testid="sql-template-by-dimension"
                disabled={!dimensionSelectionUsable}
                title={
                  dimensionSelectionUsable
                    ? `Group by ${selectedDimension}`
                    : 'Select a dimension column in the tree first'
                }
                onClick={() => {
                  const template = templates.templates.find((t) => t.id === 'by-dimension');
                  if (template) applyTemplate(template);
                }}
              >
                By {selectedDimension ?? 'selected dimension'}{' '}
                <span className="muted">every measure</span>
              </button>
              <button
                type="button"
                role="menuitem"
                data-testid="sql-template-totals"
                onClick={() => applyTemplate(templates.templates.find((t) => t.id === 'totals')!)}
              >
                Totals <span className="muted">every measure, whole cube</span>
              </button>
            </div>
          )}
        </div>

        <span className="sql-context-note">
          {description.status === 'loading'
            ? `loading ${cube}…`
            : description.status === 'error'
              ? `could not describe ${cube}`
              : `follows the tree selection · ${description.description.columns.length} columns`}
        </span>
      </div>

      <p className="hint">
        Only <code>SELECT</code> is accepted. A dimension you omit aggregates across{' '}
        <strong>all of its members</strong> — there is no implicit default member (contract D22);
        an explicit model default, if one is set, would restrict it. System cubes always read all
        rows. Ctrl+Enter runs.
      </p>

      <p className="hint" data-testid="sql-gaps">
        <strong>Known engine gaps on this tooling path</strong> (contract §11.6/§11.7/§11.8):{' '}
        <code>GROUP BY</code>/<code>HAVING</code>/<code>DISTINCT</code> are parsed but ignored —
        project the dimensions explicitly; <code>COUNT</code> over a text column returns the last
        text, not a cell count — use <code>COUNTD</code> for text; and a projection with no measure
        repeats each group once per measure member — keep <code>value</code> or a measure in the
        list. This surface is not a client data path (contract §0.5); the tree and details pane
        use the query API.
      </p>

      {pendingCube !== null && (
        <div className="sql-stale" data-testid="sql-stale">
          <span>
            The tree selection is now <strong>{cube}</strong>; your edited statement was kept.
          </span>
          <button type="button" className="btn" onClick={regenerate}>
            Regenerate for {cube}
          </button>
        </div>
      )}

      {description.status === 'error' && (
        <p className="hint sql-describe-error" data-testid="sql-describe-error">
          {errorText(description.error)}
        </p>
      )}

      <textarea
        ref={textarea}
        className={`sql-input${dragOver ? ' is-drop-target' : ''}`}
        spellCheck={false}
        value={sql}
        placeholder={
          description.status === 'ready'
            ? 'SELECT … FROM …   (or drag a name from the tree)'
            : 'Select a cube first'
        }
        data-testid="sql-input"
        aria-label="SQL statement"
        onChange={(event) => setSql(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void run();
          }
        }}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('text/plain')) {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
            setDragOver(true);
          }
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={insertDrop}
      />

      <div className="sql-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void run()}
          disabled={running || !canRun}
        >
          Run
        </button>
        <button
          type="button"
          className="btn"
          data-testid="sql-reset"
          onClick={regenerate}
          disabled={running || description.status !== 'ready'}
        >
          Reset
        </button>
        <span className={`sql-status${error !== null ? ' is-error' : ''}`}>{status}</span>
        <span className="muted sql-drag-note">drag names from the tree into the statement</span>
      </div>

      {error !== null ? (
        <pre className="sql-output is-error">{errorText(error)}</pre>
      ) : (
        <div className="sql-result" data-testid="sql-output">
          {result === null ? (
            <p className="sql-placeholder">Run a query to see the engine output.</p>
          ) : parsed === null ? (
            <pre className="sql-raw">{result.output}</pre>
          ) : (
            <>
              <div className="sql-result-meta">
                <span>
                  {parsed.rows.length} {parsed.rows.length === 1 ? 'row' : 'rows'} ×{' '}
                  {parsed.columns.length} {parsed.columns.length === 1 ? 'column' : 'columns'}
                </span>
                <button
                  type="button"
                  className="linkish"
                  data-testid="sql-raw-toggle"
                  onClick={() => setShowRaw((raw) => !raw)}
                >
                  {showRaw ? 'Show table' : 'Raw text'}
                </button>
              </div>
              {showRaw ? (
                <pre className="sql-raw">{result.output}</pre>
              ) : (
                <div className="grid-scroll sql-table-scroll">
                  <table className="grid sql-table" data-testid="sql-table">
                    <thead>
                      <tr>
                        {parsed.columns.map((column, index) => (
                          <th key={`${column}-${index}`}>{column}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {parsed.rows.map((row, rowIndex) => (
                        <tr key={rowIndex}>
                          {row.map((cell, cellIndex) => (
                            <td
                              key={cellIndex}
                              className={/^-?\d+(\.\d+)?$/.test(cell.trim()) ? 'num' : undefined}
                            >
                              {cell}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
