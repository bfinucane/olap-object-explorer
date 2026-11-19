/**
 * CLI command history persistence.
 *
 * Deliberately **commands only** (no output): output can be up to 64 KiB per
 * command, and a clipboard-style recall list does not need it. Stored in
 * `localStorage`, keyed by engine server + signed-in user, capped at 100.
 *
 * Multi-user caveat: this is a single-browser profile store. Two different
 * OS users sharing one browser profile share `localStorage`; the user-name key
 * separates normal logins, but an anonymous session shares the `anonymous` key
 * for that server. Commands may contain server paths/names, so the README says
 * this plainly.
 */
export const CLI_HISTORY_LIMIT = 100;
const KEY_PREFIX = 'olap-object-explorer.cli-history.v1';

export function cliHistoryKey(server: string, user: string | null): string {
  return `${KEY_PREFIX}:${server === '' ? 'proxy' : server}:${user ?? 'anonymous'}`;
}

/** Keep only non-empty, single-line strings and cap at the limit. */
export function normalizeHistory(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const result: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    if (item.trim() === '' || /[\r\n]/.test(item)) continue;
    result.push(item);
    if (result.length >= CLI_HISTORY_LIMIT) break;
  }
  return result;
}

/** Newest first, no consecutive duplicates, capped. */
export function addCommand(history: string[], command: string): string[] {
  if (command.trim() === '' || /[\r\n]/.test(command)) return history;
  const withoutDuplicate = history[0] === command ? history : [command, ...history];
  return withoutDuplicate.slice(0, CLI_HISTORY_LIMIT);
}

export function loadHistory(storage: Storage | null, key: string): string[] {
  if (storage === null) return [];
  try {
    const raw = storage.getItem(key);
    if (raw === null) return [];
    return normalizeHistory(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function saveHistory(storage: Storage | null, key: string, history: string[]): void {
  if (storage === null) return;
  try {
    if (history.length === 0) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(history.slice(0, CLI_HISTORY_LIMIT)));
  } catch {
    /* quota/privacy failure: keep the in-memory list */
  }
}
