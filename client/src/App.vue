<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import type { RootStatus, ScannerStatus, ScanRoot, TreeChild, TreeSlice } from "@webdirstat/shared";
import {
  fetchRootStatus,
  fetchRoots,
  fetchTree,
  NotScannedError,
  startScan,
  stopScan,
  subscribeStatus,
} from "./api";
import type { WorldNode } from "./treemap/layout";
import { formatAgo, formatBytes, formatCount, formatUntil } from "./utils/format";
import MapTreemap from "./components/MapTreemap.vue";
import { File, Folder, Link2 } from "@lucide/vue";

/** Leading list-row glyph for a child's kind (directory / symlink / everything else). */
function iconForKind(kind: TreeChild["kind"]) {
  if (kind === "directory") return Folder;
  if (kind === "symlink") return Link2;
  return File;
}
import ScheduleEditor from "./components/ScheduleEditor.vue";

const roots = ref<ScanRoot[]>([]);
const selectedRootId = ref<string>("");

const scanner = shallowRef<ScannerStatus>({ state: { phase: "idle" }, queue: [] });
const rootStatus = shallowRef<RootStatus | null>(null);
const scanError = ref<string | null>(null);
const notScanned = ref(false);
const showSchedule = ref(false);

/** The root slice passed to the map; its generation pins every read this session. */
const seed = shallowRef<TreeSlice | null>(null);
const generation = computed(() => seed.value?.generation ?? null);

/** Camera-derived focus (breadcrumbs + list pane) reported by the map. */
const focusChain = shallowRef<Array<{ id: number; name: string; path: string }>>([]);
const focusChildren = shallowRef<TreeChild[]>([]);
const focusSize = ref(0);
const hoveredNode = shallowRef<WorldNode | null>(null);

const mapRef = ref<InstanceType<typeof MapTreemap> | null>(null);

let unsubscribe: (() => void) | null = null;
let statusTimer: ReturnType<typeof setInterval> | null = null;

const globalScanning = computed(() => scanner.value.state.phase !== "idle");
const rootLabel = (id: string) => roots.value.find((r) => r.id === id)?.label ?? id;

const scanLine = computed<string | null>(() => {
  const s = scanner.value.state;
  if (s.phase === "idle") return null;
  const who = `${rootLabel(s.root)} (${s.trigger})`;
  if (s.phase === "swapping") return `Swapping in ${who}…`;
  if (s.progress) {
    return `Scanning ${who}: ${formatCount(s.progress.entries)} entries · ${formatBytes(s.progress.bytes)} · ${s.progress.path}`;
  }
  return `Scanning ${who}…`;
});

const focusPath = computed(() => focusChain.value.at(-1)?.path ?? "");

onMounted(async () => {
  try {
    roots.value = await fetchRoots();
    if (roots.value.length > 0) selectedRootId.value = roots.value[0]!.id;
  } catch (error) {
    scanError.value = error instanceof Error ? error.message : String(error);
  }
  unsubscribe = subscribeStatus(onStatus);
  statusTimer = setInterval(() => void refreshRootStatus(), 30_000);
});

onBeforeUnmount(() => {
  unsubscribe?.();
  if (statusTimer) clearInterval(statusTimer);
});

watch(selectedRootId, () => {
  void loadRoot();
  void refreshRootStatus();
});

let wasScanning = false;
function onStatus(status: ScannerStatus): void {
  scanner.value = status;
  const scanningNow = status.state.phase !== "idle";
  if (wasScanning && !scanningNow) void onScanSettled();
  wasScanning = scanningNow;
}

async function onScanSettled(): Promise<void> {
  const status = await refreshRootStatus();
  if (status && status.generation != null && status.generation !== generation.value) {
    void loadRoot();
  }
}

async function refreshRootStatus(): Promise<RootStatus | null> {
  if (!selectedRootId.value) return null;
  try {
    rootStatus.value = await fetchRootStatus(selectedRootId.value);
    return rootStatus.value;
  } catch {
    return null;
  }
}

