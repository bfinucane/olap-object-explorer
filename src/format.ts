/** Small display formatters. Kept separate so they are trivially testable. */

export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US');
}

/** Rollup weights are usually 1 or 0.5; show them without noisy trailing zeros. */
export function formatWeight(weight: number | null): string {
  if (weight === null || !Number.isFinite(weight)) return '—';
  if (Number.isInteger(weight)) return String(weight);
  return String(Number(weight.toFixed(4)));
}

export function formatPrimaryKey(primaryKey: string | string[] | null): string {
  if (primaryKey === null) return '—';
  if (Array.isArray(primaryKey)) return primaryKey.length === 0 ? '—' : primaryKey.join(', ');
  return primaryKey;
}

export function formatRange(min: number | null, max: number | null): string {
  if (min === null && max === null) return '—';
  return `${min === null ? '−∞' : formatCount(min)} … ${max === null ? '∞' : formatCount(max)}`;
}

export function formatType(dataType: string, logicalType: string): string {
  return dataType === logicalType ? dataType : `${dataType} · ${logicalType}`;
}
