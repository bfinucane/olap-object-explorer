/**
 * Single entry point for the data layer, for consumers that are not the React
 * app (the verification tools today; Plateau, if this ever folds in).
 *
 * The UI imports the individual modules directly; this barrel exists so the
 * whole layer can be bundled and exercised from Node with one esbuild call.
 */

export {
  EngineError,
  authToken,
  datasetPath,
  engineApi,
  engineBase,
  engineLabel,
  engineTarget,
  errorCode,
  errorText,
  isUnauthorized,
} from './api';
export { discovery, resetDiscoveryCache } from './discovery';
export {
  clearAuth,
  getSession,
  getToken,
  hasToken,
  restoreSession,
  seedTokenFromUrl,
  setAuth,
  setUnauthorizedHandler,
  signalUnauthorized,
} from './auth';
export type { SessionInfo, UnauthorizedReason } from './auth';
export type { DimensionInfo, MemberTree } from './discovery';
export * from './memberTree';
export type {
  Capabilities,
  Cell,
  ColumnDescription,
  ColumnMeta,
  DatasetDescription,
  DatasetsResponse,
  Filter,
  FilterOperator,
  LoginResponse,
  QueryRequest,
  QueryResponse,
  SampleResponse,
  SqlResponse,
} from './types';
