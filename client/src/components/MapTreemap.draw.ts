// Pure rendering + geometry helpers extracted from MapTreemap.vue. Everything here is
// stateless with respect to the component (no reactive Vue state, no camera/index
// closures): each function takes the canvas context plus whatever geometry, node, and
// style it needs, so the component's draw loop stays the only place that reads the
// live camera/settings. The one exception is the cushion sprite, a process-wide cache.

import { zoomIdentity, type ZoomTransform } from "d3-zoom";
import { fillFor, SMALL_TILE_COLOR, type AgeBounds, type ColorMode } from "../utils/color";
import type { WorldNode } from "../treemap/layout";

// Camera scale clamp, shared by the zoom behavior's scaleExtent and fly-to targeting.
export const MIN_SCALE = 0.05;
export const MAX_SCALE = 5_000_000;

// Below these on-screen sizes a tile shows no text label.
const LABEL_MIN_W = 44;
const LABEL_MIN_H = 15;

/** Split `items` into consecutive chunks of at most `size`. */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Snap a CSS-space coordinate to a device-pixel center so a 1/dpr line stays crisp. */
export function crisp(coord: number, dpr: number): number {
  return (Math.round(coord * dpr) + 0.5) / dpr;
}

/**
 * Camera transform that cover-fits `node` into the cw×ch viewport. Cover-fit (max
 * ratio), not fit-inside (min): the target must fully *contain* the viewport to become
 * the current folder. `cover` adds a hair of overscan so float rounding doesn't leave
 * the viewport a pixel outside the folder rect.
 */
export function targetTransformFor(node: WorldNode, cw: number, ch: number, cover: number): ZoomTransform {
  const nodeW = node.x1 - node.x0;
  const nodeH = node.y1 - node.y0;
  const k = Math.max(MIN_SCALE, Math.min(MAX_SCALE, cover * Math.max(cw / nodeW, ch / nodeH)));
  const cx = (node.x0 + node.x1) / 2;
  const cy = (node.y0 + node.y1) / 2;
  return zoomIdentity.translate(cw / 2 - k * cx, ch / 2 - k * cy).scale(k);
}

// Built once, reused for every shaded tile: a soft top-left specular highlight plus
// all-edge darkening that reads as a raised pillow when stretched over any tile. It's
// color-independent (pure white/black alpha), so it composes over the flat base fill
// with source-over and needs no per-color cache.
let cushionCanvas: HTMLCanvasElement | null = null;
export function cushionSprite(): HTMLCanvasElement {
  if (cushionCanvas) return cushionCanvas;
  const s = 128;
  const c = document.createElement("canvas");
  c.width = s;
  c.height = s;
  const g = c.getContext("2d")!;
  // Edge shadow: dark toward the rim so the tile appears to bulge upward.
  const edge = g.createRadialGradient(s / 2, s / 2, s * 0.12, s / 2, s / 2, s * 0.72);
  edge.addColorStop(0, "rgba(0,0,0,0)");
  edge.addColorStop(1, "rgba(0,0,0,0.32)");
  g.fillStyle = edge;
  g.fillRect(0, 0, s, s);
  // Specular highlight offset toward a fixed top-left light.
  const spec = g.createRadialGradient(s * 0.32, s * 0.3, 0, s * 0.32, s * 0.3, s * 0.62);
  spec.addColorStop(0, "rgba(255,255,255,0.35)");
  spec.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = spec;
  g.fillRect(0, 0, s, s);
  cushionCanvas = c;
  return cushionCanvas;
}

export function drawLabel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  node: WorldNode,
  color = "rgba(255,255,255,0.9)",
): void {
  if (w < LABEL_MIN_W || h < LABEL_MIN_H) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.fillStyle = color;
  ctx.font = "11px sans-serif";
  ctx.fillText(node.name, x + 3, y + 11);
  ctx.restore();
}

/**
 * Separator drawn on a tile's top and left edges only. A boundary shared by two
 * adjacent tiles is thus painted once (by the lower/right neighbor), not twice —
 * so no doubled 2px seam. A directory's outer right/bottom edge is covered by its
 * `drawDirFrame` rect; the map's outermost edge is the canvas edge. Coordinates are
 * snapped to device pixels (`lineWidth = 1/dpr`) so each seam is one crisp device pixel.
 */
export function drawTileBorder(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  dpr: number,
): void {
  const lx = crisp(x, dpr);
  const ty = crisp(y, dpr);
  ctx.strokeStyle = "rgba(0,0,0,0.5)";
  ctx.lineWidth = 1 / dpr;
  ctx.beginPath();
  ctx.moveTo(lx, y);
  ctx.lineTo(lx, y + h); // left edge
  ctx.moveTo(x, ty);
  ctx.lineTo(x + w, ty); // top edge
  ctx.stroke();
}

export function drawDirFrame(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  node: WorldNode,
  dpr: number,
): void {
  // Same top+left, device-pixel seam as leaf tiles, so a folder's border is a single
  // crisp pixel too — no doubled seam against a sibling folder's frame or its own tiles.
  drawTileBorder(ctx, x, y, w, h, dpr);
  // A slim header strip with the folder name so nesting stays legible.
  if (w > 60 && h > 22) {
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(x + 1, y + 1, w - 2, 14);
    drawLabel(ctx, x, y, w, 15, node, "rgba(255,255,255,0.85)");
  }
}

/** The camera/color context a leaf tile needs to paint itself. */
export interface TileStyle {
  colorMode: ColorMode;
  ageBounds: AgeBounds | null;
  shaded: boolean;
  dpr: number;
}

export function drawTile(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  node: WorldNode,
  style: TileStyle,
): void {
  if (node.kind === "tail" || node.kind === "small") {
    // Both synthetic aggregate tiles get a dashed neutral fill; the "small" fold
    // (feature 0013) uses a distinct tone so it reads apart from the count-cap tail.
    ctx.fillStyle = node.kind === "small" ? SMALL_TILE_COLOR : "#23272f";
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.setLineDash([]);
  } else {
    ctx.fillStyle = fillFor(node, style.colorMode, style.ageBounds);
    ctx.fillRect(x, y, w, h);
    // Cushion look: overlay a cached, color-independent light/shadow sprite (feature
    // 0010). One drawImage per tile — cheaper than a per-tile gradient, and the base
    // color still shows through the translucent overlay.
    if (style.shaded && w > 3 && h > 3) ctx.drawImage(cushionSprite(), x, y, w, h);
    if (w > 3 && h > 3) drawTileBorder(ctx, x, y, w, h, style.dpr);
  }
  drawLabel(ctx, x, y, w, h, node);
}

export function drawShimmer(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  node: WorldNode,
): void {
  ctx.fillStyle = "#2c313c";
  ctx.fillRect(x, y, w, h);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  // A translucent band panning left→right on a loop.
  const span = w + 160;
  const bandX = x - 80 + ((performance.now() / 900) % 1) * span;
  const grad = ctx.createLinearGradient(bandX - 80, 0, bandX + 80, 0);
  grad.addColorStop(0, "rgba(255,255,255,0)");
  grad.addColorStop(0.5, "rgba(255,255,255,0.10)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
  drawLabel(ctx, x, y, w, h, node, "rgba(255,255,255,0.55)");
}
