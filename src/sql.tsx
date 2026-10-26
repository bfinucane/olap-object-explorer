import { useState } from 'react';
import { engineApi, errorText } from './api';
import { EngineError } from './api';
import type { SqlResponse } from './types';

const DEFAULT_SQL = 'SELECT Region, Segment, Category, value FROM Sales';

/**
 * SQL console passthrough: `POST /v1/sql` returns a formatted TEXT table, not
 * rows (handoff §3), so the output is rendered in a <pre> exactly as sent.
 *
 * The note about default members is not decoration: the SQL path injects one
 * default member per unnamed dimension, so a query that names no dimensions is
 * a small subset, not the full cube (handoff §5.5). The query API does not do
 * this; that is why the tree uses it instead.
 */
export function SqlConsole() {
  const [sql, setSql] = useState(DEFAULT_SQL);
  const [result, setResult] = useState<SqlResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [running, setRunning] = useState(false);

  const run = async () => {
    if (running) return;
    setRunning(true);
    setError(null);
    try {
      setResult(await engineApi.sql(sql));
    } catch (runError) {
      setResult(null);
      setError(runError);
    } finally {
      setRunning(false);
    }
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

  return (
    <div className="sql">
      <div className="sql-head">
        <h2>SQL console</h2>
        <span className="muted">
          <code>POST /v1/sql</code> — read-only, formatted text output
        </span>
      </div>

      <p className="hint">
        Only <code>SELECT</code> is accepted. Unnamed dimensions default to their first member on
        this path, so name every dimension you care about; system cubes are exempt and read all
        rows. Ctrl+Enter runs.
      </p>

      <textarea
        className="sql-input"
        spellCheck={false}
        value={sql}
        onChange={(event) => setSql(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void run();
          }
        }}
        aria-label="SQL statement"
      />

      <div className="sql-actions">
        <button type="button" className="btn btn-primary" onClick={() => void run()} disabled={running}>
          Run
        </button>
        <button type="button" className="btn" onClick={() => setSql(DEFAULT_SQL)} disabled={running}>
          Reset
        </button>
        <span className={`sql-status${error !== null ? ' is-error' : ''}`}>{status}</span>
      </div>

      {error !== null ? (
        <pre className="sql-output is-error">{errorText(error)}</pre>
      ) : (
        <pre className="sql-output" data-testid="sql-output">
          {result?.output ?? 'Run a query to see the engine output.'}
        </pre>
      )}
    </div>
  );
}
