<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { select } from "d3-selection";
import { zoom, zoomIdentity, type D3ZoomEvent, type ZoomBehavior, type ZoomTransform } from "d3-zoom";
import type { TreeChild, TreeSlice } from "@webdirstat/shared";
import { fetchTreeBatch } from "../api";
import { type AgeBounds } from "../utils/color";
import { useDisplaySettings } from "../composables/useDisplaySettings";
import { useSelection } from "../composables/useSelection";
import type { TargetMode, Tool } from "./TileToolbar.vue";
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
const selection = useSelection();

const props = defineProps<{
  rootId: string;
  seed: TreeSlice;
  highlightId?: number | null;
  /** The world root's path relative to the configured root; "" = full root (feature 0016). */
  basePath?: string;
  /** Canvas interaction tool (feature 0019): Navigate pans, Marquee draws a box. */
  tool?: Tool;
  /** What a click/marquee marks (feature 0019): file leaves vs. enclosing folders. */
  targetMode?: TargetMode;
}>();
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
  /** Shift-click a solid directory tile: scope the view to it (root-relative path). */
  scope: [string];
  /** A transient selection message (feature 0019), e.g. the Files-mode bulk-cap refusal. */
  notify: [string];
}>();

const tool = () => props.tool ?? "navigate";
/** Either marquee tool is active (vs. Navigate) — gates the box gesture, cursor, space-pan. */
const isMarquee = () => tool() !== "navigate";
/**
 * How the marquee hit-tests tiles (feature 0019): `contain` grabs only tiles the box
 * fully encloses; `touch` grabs any tile the box overlaps. Only the dedicated
 * `marquee-touch` tool is touch; Navigate's shift-drag marquee stays contain.
 */
const hitMode = (): "contain" | "touch" => (tool() === "marquee-touch" ? "touch" : "contain");
const targetMode = () => props.targetMode ?? "files";
/** Files-mode marquee upper bound (feature 0019, open question): refuse rather than mark thousands. */
const FILES_MARQUEE_CAP = 500;

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

// --- selection / marquee (feature 0019) ---
/** In-progress marquee box in *screen* coords, or null when not dragging one. */
let marquee: { x0: number; y0: number; x1: number; y1: number; mode: "add" | "subtract" } | null = null;
/** The gesture that armed on mousedown but hasn't crossed the drag threshold yet. */
let armed: { x: number; y: number; mode: "add" | "subtract" } | null = null;
/** Set once a marquee drag actually moved, so the trailing `click` is swallowed. */
let suppressClick = false;
/** Spacebar held → in Marquee mode, drag pans (drawing-app convention). */
let spaceDown = false;
/** Theme accent/danger sampled once, for the selection wash + marquee preview. */
let accentColor = "#4c8dff";
let dangerColor = "#e5484d";

// --- lifecycle ---

onMounted(() => {
  const canvas = canvasRef.value!;
  measure();
  const styles = getComputedStyle(canvas);
  accentColor = styles.getPropertyValue("--accent").trim() || accentColor;
  dangerColor = styles.getPropertyValue("--danger").trim() || dangerColor;
  zoomBehavior = zoom<HTMLCanvasElement, unknown>()
    .scaleExtent([MIN_SCALE, MAX_SCALE])
    // Pan only for non-marquee gestures; wheel always zooms. A marquee gesture (see
    // `marqueeModeFor`) is drawn by our own handlers instead, so d3 must not grab it.
    .filter((event) => {
      if (event.type === "wheel") return true;
      if (event.type === "dblclick") return false;
      if (typeof event.button === "number" && event.button !== 0) return false;
      return marqueeModeFor(event as MouseEvent) === null;
    })
    .on("zoom", onZoom);
  select(canvas).call(zoomBehavior);
  canvas.addEventListener("mousemove", onMouseMove);
  canvas.addEventListener("mouseleave", () => emit("hover", null));
  canvas.addEventListener("mousedown", onMarqueeDown);
  canvas.addEventListener("click", onClick);
  window.addEventListener("mousemove", onMarqueeMove);
  window.addEventListener("mouseup", onMarqueeUp);
  window.addEventListener("keydown", onKey);
  window.addEventListener("keyup", onKey);
  resizeObserver = new ResizeObserver(onResize);
  if (wrapperRef.value) resizeObserver.observe(wrapperRef.value);
  reseed();
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  fetchController?.abort();
  if (planTimer) clearTimeout(planTimer);
  if (flyRaf) cancelAnimationFrame(flyRaf);
  window.removeEventListener("mousemove", onMarqueeMove);
  window.removeEventListener("mouseup", onMarqueeUp);
  window.removeEventListener("keydown", onKey);
  window.removeEventListener("keyup", onKey);
});

