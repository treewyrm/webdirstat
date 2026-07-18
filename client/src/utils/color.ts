import type { NodeKind } from "@webdirstat/shared";

/** The minimal shape needed to pick a color (satisfied by the map's WorldNode). */
export interface Colorable {
  kind: NodeKind | "tail" | "small";
  name: string;
  error?: string;
  /** Modification time, for the age color mode. */
  mtimeMs?: number;
}

/** The neutral tone for the "small files" fold tile (feature 0013) — distinct from the tail tile. */
export const SMALL_TILE_COLOR = "#2c3138";

/** How tiles are colored: by extension identity (default) or by modification age. */
export type ColorMode = "type" | "age";

/** [oldest, newest] mtime present in the visible tree, normalising the age ramp. */
export interface AgeBounds {
  min: number;
  max: number;
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
  if (node.kind === "small") return SMALL_TILE_COLOR;

  return colorForExt(extensionOf(node.name));
}

// A perceptually-uniform, colorblind-safe single-path ramp (viridis endpoints):
// dark cool = old → bright warm = new. Used by the age color mode.
export const AGE_RAMP: readonly string[] = ["#440154", "#21918c", "#fde725"];
const AGE_UNKNOWN = "#4a4e58"; // files with no mtime (stat error) — flat neutral

function lerpHex(a: string, b: string, t: number): string {
  const ar = parseInt(a.slice(1, 3), 16);
  const ag = parseInt(a.slice(3, 5), 16);
  const ab = parseInt(a.slice(5, 7), 16);
  const br = parseInt(b.slice(1, 3), 16);
  const bg = parseInt(b.slice(3, 5), 16);
  const bb = parseInt(b.slice(5, 7), 16);
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return `#${((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1)}`;
}

/** Sample a multi-stop ramp at `t` in [0,1]. */
function sampleRamp(stops: readonly string[], t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  const seg = clamped * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(seg));
  return lerpHex(stops[i]!, stops[i + 1]!, seg - i);
}

/**
 * Color a file by modification age against the tree's [oldest, newest] bounds.
 * Log-scaled on age (now − mtime) — most files cluster recent, a few are ancient —
 * so newest maps to the bright end, oldest to the dark end.
 */
export function colorByAge(mtimeMs: number | undefined, bounds: AgeBounds, now: number = Date.now()): string {
  if (mtimeMs == null) return AGE_UNKNOWN;
  const ageNewest = Math.max(1, now - bounds.max);
  const ageOldest = Math.max(1, now - bounds.min);
  const age = Math.max(1, now - mtimeMs);
  const lo = Math.log(ageNewest);
  const hi = Math.log(ageOldest);
  const t = hi > lo ? (hi - Math.log(age)) / (hi - lo) : 1; // 1 = newest → bright end
  return sampleRamp(AGE_RAMP, t);
}

/**
 * The tile fill for the active color mode. In **age** mode, plain files are colored
 * by mtime; directories/symlinks/other/tail and errored files keep their neutral
 * type tones. In **type** mode (or with no bounds yet), falls back to `colorFor`.
 */
export function fillFor(node: Colorable, mode: ColorMode, bounds: AgeBounds | null): string {
  if (mode === "age" && bounds && node.kind === "file" && !node.error) {
    return colorByAge(node.mtimeMs, bounds);
  }
  return colorFor(node);
}
