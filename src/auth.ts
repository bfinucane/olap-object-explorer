/**
 * Session state for engines that enforce authentication.
 *
 * The engine (since the S1 security work, `Patricia/olap_engine` HEAD afc235c)
 * requires `Authorization: Bearer <token>` on every /v1 route except
 * `POST /v1/login` and `GET /v1/capabilities`. `capabilities.authRequired`
 * tells a client whether a login screen is needed at all; development mode
 * (`--allow-anonymous`) reports `false` and serves without a token.
 *
 * The token lives in memory plus `sessionStorage` (per tab, cleared when the tab
 * closes — an object browser has no business persisting credentials to disk).
 * Engine sessions are in-memory and last 12 hours, so a restart invalidates
 * every token; the app handles that as "session expired" and shows the login
 * form again rather than silently failing requests.
 *
 * `?token=<token>` is still accepted for scripted access; it is moved into
 * sessionStorage and removed from the address bar on load.
 */

export interface SessionInfo {
  user: string;
  roles: string[];
  /** Unix seconds, as returned by POST /v1/login. */
  expiresAt: number;
}

export type UnauthorizedReason = 'required' | 'expired';

const TOKEN_KEY = 'olap-object-explorer.token';
const SESSION_KEY = 'olap-object-explorer.session';

let token: string | null = null;
let session: SessionInfo | null = null;
let unauthorizedHandler: ((reason: UnauthorizedReason) => void) | null = null;
const listeners = new Set<() => void>();

function storage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    // Storage can be unavailable (privacy modes); in-memory state still works.
    return null;
  }
}

function persist(): void {
  const store = storage();
  if (store === null) return;
  try {
    if (token === null) {
      store.removeItem(TOKEN_KEY);
      store.removeItem(SESSION_KEY);
      return;
    }
    store.setItem(TOKEN_KEY, token);
    if (session === null) store.removeItem(SESSION_KEY);
    else store.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    /* quota/privacy failure: keep the in-memory session */
  }
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** Load a token persisted by an earlier page load in this tab. */
export function restoreSession(): void {
  const store = storage();
  if (store === null) return;
  try {
    const storedToken = store.getItem(TOKEN_KEY);
    if (storedToken === null || storedToken === '') return;
    const rawSession = store.getItem(SESSION_KEY);
    const storedSession = rawSession === null ? null : (JSON.parse(rawSession) as SessionInfo);
    if (storedSession !== null && storedSession.expiresAt * 1000 < Date.now()) {
      // Locally expired: don't bother the engine with a dead token.
      token = null;
      session = null;
      persist();
      return;
    }
    token = storedToken;
    session = storedSession;
  } catch {
    token = null;
    session = null;
  }
}

/**
 * Seed the token from `?token=` and strip it from the address bar, so it does
 * not linger in history, screenshots or a shared URL.
 */
export function seedTokenFromUrl(): boolean {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get('token');
  if (fromUrl === null || fromUrl === '') return false;

  token = fromUrl;
  persist();
  notify();

  params.delete('token');
  const query = params.toString();
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${query === '' ? '' : `?${query}`}${window.location.hash}`,
  );
  return true;
}

export function getToken(): string | null {
  return token;
}

export function getSession(): SessionInfo | null {
  return session;
}

export function hasToken(): boolean {
  return token !== null;
}

/** Called after POST /v1/login succeeds. */
export function setAuth(nextToken: string, nextSession: SessionInfo | null): void {
  token = nextToken;
  session = nextSession;
  persist();
  notify();
}

/** Local logout: no server endpoint exists; the engine token expires on its own. */
export function clearAuth(): void {
  if (token === null && session === null) return;
  token = null;
  session = null;
  persist();
  notify();
}

export function onAuthChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Registered by the app shell to switch to the login screen on a 401. */
export function setUnauthorizedHandler(handler: ((reason: UnauthorizedReason) => void) | null): void {
  unauthorizedHandler = handler;
}

/**
 * A request came back 401. `expired` means we had a token (session died under
 * us — engine restart or 12h expiry); `required` means we never had one.
 */
export function signalUnauthorized(): void {
  const reason: UnauthorizedReason = token !== null ? 'expired' : 'required';
  token = null;
  session = null;
  persist();
  notify();
  unauthorizedHandler?.(reason);
}
