import type { NodeKind } from "@webdirstat/shared";

/** The minimal shape needed to pick a color (satisfied by the map's WorldNode). */
export interface Colorable {
  kind: NodeKind | "tail";
  name: string;
  error?: string;
}

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

/** The file color for a bare (lowercased, dot-less) extension; "" is the extension-less tone. */
export function colorForExt(ext: string): string {
  if (!ext) return "#8a8f99";
  return PALETTE[hashString(ext) % PALETTE.length]!;
}

/** A stable palette swatch for an arbitrary label — used for grouped type families,
 * which span several extensions and so have no single tile color to match. */
export function colorForFamily(label: string): string {
  return PALETTE[hashString(label) % PALETTE.length]!;
}

/** Deterministic tile color: directories/symlinks/other get fixed neutral tones, files are colored by extension. */
export function colorFor(node: Colorable): string {
  if (node.error) return "#5b1f22";
  if (node.kind === "directory") return "#3a3f4b";
  if (node.kind === "symlink") return "#6b6f7a";
  if (node.kind === "other") return "#4a4e58";

  return colorForExt(extensionOf(node.name));
}