function onKey(event: KeyboardEvent): void {
  if (event.code !== "Space") return;
  // Space pans in Marquee mode; swallow its default (page scroll) only while relevant.
  spaceDown = event.type === "keydown";
  if (isMarquee()) event.preventDefault();
}

// Reseed whenever the root slice identity changes (new root or new generation).
watch(() => props.seed, reseed);

// Flat/Shaded is a pure rendering-layer change — just repaint, no refetch/relayout.
watch(() => settings.shaded, scheduleDraw);

// List-row hover (feature 0012) is a pure overlay repaint — coalesce into the RAF.
watch(() => props.highlightId, scheduleDraw);

// The selection wash (feature 0019) is a pure overlay repaint; ops replace the marks
// array on every real change, so this fires exactly when the wash needs redrawing. We
// snapshot the marks into a plain Set here (not per draw): the wash walks the whole
// laid-out tree every frame, and `selection.has` is an O(marks) scan over a *reactive*
// proxy array — so reading it per node made each pan/zoom frame O(nodes x marks) with
// proxy-getter overhead. The Set makes the per-node lookup O(1) and proxy-free.
let markedPaths = new Set<string>();
watch(
  () => selection.marksFor(props.rootId),
  (paths) => {
    markedPaths = new Set(paths);
    scheduleDraw();
  },
  { immediate: true },
);

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
  // The scope base is part of the tree's identity: re-scoping to a subfolder is a
  // genuinely different world, so it must reset the camera (not retain it).
  const key = `${props.rootId}@${props.seed.generation}#${props.basePath ?? ""}`;
  const keepCamera = worldRoot != null && renderedKey === key;
  renderedKey = key;
  // New tree: forget the old mtime span before re-accumulating from this seed.
  ageMin = Infinity;
  ageMax = -Infinity;
  emit("agebounds", null);
  if (!wrapperRef.value || cw === 0) measure();
  worldRoot = makeRoot(props.seed.node, { x0: 0, y0: 0, x1: cw || 1, y1: ch || 1 }, props.basePath ?? "");
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

  drawSelectionWash(ctx, worldRoot, false);
  if (marquee) drawMarquee(ctx);

  if (props.highlightId != null) drawHighlight(ctx, props.highlightId);

  // Keep animating while any shimmer placeholder is on screen (the gradient pan).
  if (drewShimmer) scheduleDraw();
}

/** Screen rect of a world node under the current camera, or null if fully off-screen. */
function screenRect(node: WorldNode): { x: number; y: number; w: number; h: number } | null {
  const { k, x, y } = transform;
  const sx0 = k * node.x0 + x;
  const sy0 = k * node.y0 + y;
  const w = k * (node.x1 - node.x0);
  const h = k * (node.y1 - node.y0);
  if (sx0 + w < 0 || sy0 + h < 0 || sx0 > cw || sy0 > ch) return null;
  return { x: sx0, y: sy0, w, h };
}

/**
 * The selection wash (feature 0019): a tint over every marked item's whole rect. Drawn
 * at the *shallowest* mark and not descended into — one flat wash per mark, so a marked
 * folder tints uniformly over its children (visualizing subsumption) without the alpha
 * stacking that re-washing each descendant would cause. Reuses the overlay-pass idea of
 * the list→map highlight (feature 0012) rather than a DOM layer.
 */
