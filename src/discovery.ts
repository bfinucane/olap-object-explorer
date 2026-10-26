/**
 * Discovery layer: turns the engine's six system cubes into the facts the tree
 * needs, one query per expansion, with promise-level caching so a level is
 * fetched at most once per session.
 *
 * Everything structural is read from system cubes, never guessed from the SQL
 * console (handoff §5.5: SQL injects default members; the query API does not).
 *
 * Verified shapes (handoff §4, re-probed against the live engine):
 *
 *   #Dimensions  groupBy [#Dimension, #Property]           -> hierarchyCount per dimension
 *   #Hierarchies groupBy [#Dimension, #Hierarchy]          -> hierarchy names per dimension
 *   #Members     groupBy [#Hierarchy, #Member]             -> member names per hierarchy
 *   #Edges       groupBy [#Member, #Parent]                -> parent/child + rollup weight
 */

import { engineApi } from './api';
import { buildMemberForest, sortMemberNames, type EdgeRow, type MemberNode } from './memberTree';
import type { Cell, DatasetDescription } from './types';

/** The engine's own cap (capabilities.maxRows); used for structural queries. */
const STRUCTURAL_LIMIT = 100_000;

const promiseCache = new Map<string, Promise<unknown>>();

function memo<T>(key: string, load: () => Promise<T>): Promise<T> {
  const cached = promiseCache.get(key) as Promise<T> | undefined;
  if (cached) return cached;

  const pending = load();
  promiseCache.set(key, pending);
  // A failed level must stay retryable: drop it so a later expand tries again.
  pending.catch(() => {
    if (promiseCache.get(key) === pending) promiseCache.delete(key);
  });
  return pending;
}

/** Forget everything (used by the Retry button after the engine was down). */
export function resetDiscoveryCache(): void {
  promiseCache.clear();
}

function text(cell: Cell | undefined): string {
  return cell === null || cell === undefined ? '' : String(cell);
}

function unique(names: string[]): string[] {
  return [...new Set(names)];
}

export interface DimensionInfo {
  name: string;
  hierarchyCount: number;
}

export interface MemberTree {
  forest: MemberNode[];
  memberCount: number;
  edgeCount: number;
  /** True if the engine truncated a structural response; the tree is then partial. */
  truncated: boolean;
}

async function fetchMembers(hierarchy: string): Promise<{ names: string[]; truncated: boolean }> {
  const response = await engineApi.query({
    dataset: '#Members',
    groupBy: [{ name: '#Hierarchy' }, { name: '#Member' }],
    filters: [{ field: '#Hierarchy', operator: 'in', values: [hierarchy] }],
    limit: STRUCTURAL_LIMIT,
  });
  return {
    names: unique(response.rows.map((row) => text(row[1])).filter((name) => name !== '')),
    truncated: response.truncated,
  };
}

async function fetchEdges(hierarchy: string): Promise<{ edges: EdgeRow[]; truncated: boolean }> {
  const response = await engineApi.query({
    dataset: '#Edges',
    groupBy: [{ name: '#Member' }, { name: '#Parent' }],
    filters: [{ field: '#Hierarchy', operator: 'in', values: [hierarchy] }],
    limit: STRUCTURAL_LIMIT,
  });
  const edges = response.rows
    .map((row) => {
      const weight = Number(row[2]);
      return {
        member: text(row[0]),
        parent: text(row[1]),
        weight: Number.isFinite(weight) ? weight : 1,
      };
    })
    .filter((edge) => edge.member !== '' && edge.parent !== '');
  return { edges, truncated: response.truncated };
}

export const discovery = {
  /** Dataset names, exact casing, including the `#`-prefixed system cubes. */
  datasets(): Promise<string[]> {
    return memo('datasets', () => engineApi.datasets());
  },

  describe(dataset: string): Promise<DatasetDescription> {
    return memo(`describe:${dataset}`, () => engineApi.describe(dataset));
  },

  /**
   * Dimensions with their hierarchy count. One query for the whole database.
   * Values in a system-cube query arrive in the `value` cell as numbers, so the
   * hierarchy count is read from the `hierarchyCount` property row, not guessed.
   */
  dimensions(): Promise<DimensionInfo[]> {
    return memo('dimensions', async () => {
      const response = await engineApi.query({
        dataset: '#Dimensions',
        groupBy: [{ name: '#Dimension' }, { name: '#Property' }],
        limit: STRUCTURAL_LIMIT,
      });

      const counts = new Map<string, number>();
      for (const row of response.rows) {
        const name = text(row[0]);
        if (name === '') continue;
        if (!counts.has(name)) counts.set(name, 0);
        if (text(row[1]) === 'hierarchyCount') {
          const value = Number(row[2]);
          counts.set(name, Number.isFinite(value) ? value : 0);
        }
      }

      return sortMemberNames([...counts.keys()]).map((name) => ({
        name,
        hierarchyCount: counts.get(name) ?? 0,
      }));
    });
  },

  /** Hierarchies of one dimension, sorted. */
  hierarchies(dimension: string): Promise<string[]> {
    return memo(`hierarchies:${dimension}`, async () => {
      const response = await engineApi.query({
        dataset: '#Hierarchies',
        groupBy: [{ name: '#Dimension' }, { name: '#Hierarchy' }],
        filters: [{ field: '#Dimension', operator: 'in', values: [dimension] }],
        limit: STRUCTURAL_LIMIT,
      });
      return unique(response.rows.map((row) => text(row[1])).filter((name) => name !== '')).sort(
        (a, b) => (a < b ? -1 : a > b ? 1 : 0),
      );
    });
  },

  /** Member names of one hierarchy (consolidated members included). */
  members(hierarchy: string): Promise<string[]> {
    return memo(`members:${hierarchy}`, async () => (await fetchMembers(hierarchy)).names);
  },

  /** Parent/child edges of one hierarchy, with rollup weights. */
  edges(hierarchy: string): Promise<EdgeRow[]> {
    return memo(`edges:${hierarchy}`, async () => (await fetchEdges(hierarchy)).edges);
  },

  /** Members + edges folded into the nested tree (handoff §4 level 5). */
  memberTree(hierarchy: string): Promise<MemberTree> {
    return memo(`memberTree:${hierarchy}`, async () => {
      const [members, edges] = await Promise.all([fetchMembers(hierarchy), fetchEdges(hierarchy)]);
      return {
        forest: buildMemberForest(members.names, edges.edges),
        memberCount: members.names.length,
        edgeCount: edges.edges.length,
        truncated: members.truncated || edges.truncated,
      };
    });
  },
};
