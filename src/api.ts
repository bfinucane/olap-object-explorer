/**
 * Thin, typed client for the engine's read-only HTTP API.
 *
 * Two environment facts drive the design:
 *
 * 1. `#` in a dataset name is a URL fragment and never reaches the server, so
 *    every dataset path segment is percent-encoded (`#Members` -> `%23Members`,
 *    handoff §5.1).
 * 2. Engine CORS is off by default (handoff §2), so in the browser the base URL
 *    is empty and requests go through the Vite proxy on the same origin. A
 *    `?engine=<url>` query parameter is supported for talking to a CORS-enabled
 *    engine directly, which is useful when this app is served some other way.
 *
 * `engineBase()` is deliberately lazy (never runs at module load) so that the
 * data layer can also be bundled and exercised from Node by tools/verify-data.mjs.
 */

import type {
  Capabilities,
  DatasetDescription,
  DatasetsResponse,
  LoginResponse,
  QueryRequest,
  QueryResponse,
  SampleResponse,
  SqlResponse,
} from './types';
import { getToken, signalUnauthorized } from './auth';

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
export function engineBase(): string {
  if (isBrowser()) {
    const configured = new URLSearchParams(window.location.search).get('engine');
    if (configured !== null) return configured.replace(/\/+$/, '');
    return '';
  }
  // Node (verification tools): talk to the engine directly, no proxy needed.
  return (nodeEnv('OLAP_ENGINE_URL') ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');
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

  query(options: QueryRequest): Promise<QueryResponse> {
    return postJson<QueryResponse>(`${datasetPath(options.dataset)}/query`, {
      protocolVersion: 1,
      ...options,
    });
  },

  /** The engine's formatted-TEXT SQL console endpoint. */
  sql(sql: string): Promise<SqlResponse> {
    return postJson<SqlResponse>('/v1/sql', { sql });
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
