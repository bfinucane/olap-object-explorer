/**
 * The engine's SQL console (`POST /v1/sql`) returns a formatted **text** table,
 * not rows (PROTOCOL §0.5). The Object Explorer renders that as a real HTML
 * table; this parser is the only bridge and it is deliberately strict:
 *
 *   Category | Sales
 *   --------------------
 *   Furniture | 6447211.13
 *
 * - first line: header, cells joined by `" | "`
 * - second line: separator made of dashes only
 * - each subsequent non-empty line: exactly one cell per header column
 *
 * A value containing `" | "` would make the cell count ambiguous; the parser
 * returns null rather than silently shifting columns, and the caller falls back
 * to the raw engine text. `"0 rows returned."` is not a table either.
 */
export interface ParsedSqlTable {
  columns: string[];
  rows: string[][];
}

export function parseSqlTable(output: string): ParsedSqlTable | null {
  const lines = output.replace(/\r\n/g, '\n').split('\n');
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  if (lines.length < 2) return null;

  const columns = lines[0].split(' | ');
  if (columns.length === 0 || columns.some((column) => column.trim() === '')) return null;

  // The separator is dashes only (the engine does not put `|` in it).
  if (!/^-+$/.test(lines[1].trim())) return null;

  const rows: string[][] = [];
  for (const line of lines.slice(2)) {
    if (line.trim() === '') continue;
    const cells = line.split(' | ');
    if (cells.length !== columns.length) return null;
    rows.push(cells);
  }
  return { columns, rows };
}
