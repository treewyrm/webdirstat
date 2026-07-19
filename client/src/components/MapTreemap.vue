<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { select } from "d3-selection";
import { zoom, zoomIdentity, type D3ZoomEvent, type ZoomBehavior, type ZoomTransform } from "d3-zoom";
import type { TreeChild, TreeSlice } from "@webdirstat/shared";
import { fetchTreeBatch } from "../api";
import { type AgeBounds } from "../utils/color";
import { useDisplaySettings } from "../composables/useDisplaySettings";
import { indexById, layoutInto, makeRoot, type WorldNode } from "../treemap/layout";
import {
  chunk,
  drawDirFrame,
  drawShimmer,
  drawTile,
  MAX_SCALE,
  MIN_SCALE,
  targetTransformFor,
} from "./MapTreemap.draw";

const { settings } = useDisplaySettings();

const props = defineProps<{ rootId: string; seed: TreeSlice; highlightId?: number | null }>();
const emit = defineEmits<{
  focus: [
    {
      chain: Array<{ id: number; name: string; path: string }>;
      children: TreeChild[];
      size: number;
      omittedTail?: { count: number; bytes: number };
    },
  ];
  hover: [WorldNode | null];
  stale: [];
  agebounds: [AgeBounds | null];
}>();

// LOD + interaction tuning.
const EXPAND_PX = 24; // min on-screen size before a directory shows its interior
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

// Running [oldest, newest] mtime across every tile the client has laid out, which
// normalises the age color ramp (feature 0011). Widens as more tiles load; the map
// emits the bounds so App can draw the gradient legend.
let ageMin = Infinity;
let ageMax = -Infinity;

const pending = new Set<number>();
// Directories the user explicitly unfolded (feature 0013): fetched with minSize 0
// so their sub-threshold files show individually, overriding the global fold. Reset
// on reseed (a new generation invalidates the ids). Empty while folding is off.
const unfolded = new Set<number>();
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
  zoomBehavior = zoom<HTMLCanvasElement, unknown>().scaleExtent([MIN_SCALE, MAX_SCALE]).on("zoom", onZoom);
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

// List-row hover (feature 0012) is a pure overlay repaint — coalesce into the RAF.
watch(() => props.highlightId, scheduleDraw);

// Type/Age color mode is also a pure repaint; re-emit bounds so the legend is ready.
watch(
  () => settings.colorMode,
  () => {
    emit("agebounds", ageBounds());
    scheduleDraw();
  },
);

/** The current age bounds, or null until at least one tile with an mtime has loaded. */
function ageBounds(): AgeBounds | null {
  return ageMax >= ageMin ? { min: ageMin, max: ageMax } : null;
}

/** Widen the running mtime bounds over a freshly laid-out level; emit if they moved. */
function noteAgeBounds(rows: TreeChild[]): void {
  let changed = false;
  for (const row of rows) {
    if (row.mtimeMs == null) continue;
    if (row.mtimeMs < ageMin) (ageMin = row.mtimeMs), (changed = true);
    if (row.mtimeMs > ageMax) (ageMax = row.mtimeMs), (changed = true);
  }
  if (changed) {
    emit("agebounds", ageBounds());
    if (settings.colorMode === "age") scheduleDraw();
  }
}

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

// Identifies the tree currently laid out, so reseed can tell a genuinely new tree
// (new root/generation → reset camera) from a same-tree re-seed (e.g. changing the
// fold threshold → keep the camera).
let renderedKey: string | null = null;

