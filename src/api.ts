/**
 * Thin, typed client for the engine's read-only HTTP API.
 *
 * Contract: suite contract **v1** (== `protocolVersion 1`), normative text
 * `contract/PROTOCOL.md` in the engine workspace (not vendored here). Two facts
 * drive the transport design:
 *
 * 1. `#` in a dataset name is a URL fragment and never reaches the server, so
 *    every dataset path segment is percent-encoded (`#Members` -> `%23Members`,
 *    PROTOCOL §0.2).
 * 2. Engine CORS is off by default (PROTOCOL §0.4), so in the browser the base
 *    URL is empty and requests go through the Vite proxy on the same origin. A
 *    `?engine=<url>` query parameter is supported for talking to a CORS-enabled
 *    engine directly, which is useful when this app is served some other way.
 *
 * `engineBase()` is deliberately lazy (never runs at module load) so that the
 * data layer can also be bundled and exercised from Node by tools/verify.mjs.
 */

import type {
  Capabilities,
  CliResponse,
  DatasetDescription,
  DatasetsResponse,
  LoginResponse,
  QueryRequest,
  QueryResponse,
  SampleResponse,
  SqlResponse,
} from './types';
import { getToken, signalUnauthorized } from './auth';

/**
 * The contract version this client implements. Suite contract v1 == protocol
 * version 1 (PROTOCOL §0.3). `capabilities.protocolVersion` is validated against
 * this before any data request; a mismatch blocks the shell rather than sending
 * requests a v2 engine might interpret differently.
 */
export const SUPPORTED_PROTOCOL_VERSION = 1;

export function isSupportedProtocolVersion(reported: number): boolean {
  return reported === SUPPORTED_PROTOCOL_VERSION;
}

export class EngineError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'EngineError';
    this.status = status;
    this.code = code;
  }
}

/** True for the engine's single 401 shape (`{"code":"unauthorized"}`). */
export function isUnauthorized(error: unknown): boolean {
  return error instanceof EngineError && (error.status === 401 || error.code === 'unauthorized');
}

function nodeEnv(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.[name];
}

function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

/**
 * The bearer token to send, if any.
 *
 * In the browser this is the session token (login form or `?token=`), held by
 * src/auth.ts. In Node (verification tools) `OLAP_TOKEN` is honoured so a script
 * can act as a logged-in client without the UI.
 */
export function authToken(): string | null {
  const sessionToken = getToken();
  if (sessionToken !== null) return sessionToken;
  if (isBrowser()) return null;
  const env = nodeEnv('OLAP_TOKEN');
  return env === undefined || env === '' ? null : env;
}

/** Empty string means "same origin" (the Vite dev/preview proxy). */
const ENGINE_OVERRIDE_KEY = 'olap-object-explorer.engine';

function browserStorage(): Storage | null {
  if (!isBrowser()) return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** The URL chosen in the UI (sessionStorage), or null when the proxy is used. */
export function storedEngineOverride(): string | null {
  const storage = browserStorage();
  if (storage === null) return null;
  try {
    const raw = storage.getItem(ENGINE_OVERRIDE_KEY);
    return raw === null || raw === '' ? null : raw;
  } catch {
    return null;
  }
}

export function engineBase(): string {
  if (isBrowser()) {
    const configured = new URLSearchParams(window.location.search).get('engine');
    if (configured !== null && configured.trim() !== '') return configured.replace(/\/+$/, '');
    return storedEngineOverride() ?? '';
  }
  // Node (verification tools): talk to the engine directly, no proxy needed.
  return (nodeEnv('OLAP_ENGINE_URL') ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');
}

/**
 * Pick an engine server in the UI. `null` clears the override and returns to the
 * same-origin Vite proxy (the default `8080` target baked at build time). The
 * `?engine=` query parameter is removed so the stored choice is not shadowed by
 * an older link. Direct URLs must be CORS-enabled engines.
 */
export function setEngineOverride(url: string | null): void {
  const storage = browserStorage();
  const normalized = url === null ? null : url.trim().replace(/\/+$/, '');
  if (storage !== null) {
    try {
      if (normalized === null || normalized === '') storage.removeItem(ENGINE_OVERRIDE_KEY);
      else storage.setItem(ENGINE_OVERRIDE_KEY, normalized);
    } catch {
      /* storage unavailable: the address-bar override still works */
    }
  }
  if (isBrowser()) {
    const params = new URLSearchParams(window.location.search);
    if (params.has('engine')) {
      params.delete('engine');
      const query = params.toString();
      window.history.replaceState(
        null,
        '',
        `${window.location.pathname}${query === '' ? '' : `?${query}`}${window.location.hash}`,
      );
    }
  }
}

/** Validate a server URL typed in the UI; returns an error message or null. */
export function validateEngineUrl(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return 'Enter a full URL, e.g. http://127.0.0.1:8199';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'Only http:// and https:// URLs are supported.';
  }
  return null;
}

/** Human-readable engine location for the header and error messages. */
export function engineLabel(): string {
  if (isBrowser()) {
    const base = engineBase();
    if (base !== '') return base;
    return `${window.location.origin} (proxied)`;
  }
  return engineBase();
}

/** `/v1/Sales` or `/v1/%23Members` — the `#` must always be encoded. */
export function datasetPath(dataset: string): string {
  return `/v1/${encodeURIComponent(dataset)}`;
}

/** Where the proxy sends `/v1`, for display. Injected by vite.config.ts. */
export function engineTarget(): string {
  return typeof __ENGINE_TARGET__ === 'string' ? __ENGINE_TARGET__ : '(unknown)';
}

interface RequestOptions {
  /** Send the bearer token (default true). Login must not. */
  authenticate?: boolean;
  /** Do not broadcast a 401 to the app shell (used while resolving auth). */
  suppressUnauthorized?: boolean;
}

async function request<T>(path: string, init?: RequestInit, options: RequestOptions = {}): Promise<T> {
  const url = `${engineBase()}${path}`;

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...((init?.headers as Record<string, string> | undefined) ?? {}),
  };
  if (options.authenticate !== false) {
    const token = authToken();
    if (token !== null) headers.authorization = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await fetch(url, { ...init, headers });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new EngineError(`Could not reach the engine at ${engineLabel()} (${detail}).`, 0, 'network_error');
  }

  const text = await response.text();
  let body: unknown = null;
  if (text.trim() !== '') {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (!response.ok) {
    const shape = (body ?? {}) as { error?: string; code?: string };
    const failure = new EngineError(
      shape.error ?? `HTTP ${response.status} from ${path}`,
      response.status,
      shape.code ?? `http_${response.status}`,
    );
    // A 401 means the session died under us (engine restart / 12h expiry) or we
    // never had one. Tell the shell so it can show the login screen; the login
    // request itself and the auth-resolution calls opt out.
    if (failure.status === 401 && options.suppressUnauthorized !== true) {
      signalUnauthorized();
    }
    throw failure;
  }

  if (body === null) {
    throw new EngineError(`Empty or non-JSON response from ${path}.`, response.status, 'empty_response');
  }

  return body as T;
}

function postJson<T>(path: string, payload: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(payload) });
}

