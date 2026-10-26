import type { DimensionInfo } from './discovery';
import type { ColumnDescription, DatasetDescription } from './types';

/**
 * What the right-hand panes are currently showing. A discriminated union so the
 * Details pane can render every case exhaustively without `any` casts.
 */
export type Selection =
  | { kind: 'empty' }
  | { kind: 'loading'; label: string }
  | { kind: 'error'; label: string; error: unknown }
  | { kind: 'cube'; dataset: DatasetDescription }
  | { kind: 'column'; dataset: DatasetDescription; column: ColumnDescription }
  | { kind: 'dimension'; dimension: DimensionInfo }
  | { kind: 'hierarchy'; dimension: string; hierarchy: string }
  | {
      kind: 'member';
      dimension: string;
      hierarchy: string;
      /** Root-to-member name path, e.g. ["All", "Furniture", "Bookcases"]. */
      path: string[];
      /** Rollup weight on the incoming edge; null for roots. */
      weight: number | null;
      childCount: number;
    };
