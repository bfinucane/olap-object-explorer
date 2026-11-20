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
 *  - `value` is the measure-dimension expansion: on a cube with a measure
 *    dimension it yields one column per measure (PROTOCOL §5.2/§5.3).
 *  - A projection with NO measures repeats each group once per measure member
 *    (§11.8), so every template includes `value` or a measure.
 *  - **Attribute tables** (`isAttributeTable`) are pivot sources: their measure
 *    dimension holds ATTRIBUTE NAMES and its cells hold the values. Projecting
 *    that column together with `value` is the refused combination (PROTOCOL
 *    §11.4), so it is excluded from every template (handoff 024).
 *  - SQL has no `SELECT *` and no column aliases here; templates stay plain.
 */

export type SqlTemplateId = 'rows' | 'by-dimension' | 'totals';

export interface SqlTemplate {
  id: SqlTemplateId;
  label: string;
  sql: string;
}

/**
 * Dimensions a template can project: real dimension columns, not the `value`
 * token. The engine reports a system cube's trailing `value` cell as
 * `suggestedKind: "dimension"` (e.g. `#Dimensions` → `#Dimension`, `#Property`,
 * `value`), so `value` is excluded here and added exactly once below.
 */
export function dimensionColumns(dataset: DatasetDescription): ColumnDescription[] {
  return dataset.columns.filter(
    (column) => column.suggestedKind === 'dimension' && column.name.toLowerCase() !== 'value',
  );
}

/**
 * Grouping/key dimensions. The measure dimension is never a key: on a normal
 * cube it is the axis whose members are measures, and on an attribute table it
 * is the attribute-name column. `describe` hints an attribute table's text
 * measure dimension as `suggestedKind: "dimension"` (PROTOCOL §3.2), so kind
 * alone cannot exclude it.
 */
export function keyDimensionColumns(dataset: DatasetDescription): ColumnDescription[] {
  return dimensionColumns(dataset).filter((column) => column.name !== dataset.measureDimension);
}

export function isKeyDimension(dataset: DatasetDescription, name: string): boolean {
  return keyDimensionColumns(dataset).some((column) => column.name === name);
}

/**
 * The default statement. For a normal cube: every dimension + `value`. For an
 * attribute table: key dimensions + `value`, which pivots attributes into
 * columns — there is no raw EAV form in SQL (handoff 024).
 */
export function buildRowSample(dataset: DatasetDescription): string {
  const dimensions = (dataset.isAttributeTable ? keyDimensionColumns(dataset) : dimensionColumns(dataset)).map(
    (column) => column.name,
  );
  const projection = dimensions.length > 0 ? [...dimensions, 'value'].join(', ') : 'value';
  return `SELECT ${projection} FROM ${dataset.dataset} LIMIT 50`;
}

/** One key dimension with every measure aggregated over the remaining dimensions. */
export function buildByDimension(dataset: DatasetDescription, dimension: string | null): string | null {
  if (dimension === null || !isKeyDimension(dataset, dimension)) return null;
  return `SELECT ${dimension}, value FROM ${dataset.dataset} LIMIT 100`;
}

/**
 * Whole-cube totals: never for an attribute table. `SELECT value` there pivots
 * every attribute column (and aggregating text is misleading); a COUNTD-style
 * template would be a separate deliberate choice, not this one.
 */
export function buildTotals(dataset: DatasetDescription): string | null {
  if (dataset.isAttributeTable) return null;
  return `SELECT value FROM ${dataset.dataset} LIMIT 10`;
}

/**
 * The template menu for a cube. `selectedDimension` comes from the tree selection
 * and only enables the "By …" entry when it names a **key** dimension of this
 * cube (never the attribute/measure dimension).
 */
export function buildTemplates(
  dataset: DatasetDescription,
  selectedDimension: string | null,
): { templates: SqlTemplate[]; byDimensionDisabled: boolean } {
  const byDimension = buildByDimension(dataset, selectedDimension);
  const totals = buildTotals(dataset);
  const templates: SqlTemplate[] = [
    {
      id: 'rows',
      label: dataset.isAttributeTable
        ? 'Attribute sample — key dimensions + pivoted attributes'
        : 'Row sample — every dimension + every measure',
      sql: buildRowSample(dataset),
    },
  ];
  if (byDimension !== null && selectedDimension !== null) {
    templates.push({ id: 'by-dimension', label: `By ${selectedDimension} — every measure`, sql: byDimension });
  }
  if (totals !== null) {
    templates.push({ id: 'totals', label: 'Totals — every measure, whole cube', sql: totals });
  }
  return { templates, byDimensionDisabled: byDimension === null };
}