function drawSelectionWash(ctx: CanvasRenderingContext2D, node: WorldNode, underMark: boolean): void {
  const marked = underMark || (node.kind !== "tail" && node.kind !== "small" && markedPaths.has(node.path));
  if (marked) {
    const rect = screenRect(node);
    if (rect && rect.w >= 1 && rect.h >= 1) {
      ctx.save();
      ctx.fillStyle = accentColor;
      ctx.globalAlpha = 0.32;
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = accentColor;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(rect.x + 0.75, rect.y + 0.75, rect.w - 1.5, rect.h - 1.5);
      ctx.restore();
    }
    return; // don't descend: the parent wash already covers the whole subtree
  }
  if (node.children) for (const child of node.children) drawSelectionWash(ctx, child, false);
}

/** Draw the live marquee box plus a preview wash over what a release would mark/unmark. */
function drawMarquee(ctx: CanvasRenderingContext2D): void {
  if (!marquee) return;
  const preview = collectMarqueeTargets(marquee.mode);
  const color = marquee.mode === "subtract" ? dangerColor : accentColor;
  for (const node of preview) {
    const rect = screenRect(node);
    if (!rect || rect.w < 1 || rect.h < 1) continue;
    ctx.save();
    ctx.fillStyle = color;
    ctx.globalAlpha = marquee.mode === "subtract" ? 0.22 : 0.28;
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    ctx.restore();
  }
  const x = Math.min(marquee.x0, marquee.x1);
  const y = Math.min(marquee.y0, marquee.y1);
  const w = Math.abs(marquee.x1 - marquee.x0);
  const h = Math.abs(marquee.y1 - marquee.y0);
  ctx.save();
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.1;
  ctx.fillRect(x, y, w, h);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(x + 0.5, y + 0.5, w, h);
  ctx.restore();
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

/** Like {@link hitTest} but returns the whole root→hit chain (for enclosing-folder resolution). */
function chainAtEvent(event: MouseEvent): WorldNode[] {
  const worldX = (event.offsetX - transform.x) / transform.k;
  const worldY = (event.offsetY - transform.y) / transform.k;
  const chain: WorldNode[] = [];
  if (!worldRoot) return chain;
  let node: WorldNode = worldRoot;
  chain.push(node);
  for (;;) {
    const expanded =
      node.kind === "directory" &&
      node.children &&
      transform.k * (node.x1 - node.x0) > EXPAND_PX &&
      transform.k * (node.y1 - node.y0) > EXPAND_PX;
    if (!expanded || !node.children) return chain;
    const child = node.children.find((c) => worldX >= c.x0 && worldX < c.x1 && worldY >= c.y0 && worldY < c.y1);
    if (!child) return chain;
    node = child;
    chain.push(node);
  }
}

/** The deepest real directory in a hit chain — the folder a Folders-mode click resolves to. */
function enclosingDir(chain: WorldNode[]): WorldNode | null {
  for (let i = chain.length - 1; i >= 0; i--) if (chain[i]!.kind === "directory") return chain[i]!;
  return null;
}

function onMouseMove(event: MouseEvent): void {
  emit("hover", nodeAtEvent(event));
}

/**
 * A plain click marks one target (feature 0019). The dead fly-to-folder branch is gone
 * (it was effectively unreachable — a folder big enough to click was already expanded).
 * Fly-in survives via the breadcrumbs and file-list; the canvas click now toggles a
 * mark. Shift-click still scopes (feature 0016), resolving up to the enclosing folder.
 */
function onClick(event: MouseEvent): void {
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  const chain = chainAtEvent(event);
  const node = chain.at(-1);
  if (!node) return;
  if (node.kind === "small") {
    unfold(node);
    return;
  }
  if (node.kind === "tail") return;
  if (event.shiftKey) {
    const dir = enclosingDir(chain);
    if (dir && dir.depth > 0) emit("scope", dir.path);
    return;
  }
  // Files mode marks the hit itself (a leaf, or a solid sub-folder tile); Folders mode
  // resolves up to the enclosing directory, so clicking a file tile marks its folder.
  const target = targetMode() === "folders" ? enclosingDir(chain) : node;
  if (target && target.depth > 0) selection.toggle(props.rootId, target.path, target.size);
}

// --- marquee selection (feature 0019) ---

/**
 * The marquee mode this mousedown would begin, or null if it's a pan/other gesture.
 * Navigate keeps modifier accelerators (shift-drag adds, alt-drag subtracts); Marquee
 * makes plain-drag the box (alt subtracts) and relocates pan to space-drag.
 */
function marqueeModeFor(event: MouseEvent): "add" | "subtract" | null {
  if (event.button !== 0) return null;
  if (event.altKey) return "subtract";
  if (isMarquee()) return spaceDown ? null : "add";
  return event.shiftKey ? "add" : null; // Navigate: plain-drag pans
}

function onMarqueeDown(event: MouseEvent): void {
  const mode = marqueeModeFor(event);
  if (!mode) return;
  // Arm; the box only appears once the drag crosses the threshold, so a shift-*click*
  // (scope) with no movement still falls through to onClick.
  armed = { x: event.offsetX, y: event.offsetY, mode };
  marquee = null;
}

function onMarqueeMove(event: MouseEvent): void {
  if (!armed || !canvasRef.value) return;
  const rect = canvasRef.value.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  if (!marquee) {
    if (Math.abs(x - armed.x) < 3 && Math.abs(y - armed.y) < 3) return; // below threshold
    marquee = { x0: armed.x, y0: armed.y, x1: x, y1: y, mode: armed.mode };
  } else {
    marquee.x1 = x;
    marquee.y1 = y;
  }
  scheduleDraw();
}

function onMarqueeUp(): void {
  if (marquee) {
    commitMarquee();
    suppressClick = true; // a drag shouldn't also fire a mark-toggle click
    marquee = null;
    scheduleDraw();
  }
  armed = null;
}

/** Screen-space marquee box → world rect (normalized so x0<x1, y0<y1). */
function marqueeWorldRect(): { x0: number; y0: number; x1: number; y1: number } {
  const m = marquee!;
  const toWorldX = (sx: number) => (sx - transform.x) / transform.k;
  const toWorldY = (sy: number) => (sy - transform.y) / transform.k;
  return {
    x0: toWorldX(Math.min(m.x0, m.x1)),
    y0: toWorldY(Math.min(m.y0, m.y1)),
    x1: toWorldX(Math.max(m.x0, m.x1)),
    y1: toWorldY(Math.max(m.y0, m.y1)),
  };
}

type Rect = { x0: number; y0: number; x1: number; y1: number };

/** True when `inner`'s rect lies entirely within `outer`'s. */
function rectContains(outer: Rect, inner: Rect): boolean {
  return outer.x0 <= inner.x0 && inner.x1 <= outer.x1 && outer.y0 <= inner.y0 && inner.y1 <= outer.y1;
}

function intersects(node: WorldNode, box: Rect): boolean {
  return node.x0 < box.x1 && node.x1 > box.x0 && node.y0 < box.y1 && node.y1 > box.y0;
}

/**
 * The laid-out nodes a marquee (current mode) would act on. The active tool's
 * {@link hitMode} decides the predicate: `contain` grabs only tiles the box fully
 * encloses; `touch` grabs any tile the box overlaps. Folders subsume (a captured folder
 * isn't descended into); a `touch` box that wholly *wraps* a folder is treated as that
 * folder being an ancestor of the selection — we descend so the box's own child tiles
 * are what get grabbed, not the whole enclosing folder. Used for both the live preview
 * and the commit, so they can't drift.
 */
function collectMarqueeTargets(mode: "add" | "subtract"): WorldNode[] {
  if (!worldRoot || !marquee) return [];
  const box = marqueeWorldRect();
  const out: WorldNode[] = [];
  const folders = targetMode() === "folders";
  const touch = hitMode() === "touch";

  const walk = (node: WorldNode): void => {
    if (!intersects(node, box)) return;
    if (folders) {
      // touch: grab any folder the box overlaps, except one that wholly wraps the box
      // (an ancestor of the selection) — descend into it instead. contain: full enclose.
      const grab = node.kind === "directory" && node.depth > 0 && (touch ? !rectContains(node, box) : rectContains(box, node));
      if (grab) {
        // subtract only touches existing marks; add takes any grabbed folder
        if (mode === "add" || markedPaths.has(node.path)) out.push(node);
        return; // subsume: don't descend into a captured folder
      }
    } else if (node.kind === "file" || node.kind === "symlink") {
      // touch: any overlap (the intersects gate above already proved it). contain: enclose.
      if (touch || rectContains(box, node)) {
        if (mode === "add" || markedPaths.has(node.path)) out.push(node);
        return;
      }
    }
    if (node.children) for (const child of node.children) walk(child);
  };
  walk(worldRoot);

  // Folders-mode undershoot: a box that fully contains no folder but lies wholly within
  // one marks *that* folder (gapless packing means a sloppy box rarely encloses a tile).
  if (folders && mode === "add" && out.length === 0) {
    const enclosing = deepestDirContaining(box);
    if (enclosing && enclosing.depth > 0) out.push(enclosing);
  }
  return out;
}

/** The deepest laid-out directory whose rect fully contains the box (undershoot case). */
function deepestDirContaining(box: Rect): WorldNode | null {
  let node = worldRoot!;
  for (;;) {
    const child = node.children?.find((c) => c.kind === "directory" && rectContains(c, box));
    if (!child) return node === worldRoot ? null : node;
    node = child;
  }
}

function commitMarquee(): void {
  if (!marquee) return;
  const mode = marquee.mode;
  const targets = collectMarqueeTargets(mode);
  if (mode === "subtract") {
    selection.removeMany(props.rootId, targets.map((n) => n.path));
    return;
  }
  // Files-mode bulk cap (open question, feature 0019): refuse a box that would mark a
  // flood of individual files rather than silently producing thousands of export lines.
  if (targetMode() === "files" && targets.length > FILES_MARQUEE_CAP) {
    emit("notify", `That box covers ${targets.length} files — narrow it or switch to Folders.`);
    return;
  }
  selection.addMany(props.rootId, targets.map((n) => ({ path: n.path, size: n.size })));
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

/**
 * Strip the world root's `basePath` off an incoming **root-relative** path, yielding the
 * segments to walk from the world root's children (feature 0016, Model A). Node paths
 * (and every path-consuming pane) are root-relative, but the tree walk starts at the
 * world root — which sits at `basePath` when the view is scoped — so the base prefix must
 * come off first. A path not under the base (shouldn't happen for in-scope navigation) is
 * walked as-is, best-effort.
 */
function debaseSegs(path: string): string[] {
  const segs = path.split("/").filter(Boolean);
  const base = (props.basePath ?? "").split("/").filter(Boolean);
  for (let i = 0; i < base.length; i++) if (segs[i] !== base[i]) return segs;
  return segs.slice(base.length);
}

/** Flies to the node at a relative path, if it is present in the laid-out tree. */
function flyToPath(path: string): void {
  if (!worldRoot) return;
  let node: WorldNode = worldRoot;
  for (const segment of debaseSegs(path)) {
    const child = node.children?.find((c) => c.kind !== "tail" && c.kind !== "small" && c.name === segment);
    if (!child) break;
    node = child;
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
  const dirSegs = debaseSegs(filePath).slice(0, -1); // strip scope base, drop the file itself
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
    <canvas ref="canvasRef" :class="{ 'marquee-cursor': (props.tool ?? 'navigate') !== 'navigate' }"></canvas>
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

canvas.marquee-cursor {
  cursor: crosshair;
}
</style>
