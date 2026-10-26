/**
 * Pure client-side hierarchy reconstruction.
 *
 * The engine has no "give me the member tree" endpoint. `#Members` lists the
 * members of one hierarchy and `#Edges` lists parent/child pairs (with the
 * rollup weight as the cell value); the tree is folded from those two queries
 * here, client-side, exactly as the handoff §4 level 5 describes.
 *
 * This module is intentionally free of imports and of any I/O so that
 * tools/verify-data.mjs can bundle it with esbuild and unit-test it directly,
 * including on empty input (acceptance: a fresh/empty database must render,
 * 0 rows, not crash).
 */

export interface EdgeRow {
  member: string;
  parent: string;
  weight: number;
}

export interface MemberNode {
  name: string;
  /** Rollup weight of the edge that leads to this member; `null` for roots. */
  weight: number | null;
  children: MemberNode[];
}

/** Compare names with embedded numbers numerically: "Item 2" before "Item 10". */
export function naturalCompare(a: string, b: string): number {
  const left = a.split(/(\d+)/);
  const right = b.split(/(\d+)/);
  const length = Math.max(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index] ?? '';
    const rightPart = right[index] ?? '';
    const isNumber = index % 2 === 1;

    if (isNumber) {
      const leftNumber = Number(leftPart);
      const rightNumber = Number(rightPart);
      if (leftNumber !== rightNumber) return leftNumber - rightNumber;
    } else if (leftPart !== rightPart) {
      return leftPart < rightPart ? -1 : 1;
    }
  }

  // Identical apart from case, or compare returned 0: keep it deterministic.
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Member order used at every level: the conventional root "All" first, then
 * natural (numeric-aware) alphabetical. The engine returns members in
 * dictionary order, which is not meaningful to a reader.
 */
export function compareMemberNames(a: string, b: string): number {
  const aAll = a.toLowerCase() === 'all';
  const bAll = b.toLowerCase() === 'all';
  if (aAll !== bAll) return aAll ? -1 : 1;
  return naturalCompare(a, b);
}

export function sortMemberNames(names: string[]): string[] {
  return [...names].sort(compareMemberNames);
}

/**
 * Fold `members` + `edges` into a forest of member nodes.
 *
 * - Roots are members that never appear as an edge's child (`#Member`).
 * - A member with several parents (a shared rollup, weight 0.5) is rendered
 *   under each parent; it really is reachable by more than one path.
 * - Cycles and self-edges cannot hang the renderer: a node already on the
 *   current path is emitted without children.
 * - Empty input returns an empty forest, so an empty/fresh database renders
 *   "no members" instead of throwing.
 */
export function buildMemberForest(members: string[], edges: EdgeRow[]): MemberNode[] {
  const edgesByParent = new Map<string, EdgeRow[]>();
  const children = new Set<string>();
  const known = new Set<string>(members);

  for (const edge of edges) {
    const member = String(edge.member);
    const parent = String(edge.parent);
    if (member === '' || parent === '') continue;

    known.add(member);
    known.add(parent);
    children.add(member);

    const bucket = edgesByParent.get(parent);
    if (bucket) bucket.push({ ...edge, member, parent });
    else edgesByParent.set(parent, [{ ...edge, member, parent }]);
  }

  const rootNames = [...known].filter((name) => !children.has(name)).sort(compareMemberNames);

  const build = (name: string, weight: number | null, path: ReadonlySet<string>): MemberNode => {
    const node: MemberNode = { name, weight, children: [] };
    if (path.has(name)) return node;

    const nextPath = new Set(path);
    nextPath.add(name);

    const seen = new Set<string>();
    const edgesForParent = [...(edgesByParent.get(name) ?? [])].sort((a, b) =>
      compareMemberNames(a.member, b.member),
    );
    for (const edge of edgesForParent) {
      if (seen.has(edge.member)) continue;
      seen.add(edge.member);
      node.children.push(build(edge.member, edge.weight, nextPath));
    }

    return node;
  };

  return rootNames.map((name) => build(name, null, new Set<string>()));
}

/** Depth-first count of nodes; handy for tests and summaries. */
export function countNodes(forest: MemberNode[]): number {
  return forest.reduce((total, node) => total + 1 + countNodes(node.children), 0);
}

/** Depth-first list of names, for assertions such as "All > Furniture > Bookcases". */
export function flattenNames(forest: MemberNode[], prefix: string[] = []): string[][] {
  const paths: string[][] = [];
  for (const node of forest) {
    const path = [...prefix, node.name];
    paths.push(path);
    paths.push(...flattenNames(node.children, path));
  }
  return paths;
}
