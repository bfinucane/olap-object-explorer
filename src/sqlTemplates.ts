import type { ColumnDescription, DatasetDescription } from './types';

/**
 * Templates for the SQL console (engine tooling, PROTOCOL §0.5 — not a data path).
 *
 * They are built from `describe`, never hard-coded: model names changed several
 * times (Sales → Orders, Sub-Category → SubCategory), and a hard-coded starter
 * query is how the console ended up offering a dataset that no longer exists.
 *
 * Semantics that shape the templates:
 *  - A dimension omitted from `groupBy` and filters contributes ALL of its base
 *    members to the aggregation (explicit-default semantics, contract D22).
 *    So an aggregate template without a dimension is a whole-model total today,
 *    not an arbitrary slice.
 *  - `value` is the measure-dimension expansion: on a cube with a measure
 *    dimension it yields one column per measure (PROTOCOL §5.2/§5.3).
 *  - A projection with NO measures repeats each group once per measure member
 *    (§11.8), so every template includes `value` or a measure.
 *  - SQL has no `SELECT *` and no column aliases here; templates stay plain.
 */

export type SqlTemplateId = 'rows' | 'by-dimension' | 'totals';

export interface SqlTemplate {
  id: SqlTemplateId;
  label: string;
  sql: string;
}

/**
 * Dimensions a template can project: real dimension columns, not the measure axis.
 *
 * The engine reports the trailing `value` cell of a **system cube** as
 * `suggestedKind: "dimension"` (e.g. `#Dimensions` → `#Dimension`, `#Property`,
 * `value`). `value` is the SQL measure token, so it is excluded here and added
 * exactly once by the templates below; otherwise a system cube yields
 * `SELECT …, value, value`.
 */
export function dimensionColumns(dataset: DatasetDescription): ColumnDescription[] {
  return dataset.columns.filter(
    (column) => column.suggestedKind === 'dimension' && column.name.toLowerCase() !== 'value',
  );
}

export function isDimensionColumn(dataset: DatasetDescription, name: string): boolean {
  return dimensionColumns(dataset).some((column) => column.name === name);
}

/**
 * The default statement: every dimension plus every measure (`value`), as raw
 * rows. Naming every dimension means no implicit aggregation surprise and no
 * §11.8 duplication; it is the honest "show me the shape" query.
 */
export function buildRowSample(dataset: DatasetDescription): string {
  const dimensions = dimensionColumns(dataset).map((column) => column.name);
  const projection = dimensions.length > 0 ? [...dimensions, 'value'].join(', ') : 'value';
  return `SELECT ${projection} FROM ${dataset.dataset} LIMIT 50`;
}

/** One dimension with every measure aggregated over the remaining dimensions. */
export function buildByDimension(dataset: DatasetDescription, dimension: string | null): string | null {
  if (dimension === null || !isDimensionColumn(dataset, dimension)) return null;
  return `SELECT ${dimension}, value FROM ${dataset.dataset} LIMIT 100`;
}

/** Whole-cube totals: one row, one column per measure. */
export function buildTotals(dataset: DatasetDescription): string {
  return `SELECT value FROM ${dataset.dataset} LIMIT 10`;
}

/**
 * The template menu for a cube. `selectedDimension` comes from the tree selection
 * and only enables the "By …" entry when it names a dimension of this cube.
 */
export function buildTemplates(
  dataset: DatasetDescription,
  selectedDimension: string | null,
): { templates: SqlTemplate[]; byDimensionDisabled: boolean } {
  const byDimension = buildByDimension(dataset, selectedDimension);
  const templates: SqlTemplate[] = [
    { id: 'rows', label: 'Row sample — every dimension + every measure', sql: buildRowSample(dataset) },
  ];
  if (byDimension !== null && selectedDimension !== null) {
    templates.push({ id: 'by-dimension', label: `By ${selectedDimension} — every measure`, sql: byDimension });
  }
  templates.push({ id: 'totals', label: 'Totals — every measure, whole cube', sql: buildTotals(dataset) });
  return { templates, byDimensionDisabled: byDimension === null };
}