function reseed(): void {
  fetchController?.abort();
  pending.clear();
  unfolded.clear();
  // Same root+generation means the directory framing is identical (only interiors
  // re-fold, feature 0013), so retain the camera instead of snapping to identity and
  // throwing away the user's zoom. A real new root/generation resets the view.
  const key = `${props.rootId}@${props.seed.generation}`;
  const keepCamera = worldRoot != null && renderedKey === key;
  renderedKey = key;
  // New tree: forget the old mtime span before re-accumulating from this seed.
  ageMin = Infinity;
  ageMax = -Infinity;
  emit("agebounds", null);
  if (!wrapperRef.value || cw === 0) measure();
  worldRoot = makeRoot(props.seed.node, { x0: 0, y0: 0, x1: cw || 1, y1: ch || 1 });
  layoutInto(worldRoot, props.seed.children, props.seed.omittedTail, props.seed.foldedSmall, settings.minSize);
  noteAgeBounds(props.seed.children);
  index = indexById(worldRoot);
  // Re-apply the transform (retained or reset) so d3-zoom's internal state matches.
  if (!keepCamera) transform = zoomIdentity;
  if (zoomBehavior && canvasRef.value) select(canvasRef.value).call(zoomBehavior.transform, transform);
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

  if (props.highlightId != null) drawHighlight(ctx, props.highlightId);

  // Keep animating while any shimmer placeholder is on screen (the gradient pan).
  if (drewShimmer) scheduleDraw();
}

/**
 * List → map highlight (feature 0012). Outlines the tile whose id the pointer is on
 * in the file-list pane, when it's laid out and on screen; a miss (collapsed or
 * panned off) simply draws nothing. A dark backing stroke under a bright accent keeps
 * it legible over any tile fill.
 */
function drawHighlight(ctx: CanvasRenderingContext2D, id: number): void {
  const node = index.get(id);
  if (!node) return;
  const { k, x, y } = transform;
  const sx0 = k * node.x0 + x;
  const sy0 = k * node.y0 + y;
  const sx1 = k * node.x1 + x;
  const sy1 = k * node.y1 + y;
  if (sx1 < 0 || sy1 < 0 || sx0 > cw || sy0 > ch) return; // off screen
  const w = sx1 - sx0;
  const h = sy1 - sy0;
  if (w < 1 || h < 1) return;
  ctx.save();
  ctx.strokeStyle = "rgba(0,0,0,0.6)";
  ctx.lineWidth = 3;
  ctx.strokeRect(sx0 + 1.5, sy0 + 1.5, w - 3, h - 3);
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(sx0 + 1.5, sy0 + 1.5, w - 3, h - 3);
  ctx.restore();
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
      drewShimmer = true;
      drawShimmer(ctx, sx0, sy0, w, h, node);
      return;
    }
    for (const child of node.children) drawNode(ctx, child);
    drawDirFrame(ctx, sx0, sy0, w, h, node, dpr);
    return;
  }

  drawTile(ctx, sx0, sy0, w, h, node, {
    colorMode: settings.colorMode,
    ageBounds: ageBounds(),
    shaded: settings.shaded,
    dpr,
  });
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

