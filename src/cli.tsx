import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { engineApi, engineBase, errorCode, errorText } from './api';
import {
  addCommand,
  cliHistoryKey,
  loadHistory,
  saveHistory,
} from './cliHistory';
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
  /** Signed-in user, or null for anonymous / token-only sessions. */
  user: string | null;
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

interface CliTemplate {
  id: string;
  label: string;
  detail: string;
  sql: string;
}

/**
 * CREATE skeletons for the admin CLI. The web SQL console (`/v1/sql`) is
 * read-only, so modelling DDL belongs here; the template only fills the command
 * input — the operator renames the example objects and presses Run.
 */
const CREATE_TEMPLATES: CliTemplate[] = [
  {
    id: 'create-table',
    label: 'CREATE TABLE — plain cube',
    detail: 'STRING dimensions; the trailing insert value is the cell',
    sql: 'CREATE TABLE NewCube (Region STRING, Segment STRING, Category STRING)',
  },
  {
    id: 'create-table-measure',
    label: 'CREATE TABLE — measure cube',
    detail: 'adds a MEASURE dimension (members like Sales, Profit)',
    sql: 'CREATE TABLE NewCubeMeasure (Region STRING, Segment STRING, Measure MEASURE)',
  },
  {
    id: 'create-attribute',
    label: 'CREATE ATTRIBUTE TABLE',
    detail: 'key columns + attribute name/value pairs',
    sql: 'CREATE ATTRIBUTE TABLE NewAttributes (Region STRING, Attribute MEASURE)',
  },
  {
    id: 'create-dimension',
    label: 'CREATE DIMENSION',
    detail: 'empty dimension; add members with .import_* or INSERT',
    sql: 'CREATE DIMENSION NewDimension',
  },
  {
    id: 'create-hierarchy',
    label: 'CREATE HIERARCHY',
    detail: 'run after its dimension exists',
    sql: 'CREATE HIERARCHY NewHierarchy IN NewDimension',
  },
];

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

function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
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
export function CliConsole({ supportsCli, roles, anonymous, user }: CliConsoleProps) {
  const [command, setCommand] = useState('');
  const [entries, setEntries] = useState<CliEntry[]>([]);
  // Persistent shell-style history: commands only, server+user scoped.
  const storage = browserStorage();
  const historyStoreKey = cliHistoryKey(engineBase(), user);
  const [history, setHistory] = useState<string[]>(() => loadHistory(storage, historyStoreKey));
  const [activeId, setActiveId] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [saveConfirm, setSaveConfirm] = useState(false);
  const [nextId, setNextId] = useState(1);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
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

  useEffect(() => {
    saveHistory(storage, historyStoreKey, history);
  }, [storage, historyStoreKey, history]);

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
    setTemplateOpen(false);
    setHistory((previous) => addCommand(previous, raw));
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
    if (history.length === 0) return;
    const next = browseIndex === null ? 0 : Math.min(history.length - 1, browseIndex + 1);
    if (browseIndex === null) setDraft(command);
    setBrowseIndex(next);
    setCommand(history[next]);
  };

  const recallNewer = () => {
    if (browseIndex === null) return;
    const next = browseIndex - 1;
    if (next < 0) {
      setBrowseIndex(null);
      setCommand(draft);
    } else {
      setBrowseIndex(next);
      setCommand(history[next]);
    }
  };

  const chooseHistory = (recalled: string) => {
    setCommand(recalled);
    setBrowseIndex(null);
    setHistoryOpen(false);
    setTemplateOpen(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const insertTemplate = (template: CliTemplate) => {
    setCommand(template.sql);
    setBrowseIndex(null);
    setDraft('');
    setFormError(null);
    setTemplateOpen(false);
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
    } else if (event.key === 'Escape') {      setHistoryOpen(false);
      setTemplateOpen(false);
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
            <div className="cli-template-wrap">
              <button
                type="button"
                className="btn"
                data-testid="cli-template-button"
                aria-haspopup="menu"
                aria-expanded={templateOpen}
                title="Insert a CREATE skeleton into the command line"
                disabled={running}
                onClick={() => {
                  setTemplateOpen((open) => !open);
                  setHistoryOpen(false);
                }}
              >
                Templates ▾
              </button>
              {templateOpen && (
                <div
                  className="cli-history-menu cli-template-menu"
                  role="menu"
                  data-testid="cli-template-menu"
                >
                  <p className="cli-template-heading">
                    CREATE templates — inserted into the command line; rename, then Run
                  </p>
                  {CREATE_TEMPLATES.map((template) => (
                    <button
                      key={template.id}
                      type="button"
                      role="menuitem"
                      className="cli-history-item"
                      data-testid={`cli-template-${template.id}`}
                      title={template.sql}
                      onClick={() => insertTemplate(template)}
                    >
                      <span className="cli-history-command">{template.label}</span>
                      <span className="cli-history-meta">{template.detail}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="cli-history-button-wrap">
              <button
                type="button"
                className="btn"
                data-testid="cli-history-button"
                aria-haspopup="menu"
                aria-expanded={historyOpen}
                title="Recent commands, remembered per server and user (↑/↓ recalls them)"
                disabled={history.length === 0}
                onClick={() => {
                  setHistoryOpen((open) => !open);
                  setTemplateOpen(false);
                }}
              >
                History ▾
              </button>
              {historyOpen && history.length > 0 && (
                <div className="cli-history-menu" role="menu" data-testid="cli-history-menu">
                  {history.map((recalled, index) => (
                    <button
                      key={`${index}-${recalled}`}
                      type="button"
                      role="menuitem"
                      data-testid="cli-history-item"
                      className="cli-history-item"
                      title={recalled}
                      onClick={() => chooseHistory(recalled)}
                    >
                      <span className="cli-history-command">{recalled}</span>
                      <span className="cli-history-meta">recall</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              type="button"
              className="btn"
              data-testid="cli-clear"
              disabled={running || (entries.length === 0 && history.length === 0)}
              onClick={() => {
                setEntries([]);
                setHistory([]);
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
