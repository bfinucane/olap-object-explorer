import { useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { engineApi, errorCode, errorText } from './api';
import type { CliResponse } from './types';

interface CliConsoleProps {
  /**
   * `capabilities.supportsCli` — the tab is only mounted when this is true, but
   * keep the prop so the component cannot be used accidentally without the gate.
   */
  supportsCli: boolean;
  /**
   * Roles from the login response, or null when no session exists (anonymous
   * development engine, or a token seeded via `?token=`). A known role list
   * without `admin` is gated here; the server still enforces 403.
   */
  roles: string[] | null;
  /** True when the engine reports authRequired: false (development mode). */
  anonymous: boolean;
}

interface CliEntry {
  id: number;
  command: string;
  /** Command completed (ok true/false) vs a transport/HTTP failure. */
  kind: 'command' | 'http';
  ok: boolean;
  output: string;
  truncated: boolean;
  at: string;
}

const MAX_COMMAND_BYTES = 8192;
const HISTORY_LIMIT = 30;

function byteLength(text: string): number {
  if (typeof TextEncoder === 'undefined') return text.length;
  return new TextEncoder().encode(text).length;
}

function validateCommand(command: string): string | null {
  if (command.trim() === '') return 'Enter a CLI command.';
  if (/[\r\n]/.test(command)) return 'One command per request: no line breaks.';
  if (byteLength(command) > MAX_COMMAND_BYTES) return `Command exceeds ${MAX_COMMAND_BYTES} bytes.`;
  return null;
}

function rolesIncludeAdmin(roles: string[]): boolean {
  return roles.some((role) => role.toLowerCase() === 'admin');
}

function nowLabel(): string {
  return new Date().toLocaleTimeString();
}

/**
 * Admin modelling console for the engine's CLI bridge (`POST /v1/cli`).
 *
 * Contract: PROTOCOL §0.6 + DECISIONS D28 — **engine tooling, not a client data
 * path and not a conformance tier**. The tab is gated on
 * `capabilities.supportsCli` and the route is admin-only; this UI adds a role
 * check for a known non-admin session, but the server remains the authority
 * (403).
 *
 * Imports read **server-side paths**: there is no engine upload route, and this
 * client deliberately does not pretend to have one. Put the file where the
 * engine process can read it (on the shared instance, the operator owns that
 * directory) and pass the path to `.import…`.
 *
 * `.save` writes the **running** database copy, not the frozen release pair;
 * the button therefore says so explicitly and requires a second click.
 */
export function CliConsole({ supportsCli, roles, anonymous }: CliConsoleProps) {
  const [command, setCommand] = useState('');
  const [entries, setEntries] = useState<CliEntry[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [saveConfirm, setSaveConfirm] = useState(false);
  const [nextId, setNextId] = useState(1);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Shell-style recall: null = editing a new line; otherwise an index into
  // `entries` (newest first), with the in-progress line kept in `draft`.
  const [browseIndex, setBrowseIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  const knownAdmin = roles === null ? null : rolesIncludeAdmin(roles);
  const canRun = knownAdmin !== false;
  const active = useMemo(
    () => entries.find((entry) => entry.id === activeId) ?? entries[0] ?? null,
    [entries, activeId],
  );

  if (!supportsCli) {
    return (
      <div className="cli" data-testid="cli-console">
        <p className="hint" data-testid="cli-unavailable">
          This engine does not advertise <code>supportsCli</code>; the modelling console is
          unavailable. The rest of the explorer is unchanged.
        </p>
      </div>
    );
  }

  const execute = async (raw: string) => {
    if (running) return;
    const problem = validateCommand(raw);
    if (problem !== null) {
      setFormError(problem);
      return;
    }
    setFormError(null);
    setSaveConfirm(false);
    setRunning(true);
    setBrowseIndex(null);
    setDraft('');
    const id = nextId;
    setNextId(id + 1);
    try {
      const response: CliResponse = await engineApi.cli(raw);
      const entry: CliEntry = {
        id,
        command: raw,
        kind: 'command',
        ok: response.ok,
        output: response.output,
        truncated: response.truncated,
        at: nowLabel(),
      };
      setEntries((previous) => [entry, ...previous].slice(0, HISTORY_LIMIT));
      setActiveId(id);
      setCommand('');
    } catch (error) {
      const detail = errorText(error);
      const code = errorCode(error);
      const suffix = code === null ? '' : ` [${code}]`;
      const entry: CliEntry = {
        id,
        command: raw,
        kind: 'http',
        ok: false,
        output: `${detail}${suffix}`,
        truncated: false,
        at: nowLabel(),
      };
      setEntries((previous) => [entry, ...previous].slice(0, HISTORY_LIMIT));
      setActiveId(id);
    } finally {
      setRunning(false);
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canRun) return;
    void execute(command);
  };

  const confirmSave = () => {
    setSaveConfirm(false);
    void execute('.save');
  };

  const recallOlder = () => {
    if (entries.length === 0) return;
    const next = browseIndex === null ? 0 : Math.min(entries.length - 1, browseIndex + 1);
    if (browseIndex === null) setDraft(command);
    setBrowseIndex(next);
    setCommand(entries[next].command);
  };

  const recallNewer = () => {
    if (browseIndex === null) return;
    const next = browseIndex - 1;
    if (next < 0) {
      setBrowseIndex(null);
      setCommand(draft);
    } else {
      setBrowseIndex(next);
      setCommand(entries[next].command);
    }
  };

  const chooseHistory = (entry: CliEntry) => {
    setCommand(entry.command);
    setActiveId(entry.id);
    setBrowseIndex(null);
    setHistoryOpen(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowUp') {
      if (entries.length > 0) {
        event.preventDefault();
        recallOlder();
      }
    } else if (event.key === 'ArrowDown') {
      if (browseIndex !== null) {
        event.preventDefault();
        recallNewer();
      }
    } else if (event.key === 'Escape') {
      setHistoryOpen(false);
    }
  };

  return (
    <div className="cli" data-testid="cli-console">
      <div className="cli-head">
        <h2>Modelling console</h2>
        <span className="chip chip-small" data-testid="cli-experimental">
          experimental engine tooling
        </span>
        <span className="muted">
          <code>POST /v1/cli</code> · admin only · one command per request · not a conformance tier
          (PROTOCOL §0.6, D28)
        </span>
      </div>

      <p className="hint">
        This is the engine's own CLI over HTTP, not a client data path: commands can model, import
        and <code>.save</code>. <code>.exit</code>/<code>.quit</code> are no-ops — the server stays
        up. Imports read <strong>server-side paths</strong>; this app has no upload route, so place
        the file where the engine can read it and pass that path to <code>.import…</code>.
      </p>

      {anonymous && (
        <p className="hint" data-testid="cli-anonymous-note">
          This engine reports <code>authRequired: false</code> (development mode); the server
          treats the anonymous caller as admin for the CLI.
        </p>
      )}

      {knownAdmin === false ? (
        <div className="cli-gate" data-testid="cli-gate">
          <strong>Admin role required.</strong> The signed-in account has no <code>admin</code>{' '}
          role, so <code>POST /v1/cli</code> would answer 403. Sign out and sign in with an admin
          account.
        </div>
      ) : (
        <>
          <form className="cli-form" onSubmit={submit}>
            <input
              ref={inputRef}
              type="text"
              className="cli-input"
              data-testid="cli-input"
              aria-label="CLI command"
              placeholder='.help, .cubes, .schema Orders, .import_measures C:\path\file.csv Cube Sales'
              spellCheck={false}
              autoComplete="off"
              value={command}
              onChange={(event) => {
                setCommand(event.target.value);
                if (browseIndex !== null) setBrowseIndex(null);
              }}
              onKeyDown={onInputKeyDown}
            />
            <button
              type="submit"
              className="btn btn-primary"
              data-testid="cli-run"
              disabled={running}
            >
              Run
            </button>
            <div className="cli-history-button-wrap">
              <button
                type="button"
                className="btn"
                data-testid="cli-history-button"
                aria-haspopup="menu"
                aria-expanded={historyOpen}
                title="Recent commands (↑/↓ in the input recalls them)"
                disabled={entries.length === 0}
                onClick={() => setHistoryOpen((open) => !open)}
              >
                History ▾
              </button>
              {historyOpen && entries.length > 0 && (
                <div className="cli-history-menu" role="menu" data-testid="cli-history-menu">
                  {entries.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      role="menuitem"
                      data-testid="cli-history-item"
                      className={`cli-history-item${entry.ok ? '' : ' is-error'}`}
                      title={entry.command}
                      onClick={() => chooseHistory(entry)}
                    >
                      <span className="cli-history-command">{entry.command}</span>
                      <span className="cli-history-meta">
                        {entry.kind === 'http' ? 'http' : entry.ok ? 'ok' : 'failed'}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              type="button"
              className="btn"
              data-testid="cli-clear"
              disabled={running || entries.length === 0}
              onClick={() => {
                setEntries([]);
                setActiveId(null);
                setFormError(null);
                setBrowseIndex(null);
                setHistoryOpen(false);
              }}
            >
              Clear history
            </button>
          </form>

          {formError !== null && (
            <p className="hint cli-form-error" data-testid="cli-form-error">
              {formError}
            </p>
          )}

          <div className="cli-save">
            <button
              type="button"
              className="btn"
              data-testid="cli-save"
              disabled={running}
              onClick={() => setSaveConfirm(true)}
            >
              Save database…
            </button>
            <span className="cli-save-warning" data-testid="cli-save-warning">
              <code>.save</code> writes the server's <strong>running</strong> database copy — on the
              shared instance that is not the frozen release; a restart or <code>-Fresh</code>{' '}
              start replaces it.
            </span>
          </div>

          {saveConfirm && (
            <div className="cli-confirm" data-testid="cli-save-confirm">
              <span>
                Confirm <code>.save</code> on the running copy? Modeling changes become durable
                only in that copy.
              </span>
              <button type="button" className="btn btn-primary" onClick={confirmSave}>
                Save running copy
              </button>
              <button type="button" className="btn" onClick={() => setSaveConfirm(false)}>
                Cancel
              </button>
            </div>
          )}

          <div className="cli-status-row">
            <span
              className={`cli-status${
                active === null ? '' : active.ok ? ' is-ok' : ' is-error'
              }`}
              data-testid="cli-status"
            >
              {running
                ? 'running…'
                : active === null
                  ? 'idle'
                  : active.kind === 'http'
                    ? 'request failed'
                    : active.ok
                      ? 'ok'
                      : 'command failed'}
            </span>
            {active?.truncated === true && (
              <span className="chip chip-small" data-testid="cli-truncated">
                output truncated at 65536 bytes
              </span>
            )}
            {active !== null && <span className="muted">{active.at}</span>}
          </div>

          <pre
            className={`cli-output${active !== null && !active.ok ? ' is-error' : ''}`}
            data-testid="cli-output"
          >
            {active === null
              ? 'Run a CLI command to see the engine output.'
              : active.output}
          </pre>

          <div className="cli-history-wrap">
            <h3>
              Session log <span className="count">{entries.length}</span>
            </h3>
            {entries.length === 0 ? (
              <p className="muted">No commands yet in this session.</p>
            ) : (
              <ul className="cli-history" data-testid="cli-history">
                {entries.map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      className={`cli-history-item${entry.ok ? '' : ' is-error'}${
                        active?.id === entry.id ? ' is-active' : ''
                      }`}
                      title="Load this command into the input"
                      onClick={() => {
                        setCommand(entry.command);
                        setActiveId(entry.id);
                      }}
                    >
                      <span className="cli-history-command">{entry.command}</span>
                      <span className="cli-history-meta">
                        {entry.kind === 'http' ? 'http' : entry.ok ? 'ok' : 'failed'}
                        {entry.truncated ? ' · truncated' : ''}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