/** The fold threshold to fetch a directory with: 0 for one the user explicitly unfolded, else the global setting. */
function minSizeFor(id: number): number {
  return unfolded.has(id) ? 0 : settings.minSize;
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
          ids.map((id) => ({ parentId: id, limit: BATCH_LIMIT, minSize: minSizeFor(id) })),
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
function applyBatch(
  nodes: Record<
    string,
    { children: TreeChild[]; childCount: number; omittedTail?: { count: number; bytes: number }; foldedSmall?: { count: number; bytes: number } }
  >,
): void {
  let changed = true;
  let passes = 0;
  while (changed && passes++ < SPINE_DEPTH + 2) {
    changed = false;
    for (const [idStr, entry] of Object.entries(nodes)) {
      const id = Number(idStr);
      const node = index.get(id);
      if (node && node.children === null) {
        layoutInto(node, entry.children, entry.omittedTail, entry.foldedSmall, minSizeFor(id));
        noteAgeBounds(entry.children);
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
  if (!node) return;
  if (node.kind === "small") {
    unfold(node);
    return;
  }
  if (node.kind === "directory" && node.childCount > 0) flyTo(node);
}

/**
 * Reveal the files a "small" tile folded (feature 0013, Model A). The fold is
 * server-side and camera-independent, so unfolding means re-fetching the containing
 * directory with `minSize: 0`; marking it `unfolded` keeps the settle planner from
 * re-folding it on the next camera frame. Drop the stale interior and let the planner
 * refetch it.
 */
function unfold(smallTile: WorldNode): void {
  const parentId = smallTile.foldedParentId;
  if (parentId == null) return;
  const parent = index.get(parentId);
  if (!parent) return;
  unfolded.add(parentId);
  parent.children = null;
  index = indexById(worldRoot!);
  void planFetches();
}

// --- fly-to (camera animation) ---

function flyTo(node: WorldNode): void {
  if (!zoomBehavior || !canvasRef.value) return;
  const target = targetTransformFor(node, cw, ch, FLY_COVER);
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
      { parentId: node.id, depth: SPINE_DEPTH, limit: BATCH_LIMIT, minSize: minSizeFor(node.id) },
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
      const child = node.children?.find((c) => c.kind !== "tail" && c.kind !== "small" && c.name === segment);
      if (!child) break;
      node = child;
    }
  }
  flyTo(node);
}

/**
 * Walk `dirSegs` from the root through the laid-out tree, stopping at the first
 * directory whose interior isn't loaded yet (`needLoad`), a missing segment, or the
 * target. Unlike a plain lookup this reports *why* it stopped so {@link revealPath}
 * can fetch that one level and resume.
 */
function descendLoaded(dirSegs: string[]): { node: WorldNode; needLoad: boolean } {
  let node: WorldNode = worldRoot!;
  for (const seg of dirSegs) {
    if (node.children == null) return { node, needLoad: node.kind === "directory" && node.childCount > 0 };
    const child = node.children.find((c) => c.kind === "directory" && c.name === seg);
    if (!child) return { node, needLoad: false }; // segment absent (folded/omitted/gone) — stop here
    node = child;
  }
  return { node, needLoad: false }; // reached the target directory
}

/**
 * Reveal a deep search result (feature 0004): seed the spine down to the folder that
 * contains `filePath`, one batch per unloaded level, then fly there. `flyToPath`
 * alone can't do this — it stops at the deepest *already-laid-out* ancestor, and a
 * search hit is usually far below what the camera has fetched. The final fly's
 * `prefetchSpine` loads the containing folder's children, so the file tile lays out
 * and App's id-highlight lands on it. The caller sets that highlight.
 */
async function revealPath(filePath: string): Promise<void> {
  if (!worldRoot) return;
  const dirSegs = filePath.split("/").filter(Boolean).slice(0, -1); // drop the file itself
  for (let guard = 0; guard <= dirSegs.length + 1; guard++) {
    const { node, needLoad } = descendLoaded(dirSegs);
    if (!needLoad) {
      flyTo(node);
      return;
    }
    try {
      const response = await fetchTreeBatch(props.rootId, props.seed.generation, [
        { parentId: node.id, depth: 1, limit: BATCH_LIMIT, minSize: minSizeFor(node.id) },
      ]);
      applyBatch(response.nodes);
    } catch {
      flyTo(node); // best-effort: land as deep as we got
      return;
    }
  }
}

defineExpose({ flyToPath, revealPath });

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
    // Synthetic aggregate tiles ("tail", "small") aren't real children — keep them
    // out of the file-list pane.
    .filter((c) => c.kind !== "tail" && c.kind !== "small")
    .map((c) => ({
      id: c.id,
      name: c.name,
      kind: c.kind === "tail" || c.kind === "small" ? "other" : c.kind,
      size: c.size,
      childCount: c.childCount,
      ...(c.ext != null ? { ext: c.ext } : {}),
      ...(c.error != null ? { error: c.error } : {}),
    }));
  emit("focus", {
    chain: chain.map((c) => ({ id: c.id, name: c.name, path: c.path })),
    children,
    size: focusNode.size,
    // The remainder past this level's fetch cap — plumbed so the list pane can report
    // it in its "… X more" summary row instead of silently dropping it (feature 0015).
    ...(focusNode.omittedTail ? { omittedTail: focusNode.omittedTail } : {}),
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
