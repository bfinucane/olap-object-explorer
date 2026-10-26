import { useCallback, useEffect, useState } from 'react';
import { errorText } from './api';

/** Kinds drive the glyph and colour of a tree row. */
export type NodeKind =
  | 'section'
  | 'cube'
  | 'system-cube'
  | 'column-dimension'
  | 'column-measure'
  | 'dimension'
  | 'hierarchy'
  | 'member'
  | 'note';

/**
 * A tree row. `loadChildren` is called on first expand, so each level is
 * exactly one engine query (handoff §6: lazy-load, don't fetch the database up
 * front). `children` is for levels that are already in hand (the root sections).
 */
export interface TreeNodeModel {
  id: string;
  label: string;
  kind: NodeKind;
  /** Overrides the default one-character glyph (e.g. ⊕ for aggregates). */
  glyph?: string;
  badge?: string;
  detail?: string;
  children?: TreeNodeModel[];
  loadChildren?: () => Promise<TreeNodeModel[]>;
  expandedByDefault?: boolean;
  onSelect?: () => void;
}

const DEFAULT_GLYPHS: Record<NodeKind, string> = {
  section: '',
  cube: 'C',
  'system-cube': '#',
  'column-dimension': 'd',
  'column-measure': 'm',
  dimension: 'D',
  hierarchy: 'H',
  member: '·',
  note: '!',
};

interface TreeProps {
  groups: TreeNodeModel[];
  selectedId: string | null;
  onSelect: (node: TreeNodeModel) => void;
}

export function Tree({ groups, selectedId, onSelect }: TreeProps) {
  return (
    <div className="tree" role="tree" aria-label="Database objects">
      {groups.map((group) => (
        <TreeItem key={group.id} node={group} depth={0} selectedId={selectedId} onSelect={onSelect} />
      ))}
    </div>
  );
}

interface TreeItemProps {
  node: TreeNodeModel;
  depth: number;
  selectedId: string | null;
  onSelect: (node: TreeNodeModel) => void;
}

function TreeItem({ node, depth, selectedId, onSelect }: TreeItemProps) {
  const [expanded, setExpanded] = useState(node.expandedByDefault === true);
  const [children, setChildren] = useState<TreeNodeModel[] | null>(node.children ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const canExpand = node.loadChildren !== undefined || node.children !== undefined;

  const load = useCallback(async () => {
    if (children !== null || node.loadChildren === undefined) return;
    setLoading(true);
    setError(null);
    try {
      setChildren(await node.loadChildren());
    } catch (loadError) {
      setError(loadError);
    } finally {
      setLoading(false);
    }
  }, [children, node.loadChildren]);

  useEffect(() => {
    if (expanded && children === null && node.loadChildren !== undefined) {
      void load();
    }
  }, [expanded, children, node.loadChildren, load]);

  const toggle = () => setExpanded((value) => !value);

  const handleRowClick = () => {
    onSelect(node);
    // Selecting a container also opens it: browsing is one click per level.
    if (canExpand) setExpanded((value) => !value);
  };

  const isSelected = selectedId === node.id;
  const indent = { paddingLeft: `${6 + depth * 14}px` };
  const glyph = node.glyph ?? DEFAULT_GLYPHS[node.kind];
  const isNote = node.kind === 'note';

  return (
    <div className="tree-item">
      <div
        className={`tree-row kind-${node.kind}${isSelected ? ' is-selected' : ''}${isNote ? ' is-note' : ''}`}
        style={indent}
        role="treeitem"
        aria-selected={isSelected}
        aria-expanded={canExpand ? expanded : undefined}
        data-node-id={node.id}
        onClick={isNote ? undefined : handleRowClick}
      >
        {canExpand ? (
          <button
            type="button"
            className="tree-chevron"
            tabIndex={-1}
            aria-label={expanded ? 'Collapse' : 'Expand'}
            onClick={(event) => {
              // The chevron toggles without changing the selection.
              event.stopPropagation();
              toggle();
            }}
          >
            {expanded ? '▾' : '▸'}
          </button>
        ) : (
          <span className="tree-chevron" aria-hidden="true" />
        )}
        {glyph !== '' && (
          <span className={`tree-glyph glyph-${node.kind}`} aria-hidden="true">
            {glyph}
          </span>
        )}
        <span className="tree-label">{node.label}</span>
        {node.badge !== undefined && <span className="tree-badge">{node.badge}</span>}
        {node.detail !== undefined && <span className="tree-detail">{node.detail}</span>}
      </div>

      {expanded && (
        <div className="tree-children" role="group">
          {loading && (
            <div className="tree-note" style={{ paddingLeft: `${6 + (depth + 1) * 14}px` }}>
              loading…
            </div>
          )}
          {error !== null && (
            <div className="tree-note is-error" style={{ paddingLeft: `${6 + (depth + 1) * 14}px` }}>
              {errorText(error)}
            </div>
          )}
          {!loading &&
            error === null &&
            children !== null &&
            children.length === 0 && (
              <div className="tree-note" style={{ paddingLeft: `${6 + (depth + 1) * 14}px` }}>
                none
              </div>
            )}
          {children?.map((child) => (
            <TreeItem
              key={child.id}
              node={child}
              depth={depth + 1}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}
