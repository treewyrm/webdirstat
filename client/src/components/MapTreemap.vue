<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { select } from "d3-selection";
import { zoom, zoomIdentity, type D3ZoomEvent, type ZoomBehavior, type ZoomTransform } from "d3-zoom";
import type { TreeChild, TreeSlice } from "@webdirstat/shared";
import { fetchTreeBatch } from "../api";
import { colorFor } from "../utils/color";
import { useDisplaySettings } from "../composables/useDisplaySettings";
import { indexById, layoutInto, makeRoot, type WorldNode } from "../treemap/layout";

const { settings } = useDisplaySettings();

const props = defineProps<{ rootId: string; seed: TreeSlice }>();
const emit = defineEmits<{
  focus: [{ chain: Array<{ id: number; name: string; path: string }>; children: TreeChild[]; size: number }];
  hover: [WorldNode | null];
  stale: [];
}>();

// LOD + interaction tuning.
const EXPAND_PX = 24; // min on-screen size before a directory shows its interior
const LABEL_MIN_W = 44;
const LABEL_MIN_H = 15;
const PLAN_DEBOUNCE = 120;
const FLY_MS = 450;
const FLY_COVER = 1.03; // descend fills the viewport with the target (folder ⊇ viewport) so it becomes the current folder
const SPINE_DEPTH = 3;
const BATCH_LIMIT = 200;
const LOAD_CAP = 600;
const MAX_BATCH_REQUESTS = 64; // server rejects a batch with more requests than this (POST /api/tree/batch)

const wrapperRef = ref<HTMLDivElement | null>(null);
const canvasRef = ref<HTMLCanvasElement | null>(null);

let worldRoot: WorldNode | null = null;
let index = new Map<number, WorldNode>();
let transform: ZoomTransform = zoomIdentity;
let zoomBehavior: ZoomBehavior<HTMLCanvasElement, unknown> | null = null;
let cw = 0;
let ch = 0;
let dpr = 1;
let frame = 0;

const pending = new Set<number>();
let fetchController: AbortController | null = null;
let planTimer: ReturnType<typeof setTimeout> | null = null;
let drawScheduled = false;
let drewShimmer = false;
let resizeObserver: ResizeObserver | undefined;
let flyRaf: number | null = null;

// --- lifecycle ---

onMounted(() => {
  const canvas = canvasRef.value!;
  measure();
  zoomBehavior = zoom<HTMLCanvasElement, unknown>().scaleExtent([0.05, 5_000_000]).on("zoom", onZoom);
  select(canvas).call(zoomBehavior);
  canvas.addEventListener("mousemove", onMouseMove);
  canvas.addEventListener("mouseleave", () => emit("hover", null));
  canvas.addEventListener("click", onClick);
  resizeObserver = new ResizeObserver(onResize);
  if (wrapperRef.value) resizeObserver.observe(wrapperRef.value);
  reseed();
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  fetchController?.abort();
  if (planTimer) clearTimeout(planTimer);
  if (flyRaf) cancelAnimationFrame(flyRaf);
});

// Reseed whenever the root slice identity changes (new root or new generation).
watch(() => props.seed, reseed);

// Flat/Shaded is a pure rendering-layer change — just repaint, no refetch/relayout.
watch(() => settings.shaded, scheduleDraw);

function measure(): void {
  const wrapper = wrapperRef.value!;
  const canvas = canvasRef.value!;
  dpr = window.devicePixelRatio || 1;
  cw = wrapper.clientWidth;
  ch = wrapper.clientHeight;
  canvas.width = Math.round(cw * dpr);
  canvas.height = Math.round(ch * dpr);
  canvas.style.width = `${cw}px`;
  canvas.style.height = `${ch}px`;
}

function reseed(): void {
  fetchController?.abort();
  pending.clear();
  if (!wrapperRef.value || cw === 0) measure();
  worldRoot = makeRoot(props.seed.node, { x0: 0, y0: 0, x1: cw || 1, y1: ch || 1 });
  layoutInto(worldRoot, props.seed.children, props.seed.omittedTail);
  index = indexById(worldRoot);
  // Reset the camera to identity.
  transform = zoomIdentity;
  if (zoomBehavior && canvasRef.value) select(canvasRef.value).call(zoomBehavior.transform, zoomIdentity);
  scheduleDraw();
  schedulePlan();
  emitFocus();
}

function onResize(): void {
  measure();
  scheduleDraw();
  schedulePlan();
}

// --- camera ---

function onZoom(event: D3ZoomEvent<HTMLCanvasElement, unknown>): void {
  transform = event.transform;
  scheduleDraw();
  schedulePlan();
}

