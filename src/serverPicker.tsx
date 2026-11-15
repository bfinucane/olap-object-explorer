import { useEffect, useState } from 'react';
import {
  engineBase,
  setEngineOverride,
  storedEngineOverride,
  validateEngineUrl,
} from './api';

interface ServerPickerProps {
  /** Build-time proxy target, shown as the default server. */
  defaultTarget: string;
  /** Database name reported by the connected engine, when available. */
  databaseName?: string;
  /** Called after the target changed; the shell re-reads capabilities/data. */
  onConnect: () => void;
}

/**
 * Small server chooser: the app can talk to the same-origin Vite proxy (the
 * default) or to a CORS-enabled engine URL. The choice is per-tab sessionStorage;
 * `?engine=` still wins for links and is removed when a choice is made here.
 *
 * "Choose database" means choose the **engine server**: an engine serves one
 * database (its name comes from `capabilities.databaseName`), and that database's
 * datasets/cubes are the tree rows. There is no server-side multi-database list.
 */
export function ServerPicker({ defaultTarget, databaseName, onConnect }: ServerPickerProps) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const currentBase = engineBase();
  const displayed = currentBase === '' ? defaultTarget : currentBase;
  const isCustom = currentBase !== '';
  const matchesDefault =
    value.trim() !== '' &&
    value.trim().replace(/\/+$/, '') === defaultTarget.replace(/\/+$/, '');

  useEffect(() => {
    if (open) {
      setValue(storedEngineOverride() ?? '');
      setError(null);
    }
  }, [open]);

  const connect = () => {
    const problem = validateEngineUrl(value);
    if (problem !== null) {
      setError(problem);
      return;
    }
    setEngineOverride(value.trim() === '' ? null : value.trim());
    setOpen(false);
    onConnect();
  };

  const useDefault = () => {
    setEngineOverride(null);
    setOpen(false);
    onConnect();
  };

  return (
    <div className="server-picker">
      <button
        type="button"
        className="engine-target server-button"
        data-testid="server-picker"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={
          isCustom
            ? 'Connected directly to this engine URL (CORS required). Click to choose another server.'
            : `Using the same-origin proxy to ${defaultTarget}. Click to choose another server.`
        }
        onClick={() => setOpen((previous) => !previous)}
      >
        {displayed}
        {databaseName !== undefined && databaseName !== '' && (
          <span className="server-db"> · db {databaseName}</span>
        )}
        <span className="server-caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div
          className="server-popover"
          role="dialog"
          aria-label="Choose engine server"
          data-testid="server-dialog"
          onKeyDown={(event) => {
            if (event.key === 'Escape') setOpen(false);
          }}
        >
          <h3>Engine server</h3>
          <p className="muted">
            One engine serves one database. Its datasets appear in the Explorer tree; connect to a
            different server to switch databases.
          </p>
          <label className="server-field">
            Engine URL
            <input
              type="text"
              data-testid="server-input"
              value={value}
              placeholder={defaultTarget}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setValue(event.target.value)}
            />
          </label>
          {error !== null && (
            <p className="hint server-error" data-testid="server-error">
              {error}
            </p>
          )}
          {matchesDefault && (
            <p className="hint server-proxy-hint" data-testid="server-proxy-hint">
              That is the URL the Vite proxy already targets. Choose <strong>Use proxy default</strong>{' '}
              instead — a direct browser connection bypasses the proxy and needs the engine started
              with CORS (<code>--cors</code>).
            </p>
          )}
          <p className="hint">
            Leave empty for the same-origin proxy (<code>{defaultTarget}</code>). A direct URL must
            be reachable from the browser and started with CORS enabled (the engine's{' '}
            <code>--cors</code> switch); auth-enabled engines show the login form after connecting.
          </p>
          <div className="server-actions">
            <button
              type="button"
              className="btn btn-primary"
              data-testid="server-connect"
              onClick={connect}
            >
              Connect
            </button>
            <button type="button" className="btn" data-testid="server-default" onClick={useDefault}>
              Use proxy default
            </button>
            <button type="button" className="btn" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