/** (Re)seed the map from the selected root's live generation. */
async function loadRoot(): Promise<void> {
  const rootId = selectedRootId.value;
  if (!rootId) return;
  scanError.value = null;
  notScanned.value = false;
  seed.value = null;
  focusChain.value = [];
  focusChildren.value = [];
  try {
    seed.value = await fetchTree(rootId, "");
  } catch (error) {
    if (error instanceof NotScannedError) notScanned.value = true;
    else scanError.value = error instanceof Error ? error.message : String(error);
  }
}

async function onStartStop(): Promise<void> {
  scanError.value = null;
  try {
    if (globalScanning.value) await stopScan();
    else await startScan(selectedRootId.value);
  } catch (error) {
    scanError.value = error instanceof Error ? error.message : String(error);
  }
}

function onFocus(payload: { chain: Array<{ id: number; name: string; path: string }>; children: TreeChild[]; size: number }): void {
  focusChain.value = payload.chain;
  focusChildren.value = payload.children;
  focusSize.value = payload.size;
}

function flyToChild(child: TreeChild): void {
  if (child.kind !== "directory") return;
  const path = focusPath.value ? `${focusPath.value}/${child.name}` : child.name;
  mapRef.value?.flyToPath(path);
}

function percentOfFocus(node: TreeChild): number {
  return focusSize.value > 0 ? (node.size / focusSize.value) * 100 : 0;
}
</script>

<template>
  <div class="app">
    <header class="toolbar">
      <h1>WebDirStat</h1>
      <select v-model="selectedRootId" :disabled="roots.length === 0">
        <option v-for="root in roots" :key="root.id" :value="root.id">{{ root.label }}</option>
      </select>
      <button :disabled="!selectedRootId" @click="onStartStop">{{ globalScanning ? "Stop" : "Scan" }}</button>
      <button class="ghost" :class="{ active: showSchedule }" @click="showSchedule = !showSchedule">Schedule</button>

      <div v-if="scanLine" class="status">{{ scanLine }}</div>
      <div v-else-if="rootStatus" class="status">
        <template v-if="rootStatus.generation != null">
          {{ formatCount(rootStatus.totalCount ?? 0) }} entries ·
          {{ formatBytes(rootStatus.totalBytes ?? 0) }} ·
          scanned {{ formatAgo(rootStatus.lastScanEndedAt) }}
          <span v-if="rootStatus.lastScanStatus && rootStatus.lastScanStatus !== 'ok'" class="badge">
            ({{ rootStatus.lastScanStatus }})
          </span>
          <span v-if="rootStatus.enabled && rootStatus.nextScanAt" class="muted">
            · next {{ formatUntil(rootStatus.nextScanAt) }}
          </span>
          <span v-else-if="!rootStatus.enabled" class="muted">· manual only</span>
        </template>
        <template v-else>not scanned yet</template>
      </div>
      <div v-if="scanError" class="status error">{{ scanError }}</div>
    </header>

    <ScheduleEditor v-if="showSchedule && selectedRootId" :root-id="selectedRootId" @saved="refreshRootStatus" />

    <nav v-if="focusChain.length > 0" class="breadcrumbs">
      <button v-for="(node, index) in focusChain" :key="index" @click="mapRef?.flyToPath(node.path)">
        {{ index === 0 ? node.name || "/" : node.name }}
      </button>
    </nav>

    <main v-if="seed" class="content">
      <aside class="list-pane">
        <div
          v-for="child in focusChildren"
          :key="child.id"
          class="list-row"
          :class="{ error: !!child.error, dir: child.kind === 'directory' }"
          @click="flyToChild(child)"
        >
          <div class="bar" :style="{ width: percentOfFocus(child) + '%' }"></div>
          <component :is="iconForKind(child.kind)" class="icon" :size="14" aria-hidden="true" />
          <span class="name" :title="child.name">{{ child.name }}</span>
          <span class="size">{{ formatBytes(child.size) }}</span>
        </div>
        <p v-if="focusChildren.length === 0" class="empty">Empty directory</p>
      </aside>

      <section class="treemap-pane">
        <MapTreemap
          ref="mapRef"
          :root-id="selectedRootId"
          :seed="seed"
          @focus="onFocus"
          @hover="(node) => (hoveredNode = node)"
          @stale="loadRoot"
        />
        <div v-if="hoveredNode" class="tooltip">
          {{ hoveredNode.name }} — {{ formatBytes(hoveredNode.size) }}
          <template v-if="hoveredNode.error">({{ hoveredNode.error }})</template>
        </div>
        <div class="hint">scroll to zoom · drag to pan · click a folder to fly in</div>
      </section>
    </main>

    <p v-else-if="notScanned" class="placeholder">This root hasn't been scanned yet. Hit Scan to build the store.</p>
    <p v-else class="placeholder">Pick a root and hit Scan to see where your space went.</p>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}