// --- drawing (level of detail) ---

function scheduleDraw(): void {
  if (drawScheduled) return;
  drawScheduled = true;
  requestAnimationFrame(() => {
    drawScheduled = false;
    draw();
  });
}

function draw(): void {
  const canvas = canvasRef.value;
  const ctx = canvas?.getContext("2d");
  if (!ctx || !worldRoot) return;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  frame++;
  drewShimmer = false;

  drawNode(ctx, worldRoot);

  // Keep animating while any shimmer placeholder is on screen (the gradient pan).
  if (drewShimmer) scheduleDraw();
}

function drawNode(ctx: CanvasRenderingContext2D, node: WorldNode): void {
  const { k, x, y } = transform;
  const sx0 = k * node.x0 + x;
  const sy0 = k * node.y0 + y;
  const sx1 = k * node.x1 + x;
  const sy1 = k * node.y1 + y;
  if (sx1 < 0 || sy1 < 0 || sx0 > cw || sy0 > ch) return; // off-screen
  const w = sx1 - sx0;
  const h = sy1 - sy0;
  if (w < 0.4 || h < 0.4) return;

  const expandable = node.kind === "directory" && node.childCount > 0;
  const bigEnough = w > EXPAND_PX && h > EXPAND_PX;

  if (expandable && bigEnough) {
    node.touched = frame;
    if (node.children === null) {
      drawShimmer(ctx, sx0, sy0, w, h, node);
      return;
    }
    for (const child of node.children) drawNode(ctx, child);
    drawDirFrame(ctx, sx0, sy0, w, h, node);
    return;
  }

  drawTile(ctx, sx0, sy0, w, h, node);
}

function drawTile(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, node: WorldNode): void {
  if (node.kind === "tail") {
    ctx.fillStyle = "#23272f";
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.setLineDash([]);
  } else {
    ctx.fillStyle = colorFor(node);
    ctx.fillRect(x, y, w, h);
    // Cushion look: overlay a cached, color-independent light/shadow sprite (feature
    // 0010). One drawImage per tile — cheaper than a per-tile gradient, and the base
    // color still shows through the translucent overlay.
    if (settings.shaded && w > 3 && h > 3) ctx.drawImage(cushionSprite(), x, y, w, h);
    if (w > 3 && h > 3) drawTileBorder(ctx, x, y, w, h);
  }
  drawLabel(ctx, x, y, w, h, node);
}

/**
 * Separator drawn on a tile's top and left edges only. A boundary shared by two
 * adjacent tiles is thus painted once (by the lower/right neighbor), not twice —
 * so no doubled 2px seam. A directory's outer right/bottom edge is covered by its
 * `drawDirFrame` rect; the map's outermost edge is the canvas edge. Coordinates are
 * snapped to device pixels (`lineWidth = 1/dpr`) so each seam is one crisp device pixel.
 */
function drawTileBorder(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  const lx = crisp(x);
  const ty = crisp(y);
  ctx.strokeStyle = "rgba(0,0,0,0.5)";
  ctx.lineWidth = 1 / dpr;
  ctx.beginPath();
  ctx.moveTo(lx, y);
  ctx.lineTo(lx, y + h); // left edge
  ctx.moveTo(x, ty);
  ctx.lineTo(x + w, ty); // top edge
  ctx.stroke();
}

/** Snap a CSS-space coordinate to a device-pixel center so a 1/dpr line stays crisp. */
function crisp(coord: number): number {
  return (Math.round(coord * dpr) + 0.5) / dpr;
}