export const engineApi = {
  /**
   * Public route, deliberately readable without a token (it is how a client
   * learns whether a token is needed). Pass `suppressUnauthorized` while the app
   * is still deciding whether a login screen applies.
   */
  capabilities(options: { suppressUnauthorized?: boolean } = {}): Promise<Capabilities> {
    return request<Capabilities>('/v1/capabilities', undefined, {
      suppressUnauthorized: options.suppressUnauthorized === true,
    });
  },

  /** POST /v1/login — only engines with authentication enabled accept it. */
  login(user: string, password: string): Promise<LoginResponse> {
    return request<LoginResponse>(
      '/v1/login',
      { method: 'POST', body: JSON.stringify({ user, password }) },
      { authenticate: false, suppressUnauthorized: true },
    );
  },

  /** Dataset names in the engine's exact stored casing, sorted. Includes system cubes. */
  async datasets(): Promise<string[]> {
    const body = await request<DatasetsResponse>('/v1/datasets');
    return body.datasets;
  },

  describe(dataset: string): Promise<DatasetDescription> {
    return request<DatasetDescription>(datasetPath(dataset));
  },

  sample(dataset: string, options: { limit?: number; offset?: number } = {}): Promise<SampleResponse> {
    const params = new URLSearchParams();
    params.set('limit', String(options.limit ?? 10));
    if (options.offset !== undefined) params.set('offset', String(options.offset));
    return request<SampleResponse>(`${datasetPath(dataset)}/sample?${params.toString()}`);
  },

  /**
   * POST /v1/{dataset}/query. Every body carries `protocolVersion` (PROTOCOL
   * §0.3); callers may not override it with a different contract version.
   */
  query(options: QueryRequest): Promise<QueryResponse> {
    return postJson<QueryResponse>(`${datasetPath(options.dataset)}/query`, {
      ...options,
      protocolVersion: SUPPORTED_PROTOCOL_VERSION,
    });
  },

  /** The engine's formatted-TEXT SQL console endpoint. */
  sql(sql: string): Promise<SqlResponse> {
    return postJson<SqlResponse>('/v1/sql', { sql });
  },

  /**
   * POST /v1/cli — the admin-only engine CLI bridge (PROTOCOL §0.6, D28).
   * Engine tooling, not a client data path; callers MUST feature-detect
   * `capabilities.supportsCli`. The engine validates the single-command policy
   * and returns command-level failures as HTTP 200 with `ok: false`.
   */
  cli(command: string): Promise<CliResponse> {
    return postJson<CliResponse>('/v1/cli', { command });
  },
};

/** Best-effort human text for any thrown value. */
export function errorText(error: unknown): string {
  if (error instanceof EngineError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function errorCode(error: unknown): string | null {
  return error instanceof EngineError ? error.code : null;
}
