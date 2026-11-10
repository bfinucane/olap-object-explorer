import type { DragEvent } from 'react';

/** Custom MIME so a drop knows the payload is a model name, not arbitrary text. */
export const NAME_MIME = 'application/x-olap-name';

/**
 * Drag-and-drop of model names (cubes, columns, dimensions, hierarchies, members)
 * into the SQL editor. Names only: quoting member values / filters is a later,
 * separately-decided feature.
 */
export function startNameDrag(event: DragEvent<HTMLElement>, name: string): void {
  event.dataTransfer.setData('text/plain', name);
  event.dataTransfer.setData(NAME_MIME, name);
  event.dataTransfer.effectAllowed = 'copy';
}

export function readNameDrag(event: DragEvent<HTMLElement>): string {
  return event.dataTransfer.getData(NAME_MIME) || event.dataTransfer.getData('text/plain');
}

/**
 * Insert `name` at the caret/selection with minimal surrounding whitespace, so a
 * drop lands as a separate token instead of gluing to the previous word.
 */
export function insertName(text: string, start: number, end: number, name: string): {
  text: string;
  caret: number;
} {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const prefix = before !== '' && !/[\s(,.]$/.test(before) ? ' ' : '';
  const suffix = after !== '' && !/^[\s),.]/.test(after) ? ' ' : '';
  const inserted = `${prefix}${name}${suffix}`;
  return {
    text: `${before}${inserted}${after}`,
    caret: before.length + inserted.length,
  };
}