.toolbar h1 {
  font-size: 1.1rem;
  margin: 0;
}

.ghost {
  background: none;
  border: 1px solid var(--border);
  color: var(--muted);
  border-radius: 4px;
  cursor: pointer;
}

.ghost.active {
  color: var(--accent);
  border-color: var(--accent);
}

.status {
  font-size: 0.85rem;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.status .badge {
  color: var(--danger);
}

.status .muted {
  color: var(--muted);
}

.status.error {
  color: var(--danger);
}

.breadcrumbs {
  display: flex;
  gap: 0.25rem;
  padding: 0.4rem 1rem;
  border-bottom: 1px solid var(--border);
  overflow-x: auto;
}

.breadcrumbs button {
  background: none;
  border: none;
  color: var(--accent);
  cursor: pointer;
  font-size: 0.85rem;
  padding: 0.15rem 0.4rem;
  white-space: nowrap;
}

.breadcrumbs button:not(:last-child)::after {
  content: "/";
  margin-left: 0.25rem;
  color: var(--muted);
}

.content {
  flex: 1;
  display: flex;
  min-height: 0;
}

.list-pane {
  width: 280px;
  overflow-y: auto;
  border-right: 1px solid var(--border);
  flex-shrink: 0;
}

.list-row {
  position: relative;
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 0.4rem;
  align-items: center;
  padding: 0.35rem 0.6rem;
  font-size: 0.85rem;
}

.list-row.dir {
  cursor: pointer;
}

.list-row:hover {
  background: var(--hover);
}

.list-row .bar {
  position: absolute;
  inset: 0;
  background: var(--bar);
  z-index: 0;
}

.list-row .icon,
.list-row .name,
.list-row .size {
  position: relative;
  z-index: 1;
}

.list-row .icon {
  color: var(--muted);
}

.list-row.dir .icon {
  color: inherit;
}

.list-row .name {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  min-width: 0;
}

.list-row .size {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.list-row.error .name {
  color: var(--danger);
}

.list-row.error .icon {
  color: var(--danger);
}

.empty {
  padding: 0.6rem;
  color: var(--muted);
  font-size: 0.85rem;
}

.treemap-pane {
  flex: 1;
  position: relative;
  min-width: 0;
}

.tooltip {
  position: absolute;
  bottom: 0.75rem;
  left: 0.75rem;
  background: var(--tooltip-bg);
  color: var(--tooltip-fg);
  padding: 0.35rem 0.6rem;
  border-radius: 4px;
  font-size: 0.8rem;
  pointer-events: none;
}

.hint {
  position: absolute;
  bottom: 0.75rem;
  right: 0.75rem;
  color: var(--muted);
  font-size: 0.75rem;
  pointer-events: none;
  opacity: 0.7;
}

.placeholder {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
}
</style>
