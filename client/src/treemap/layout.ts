import { hierarchy, treemap, treemapSquarify } from "d3-hierarchy";
import type { FoldedSmall, NodeKind, OmittedTail, TreeChild } from "@webdirstat/shared";
import { formatBytes } from "../utils/format";

/**
 * One node in the lazily-laid-out world tree. Coordinates are in a fixed "world"
 * space; the camera maps world → screen. `children === null` means the interior
 * hasn't been fetched/laid out yet (a tile to fetch when zoom reveals it).
 */
export interface WorldNode {
  id: number;
  name: string;
  /**
   * Synthetic tile kinds beyond the real filesystem ones: "tail" is the remainder
   * for children past the slice cap; "small" is the fold of sub-threshold files
   * (feature 0013), whose `foldedParentId` points at the directory to re-fetch
   * unfolded on click.
   */
  kind: NodeKind | "tail" | "small";
  size: number;
  childCount: number;
  ext?: string;
  error?: string;
  /** Modification time (ms), when known — drives the age color mode. */
  mtimeMs?: number;
  /** Relative path from the root ("" for the root). */
  path: string;
  depth: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  children: WorldNode[] | null;
  omittedTail?: OmittedTail;
  /** For a "small" tile: the id of the directory whose sub-threshold files it folds. */
  foldedParentId?: number;
  /** Last frame this node's interior was drawn — drives LRU eviction. */
  touched: number;
}

interface LayoutItem {
  child?: TreeChild;
  tail?: OmittedTail;
  small?: FoldedSmall;
}

/** Creates the root world node filling the given world rect (interior unloaded). */
export function makeRoot(
  node: { id: number; name: string; kind: NodeKind; size: number; childCount: number },
  rect: { x0: number; y0: number; x1: number; y1: number },
): WorldNode {
  return {
    id: node.id,
    name: node.name,
    kind: node.kind,
    size: node.size,
    childCount: node.childCount,
    path: "",
    depth: 0,
    ...rect,
    children: null,
    touched: 0,
  };
}

/**
 * Squarifies one directory level into `node`'s world rect and attaches the child
 * WorldNodes (interiors still unloaded). A capped slice's omitted tail becomes a
 * proportional remainder tile so layout stays stable when the rest never loads.
 */
export function layoutInto(
  node: WorldNode,
  rows: TreeChild[],
  omittedTail: OmittedTail | undefined,
  foldedSmall?: FoldedSmall,
  minSize = 0,
): void {
  const w = node.x1 - node.x0;
  const h = node.y1 - node.y0;
  node.omittedTail = omittedTail;
  if (w <= 0 || h <= 0 || node.size <= 0) {
    node.children = [];
    return;
  }

  const items: LayoutItem[] = rows.map((child) => ({ child }));
  if (omittedTail && omittedTail.count > 0 && omittedTail.bytes > 0) items.push({ tail: omittedTail });
  if (foldedSmall && foldedSmall.count > 0 && foldedSmall.bytes > 0) items.push({ small: foldedSmall });

  const root = hierarchy<{ items?: LayoutItem[] } | LayoutItem>({ items }, (d) => ("items" in d ? d.items : undefined))
    .sum((d) =>
      "child" in d && d.child
        ? d.child.size
        : "tail" in d && d.tail
          ? d.tail.bytes
          : "small" in d && d.small
            ? d.small.bytes
            : 0,
    )
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

  const laid = treemap<{ items?: LayoutItem[] } | LayoutItem>()
    .tile(treemapSquarify)
    .paddingInner(0)
    .round(false)
    .size([w, h])(root);

  const children: WorldNode[] = [];
  for (const leaf of laid.leaves()) {
    const item = leaf.data as LayoutItem;
    const rect = { x0: node.x0 + leaf.x0, y0: node.y0 + leaf.y0, x1: node.x0 + leaf.x1, y1: node.y0 + leaf.y1 };
    if (item.tail) {
      children.push({
        id: -1,
        name: `+${item.tail.count} smaller`,
        kind: "tail",
        size: item.tail.bytes,
        childCount: 0,
        path: node.path,
        depth: node.depth + 1,
        ...rect,
        children: [],
        touched: 0,
      });
    } else if (item.small) {
      children.push({
        id: -2,
        name: `+${item.small.count} under ${formatBytes(minSize)}`,
        kind: "small",
        size: item.small.bytes,
        childCount: 0,
        path: node.path,
        depth: node.depth + 1,
        foldedParentId: node.id,
        ...rect,
        children: [],
        touched: 0,
      });
    } else {
      const c = item.child!;
      children.push({
        id: c.id,
        name: c.name,
        kind: c.kind,
        size: c.size,
        childCount: c.childCount,
        ...(c.ext != null ? { ext: c.ext } : {}),
        ...(c.error != null ? { error: c.error } : {}),
        ...(c.mtimeMs != null ? { mtimeMs: c.mtimeMs } : {}),
        path: node.path ? `${node.path}/${c.name}` : c.name,
        depth: node.depth + 1,
        ...rect,
        children: c.kind === "directory" && c.childCount > 0 ? null : [],
        touched: 0,
      });
    }
  }
  node.children = children;
}

/** Depth-first index of every node currently in the world tree, keyed by id. */
export function indexById(root: WorldNode, into: Map<number, WorldNode> = new Map()): Map<number, WorldNode> {
  into.set(root.id, root);
  if (root.children) for (const child of root.children) indexById(child, into);
  return into;
}
