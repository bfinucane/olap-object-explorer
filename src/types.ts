/**
 * Wire types for the Patricia OLAP engine HTTP API.
 *
 * **Contract:** suite contract **v1** (== `protocolVersion 1`). The normative
 * text is `contract/PROTOCOL.md` in the workspace that owns the engine; it is
 * deliberately NOT vendored into this repository (contract `README.md` §Adoption
 * protocol / DECISIONS D8). This client pins contract v1 and was verified against
 * engine HEAD `d6b02e0` (2026-10-28).
 *
 * The engine tree and the contract folder belong to other sessions; this client
 * only reads the wire. It is read-only by design: tiers T0–T3 are adopted, T4
 * writeback is not (the engine supports it — `supportsWrite`, PROTOCOL §7/§8 —
 * this product simply does not write).
 */

/** A cell as it arrives in JSON. Absent measure cells are `null` (PROTOCOL §5.10). */
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
   * Whether a bearer token is required (PROTOCOL §1.1/§6.1). Absent must be read
   * as `false` (older engine); this engine overrides it from its launch flags, so
   * read the live response, never the snapshot file.
   */
  authRequired?: boolean;
  /**
   * Whether `POST /v1/{dataset}/write` and `POST /v1/save` exist (PROTOCOL §7/§8).
   * This client never writes, but the report is typed so the claim stays honest.
   */
  supportsWrite?: boolean;
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
