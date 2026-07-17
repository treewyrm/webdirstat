import type { TreemapNode } from "../types";

const PALETTE = [
  "#4C78A8",
  "#F58518",
  "#54A24B",
  "#E45756",
  "#72B7B2",
  "#EECA3B",
  "#B279A2",
  "#FF9DA6",
  "#9D755D",
  "#BAB0AC",
];

function hashString(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Deterministic tile color: directories/symlinks/other get fixed neutral tones, files are colored by extension. */
export function colorFor(node: TreemapNode): string {
  if (node.error) return "#5b1f22";
  if (node.kind === "directory") return "#3a3f4b";
  if (node.kind === "symlink") return "#6b6f7a";
  if (node.kind === "other") return "#4a4e58";

  const ext = extensionOf(node.name);
  if (!ext) return "#8a8f99";
  return PALETTE[hashString(ext) % PALETTE.length]!;
}
