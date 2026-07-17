import type { NodeKind } from "@webdirstat/shared";

/**
 * The node shape the treemap and list pane render. In milestone 1 the client holds
 * only the currently-focused directory and its direct children (one store slice) —
 * `children` are leaves from the treemap's perspective, so it draws one level. The
 * full lazy nested layout (feature 0002) arrives in milestone 4.
 */
export interface TreemapNode {
  /** Store id (generation-scoped); absent on the synthetic focus wrapper. */
  id?: number;
  name: string;
  kind: NodeKind;
  size: number;
  /** Direct children count (directories); drives whether a tile is drillable. */
  childCount: number;
  ext?: string;
  error?: string;
  children?: TreemapNode[];
}
