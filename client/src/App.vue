<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import type { RootStatus, ScannerStatus, ScanRoot, SearchResult, TreeChild, TreeSlice } from "@webdirstat/shared";
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
import { AGE_RAMP, type AgeBounds } from "./utils/color";
import { useByteFormat, useDisplaySettings } from "./composables/useDisplaySettings";
import MapTreemap from "./components/MapTreemap.vue";
import SettingsModal from "./components/SettingsModal.vue";
import Breadcrumbs from "./components/Breadcrumbs.vue";
import ScanStatus from "./components/ScanStatus.vue";
import FileList from "./components/FileList.vue";
import TypeList from "./components/TypeList.vue";
import SearchPanel from "./components/SearchPanel.vue";

const roots = ref<ScanRoot[]>([]);
const selectedRootId = ref<string>("");

const scanner = shallowRef<ScannerStatus>({ state: { phase: "idle" }, queue: [] });
const rootStatus = shallowRef<RootStatus | null>(null);
const scanError = ref<string | null>(null);
const notScanned = ref(false);
const showSettings = ref(false);
const showTypes = ref(false);
const showSearch = ref(false);

const { settings } = useDisplaySettings();
const formatBytes = useByteFormat();

/** The root slice passed to the map; its generation pins every read this session. */
const seed = shallowRef<TreeSlice | null>(null);
const generation = computed(() => seed.value?.generation ?? null);

/** Camera-derived focus (breadcrumbs + list pane) reported by the map. */
const focusChain = shallowRef<Array<{ id: number; name: string; path: string }>>([]);
const focusChildren = shallowRef<TreeChild[]>([]);
const focusSize = ref(0);
const hoveredNode = shallowRef<WorldNode | null>(null);
/** Node id of the hovered file-list row, mirrored onto the map as a tile highlight. */
const highlightedId = ref<number | null>(null);

/** [oldest, newest] mtime the map has seen, for the age-mode gradient legend. */
const ageBounds = shallowRef<AgeBounds | null>(null);
const ageGradient = `linear-gradient(to right, ${AGE_RAMP.join(", ")})`;
function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

const mapRef = ref<InstanceType<typeof MapTreemap> | null>(null);

let unsubscribe: (() => void) | null = null;
let statusTimer: ReturnType<typeof setInterval> | null = null;

const globalScanning = computed(() => scanner.value.state.phase !== "idle");

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

// The fold threshold (feature 0013) is applied server-side, so changing it re-seeds
// the map from a freshly folded root slice; the map reseeds off the new seed object.
watch(
  () => settings.minSize,
  () => void loadRoot(),
);

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
    seed.value = await fetchTree(rootId, "", { minSize: settings.minSize });
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

/** A search hit: seed the spine to its folder, fly there, and highlight the file tile. */
function revealResult(result: SearchResult): void {
  highlightedId.value = result.id;
  void mapRef.value?.revealPath(result.path);
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
      <select v-model="settings.colorMode" class="color-mode" title="Tile color mode">
        <option value="type">Color: Type</option>
        <option value="age">Color: Age</option>
      </select>
      <button class="ghost" :class="{ active: showSearch }" @click="showSearch = !showSearch">🔍 Search</button>
      <button class="ghost" :class="{ active: showTypes }" @click="showTypes = !showTypes">Types</button>
      <button class="ghost" :class="{ active: showSettings }" @click="showSettings = !showSettings">⚙ Settings</button>

      <ScanStatus :scanner="scanner" :roots="roots" :root-status="rootStatus" :error="scanError" />
    </header>

    <SettingsModal
      :open="showSettings"
      :roots="roots"
      :root-id="selectedRootId"
      @close="showSettings = false"
      @schedule-saved="refreshRootStatus"
    />

    <Breadcrumbs :chain="focusChain" @navigate="(path) => mapRef?.flyToPath(path)" />

    <main v-if="seed" class="content">
      <SearchPanel
        v-if="showSearch"
        :root-id="selectedRootId"
        :generation="generation"
        :focus-path="focusPath"
        @reveal="revealResult"
      />
      <TypeList v-if="showTypes" :root-id="selectedRootId" :generation="generation" :path="focusPath" />
      <FileList
        :children="focusChildren"
        :total-size="focusSize"
        @select="flyToChild"
        @hover="(id) => (highlightedId = id)"
      />

      <section class="treemap-pane">
        <MapTreemap
          ref="mapRef"
          :root-id="selectedRootId"
          :seed="seed"
          :highlight-id="highlightedId"
          @focus="onFocus"
          @hover="(node) => (hoveredNode = node)"
          @stale="loadRoot"
          @agebounds="(b) => (ageBounds = b)"
        />
        <div v-if="settings.colorMode === 'age' && ageBounds" class="age-legend">
          <span>{{ formatDate(ageBounds.min) }}</span>
          <span class="ramp" :style="{ background: ageGradient }"></span>
          <span>{{ formatDate(ageBounds.max) }}</span>
          <em>older → newer</em>
        </div>
        <div v-if="hoveredNode" class="tooltip">
          {{ settings.hoverFullPath ? hoveredNode.path || hoveredNode.name : hoveredNode.name }} — {{ formatBytes(hoveredNode.size) }}
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

.color-mode {
  font-size: 0.85rem;
}

.age-legend {
  position: absolute;
  top: 0.75rem;
  right: 0.75rem;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  background: var(--tooltip-bg);
  color: var(--tooltip-fg);
  padding: 0.3rem 0.5rem;
  border-radius: 4px;
  font-size: 0.72rem;
  pointer-events: none;
}

.age-legend .ramp {
  width: 90px;
  height: 8px;
  border-radius: 2px;
}

.age-legend em {
  font-style: normal;
  opacity: 0.7;
}

.content {
  flex: 1;
  display: flex;
  min-height: 0;
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
