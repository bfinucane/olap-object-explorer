/**
 * Wire types for the Patricia OLAP engine HTTP API.
 *
 * The normative contract is `tableau-clone/docs/ENGINE-PROTOCOL.md`, but the
 * engine is ahead of that document; these types follow the verified snapshot in
 * `olap-object-explorer-handoff.md` §3–§4 and were re-probed against the live
 * engine on 8080 before this file was written.
 *
 * Read-only: the engine has no write API, and nothing here attempts one.
 */

/** A cell as it arrives in JSON. Absent measure cells are `null` (handoff §5.6). */
export type Cell = string | number | null;

export interface Capabilities {
  protocolVersion: number;
  aggregations: string[];
  filterOperators: string[];
  maxRows: number;
  supportsJoin: boolean;
  supportsInlineDomain: boolean;
  supportsLod: boolean;
  countDistinctExact: boolean;
  expressionFunctions: string[];
  /**
   * Present on engines with authentication: true means every /v1 route except
   * /v1/capabilities and /v1/login needs a bearer token. Undefined on older
   * engines (the one serving the seeded database today does not send it).
   */
  authRequired?: boolean;
}

export interface DatasetsResponse {
  datasets: string[];
}

/** One entry of `describe().columns`. */
export interface ColumnDescription {
  name: string;
  dataType: string;
  logicalType: string;
  cardinality: number;
  suggestedKind: string;
  nullable: boolean;
  notNull: boolean;
  min: number | null;
  max: number | null;
}

/** `GET /v1/{dataset}` — the describe payload. */
export interface DatasetDescription {
  dataset: string;
  rowCount: number;
  measureDimension: string | null;
  isAttributeTable: boolean;
  isSystem: boolean;
  primaryKey: string | string[] | null;
  columns: ColumnDescription[];
}

/** `GET /v1/{dataset}/sample` — raw rows, column names only. */
export interface SampleResponse {
  columns: string[];
  rowCount: number;
  rows: Cell[][];
}

export type FilterOperator = 'in' | 'equals' | 'notEquals';

export interface Filter {
  field: string;
  operator: FilterOperator;
  values: string[];
}

export interface GroupByField {
  name: string;
}

export interface MeasureSpec {
  name: string;
  aggregation: string;
}

export interface QueryRequest {
  dataset: string;
  protocolVersion?: number;
  groupBy?: GroupByField[];
  measures?: MeasureSpec[];
  filters?: Filter[];
  domainFor?: string[];
  limit?: number;
}

export interface ColumnMeta {
  name: string;
  dataType: string;
  logicalType: string;
  kind: string;
  defaultAggregation?: string;
  semanticType?: string;
}

/** `POST /v1/{dataset}/query`. */
export interface QueryResponse {
  columns: string[];
  columnMeta: ColumnMeta[];
  dimensionNames: string[];
  measureNames: string[];
  measureLabels: string[];
  rows: Cell[][];
  domain: Record<string, string[]>;
  elapsedMs: number;
  truncated: boolean;
}

/** `POST /v1/sql` — the engine returns a formatted TEXT table, not rows. */
export interface SqlResponse {
  sql: string;
  output: string;
  elapsedMs: number;
}

/** `POST /v1/login` — only engines with authentication enabled have this route. */
export interface LoginResponse {
  /** 64 hex chars; send as `Authorization: Bearer <token>`. */
  token: string;
  user: string;
  roles: string[];
  /** Unix seconds. Engine sessions are in-memory and last 12 hours. */
  expiresAt: number;
}