// Built once, reused for every shaded tile: a soft top-left specular highlight plus
// all-edge darkening that reads as a raised pillow when stretched over any tile. It's
// color-independent (pure white/black alpha), so it composes over the flat base fill
// with source-over and needs no per-color cache.
let cushionCanvas: HTMLCanvasElement | null = null;
function cushionSprite(): HTMLCanvasElement {
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

function drawDirFrame(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, node: WorldNode): void {
  ctx.strokeStyle = "rgba(0,0,0,0.5)";
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  // A slim header strip with the folder name so nesting stays legible.
  if (w > 60 && h > 22) {
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(x + 1, y + 1, w - 2, 14);
    drawLabel(ctx, x, y, w, 15, node, "rgba(255,255,255,0.85)");
  }
}

function drawLabel(
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

function drawShimmer(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, node: WorldNode): void {
  drewShimmer = true;
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

// --- lazy tile fetching ---

function schedulePlan(): void {
  if (planTimer) clearTimeout(planTimer);
  planTimer = setTimeout(() => {
    planTimer = null;
    void planFetches();
    emitFocus();
  }, PLAN_DEBOUNCE);
}

/** Collects visible, big-enough, unloaded directories and fetches them in one batch. */
function collectNeeded(node: WorldNode, out: number[]): void {
  const { k, x, y } = transform;
  const sx0 = k * node.x0 + x;
  const sy0 = k * node.y0 + y;
  const w = k * (node.x1 - node.x0);
  const h = k * (node.y1 - node.y0);
  if (sx0 + w < 0 || sy0 + h < 0 || sx0 > cw || sy0 > ch) return;

  const expandable = node.kind === "directory" && node.childCount > 0;
  if (expandable && w > EXPAND_PX && h > EXPAND_PX) {
    if (node.children === null) {
      if (!pending.has(node.id)) out.push(node.id);
      return; // its (unfetched) interior can't be walked further
    }
    for (const child of node.children) collectNeeded(child, out);
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function planFetches(): Promise<void> {
  if (!worldRoot) return;
  evictIfNeeded();
  const needed: number[] = [];
  collectNeeded(worldRoot, needed);
  if (needed.length === 0) return;

  fetchController?.abort();
  const controller = new AbortController();
  fetchController = controller;
  for (const id of needed) pending.add(id);

  try {
    // The server caps a batch at MAX_BATCH_REQUESTS directories, so a dense frame is
    // split across parallel requests (all under the one abort controller).
    const responses = await Promise.all(
      chunk(needed, MAX_BATCH_REQUESTS).map((ids) =>
        fetchTreeBatch(
          props.rootId,
          props.seed.generation,
          ids.map((id) => ({ parentId: id, limit: BATCH_LIMIT })),
          controller.signal,
        ),
      ),
    );
    for (const response of responses) applyBatch(response.nodes);
  } catch (error) {
    if (controller.signal.aborted) return; // superseded by a newer camera frame
    if (error instanceof Error && /410|Gone/.test(error.message)) {
      emit("stale");
      return;
    }
    console.error(error);
  } finally {
    for (const id of needed) pending.delete(id);
    if (fetchController === controller) fetchController = null;
  }
  scheduleDraw();
  schedulePlan();
}

/** Applies a batch response, laying out newly-fetched directories level by level. */
function applyBatch(nodes: Record<string, { children: TreeChild[]; childCount: number; omittedTail?: { count: number; bytes: number } }>): void {
  let changed = true;
  let passes = 0;
  while (changed && passes++ < SPINE_DEPTH + 2) {
    changed = false;
    for (const [idStr, entry] of Object.entries(nodes)) {
      const node = index.get(Number(idStr));
      if (node && node.children === null) {
        layoutInto(node, entry.children, entry.omittedTail);
        changed = true;
      }
    }
    if (changed) index = indexById(worldRoot!);
  }
}

/** Bounds memory: drop the least-recently-drawn loaded interiors when over the cap. */
function evictIfNeeded(): void {
  const loaded: WorldNode[] = [];
  for (const node of index.values()) {
    if (node.kind === "directory" && node.children && node.depth > 0) loaded.push(node);
  }
  if (loaded.length <= LOAD_CAP) return;
  loaded.sort((a, b) => a.touched - b.touched);
  const toDrop = loaded.slice(0, loaded.length - LOAD_CAP);
  for (const node of toDrop) {
    if (node.touched === frame) continue; // keep what's on screen right now
    node.children = null;
  }
  index = indexById(worldRoot!);
}

// --- hit testing + interaction ---

function hitTest(worldX: number, worldY: number): WorldNode | null {
  if (!worldRoot) return null;
  let node: WorldNode = worldRoot;
  for (;;) {
    const expanded =
      node.kind === "directory" &&
      node.children &&
      transform.k * (node.x1 - node.x0) > EXPAND_PX &&
      transform.k * (node.y1 - node.y0) > EXPAND_PX;
    if (!expanded || !node.children) return node;
    const child = node.children.find((c) => worldX >= c.x0 && worldX < c.x1 && worldY >= c.y0 && worldY < c.y1);
    if (!child) return node;
    node = child;
  }
}

function nodeAtEvent(event: MouseEvent): WorldNode | null {
  const worldX = (event.offsetX - transform.x) / transform.k;
  const worldY = (event.offsetY - transform.y) / transform.k;
  return hitTest(worldX, worldY);
}

function onMouseMove(event: MouseEvent): void {
  emit("hover", nodeAtEvent(event));
}

function onClick(event: MouseEvent): void {
  const node = nodeAtEvent(event);
  if (node && node.kind === "directory" && node.childCount > 0) flyTo(node);
}

// --- fly-to (camera animation) ---

function targetTransformFor(node: WorldNode): ZoomTransform {
  const nodeW = node.x1 - node.x0;
  const nodeH = node.y1 - node.y0;
  // Cover-fit (max ratio), not fit-inside (min): the target must fully *contain* the
  // viewport to become the current folder in emitFocus. A hair of overscan (FLY_COVER)
  // keeps float rounding from leaving the viewport a pixel outside the folder rect.
  const k = Math.max(0.05, Math.min(5_000_000, FLY_COVER * Math.max(cw / nodeW, ch / nodeH)));
  const cx = (node.x0 + node.x1) / 2;
  const cy = (node.y0 + node.y1) / 2;
  return zoomIdentity.translate(cw / 2 - k * cx, ch / 2 - k * cy).scale(k);
}

function flyTo(node: WorldNode): void {
  if (!zoomBehavior || !canvasRef.value) return;
  const target = targetTransformFor(node);
  const start = transform;
  const startTime = performance.now();
  if (flyRaf) cancelAnimationFrame(flyRaf);

  // Prefetch the spine at the destination so it isn't a waterfall of shimmer.
  void prefetchSpine(node);

  const step = () => {
    const t = Math.min(1, (performance.now() - startTime) / FLY_MS);
    const ease = t * (2 - t); // easeOutQuad
    const k = start.k + (target.k - start.k) * ease;
    const x = start.x + (target.x - start.x) * ease;
    const yy = start.y + (target.y - start.y) * ease;
    select(canvasRef.value!).call(zoomBehavior!.transform, zoomIdentity.translate(x, yy).scale(k));
    if (t < 1) flyRaf = requestAnimationFrame(step);
    else flyRaf = null;
  };
  flyRaf = requestAnimationFrame(step);
}

async function prefetchSpine(node: WorldNode): Promise<void> {
  if (node.children !== null && node.children.every((c) => c.children !== null || c.kind !== "directory")) return;
  try {
    const response = await fetchTreeBatch(props.rootId, props.seed.generation, [
      { parentId: node.id, depth: SPINE_DEPTH, limit: BATCH_LIMIT },
    ]);
    applyBatch(response.nodes);
    scheduleDraw();
  } catch {
    // best-effort; the settle planner will fill in tiles anyway
  }
}

/** Flies to the node at a relative path, if it is present in the laid-out tree. */
function flyToPath(path: string): void {
  if (!worldRoot) return;
  let node: WorldNode = worldRoot;
  if (path) {
    for (const segment of path.split("/").filter(Boolean)) {
      const child = node.children?.find((c) => c.kind !== "tail" && c.name === segment);
      if (!child) break;
      node = child;
    }
  }
  flyTo(node);
}

defineExpose({ flyToPath });

// --- camera-derived focus (breadcrumbs + list) ---

function emitFocus(): void {
  if (!worldRoot) return;
  // "Current folder" = the deepest directory whose world rect fully contains the
  // viewport (i.e. the folder that fills your view), not just covers its center.
  const vx0 = (0 - transform.x) / transform.k;
  const vy0 = (0 - transform.y) / transform.k;
  const vx1 = (cw - transform.x) / transform.k;
  const vy1 = (ch - transform.y) / transform.k;
  const chain: WorldNode[] = [worldRoot];
  let node = worldRoot;
  for (;;) {
    if (!node.children) break;
    const child = node.children.find(
      (c) => c.kind === "directory" && c.x0 <= vx0 && c.y0 <= vy0 && c.x1 >= vx1 && c.y1 >= vy1,
    );
    if (!child) break;
    chain.push(child);
    node = child;
  }
  const focusNode = chain[chain.length - 1]!;
  const children: TreeChild[] = (focusNode.children ?? [])
    .filter((c) => c.kind !== "tail")
    .map((c) => ({
      id: c.id,
      name: c.name,
      kind: c.kind === "tail" ? "other" : c.kind,
      size: c.size,
      childCount: c.childCount,
      ...(c.ext != null ? { ext: c.ext } : {}),
      ...(c.error != null ? { error: c.error } : {}),
    }));
  emit("focus", {
    chain: chain.map((c) => ({ id: c.id, name: c.name, path: c.path })),
    children,
    size: focusNode.size,
  });
}
</script>

<template>
  <div ref="wrapperRef" class="map-wrapper">
    <canvas ref="canvasRef"></canvas>
  </div>
</template>

<style scoped>
.map-wrapper {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

canvas {
  display: block;
  cursor: pointer;
}
</style>
