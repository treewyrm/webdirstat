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
import { useAuth } from "./composables/useAuth";
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

/** Which left pane is shown; the three panes are mutually exclusive tabs now. */
type SideTab = "files" | "types" | "search";
const activeTab = ref<SideTab>("files");

const { settings } = useDisplaySettings();
const formatBytes = useByteFormat();

/** Password gate (feature 0001): the logout control shows only when a gate is configured. */
const { required: authRequired, signOut } = useAuth();

/** The root slice passed to the map; its generation pins every read this session. */
const seed = shallowRef<TreeSlice | null>(null);
const generation = computed(() => seed.value?.generation ?? null);

/**
 * Scope anchor (feature 0016): the subpath the map is rooted at, relative to the
 * configured root. "" = the full root. Drives `loadRoot`'s `fetchTree`, is passed to
 * the map as its `basePath`, doubles as the stale-reseed anchor, and syncs to the URL.
 */
const viewRoot = ref<string>("");
/** Transient notice, e.g. when a scoped folder vanished on rescan and we fell back. */
const scopeNotice = ref<string | null>(null);

/** Camera-derived focus (breadcrumbs + list pane) reported by the map. */
const focusChain = shallowRef<Array<{ id: number; name: string; path: string }>>([]);
const focusChildren = shallowRef<TreeChild[]>([]);
const focusSize = ref(0);
/** Remainder past this level's fetch cap, for the list's "… X more" row (feature 0015). */
const focusOmittedTail = shallowRef<{ count: number; bytes: number } | null>(null);
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

const rootLabel = computed(() => roots.value.find((r) => r.id === selectedRootId.value)?.label ?? "/");

/**
 * The scope root's ancestors, up to and including the configured root (feature 0016).
 * They sit *above* the world root — absent from the map's camera-derived `focusChain` —
 * so we synthesize them from `viewRoot` to keep the way out visible. Clicking one
 * re-scopes outward. The scope root itself is the map's `focusChain[0]`, so we stop one
 * segment short of `viewRoot`.
 */
const aboveScopeCrumbs = computed(() => {
  if (!viewRoot.value) return [];
  const segs = viewRoot.value.split("/").filter(Boolean);
  const crumbs = [{ name: rootLabel.value, path: "", aboveScope: true }];
  let acc = "";
  for (let i = 0; i < segs.length - 1; i++) {
    acc = acc ? `${acc}/${segs[i]}` : segs[i]!;
    crumbs.push({ name: segs[i]!, path: acc, aboveScope: true });
  }
  return crumbs;
});

/** The full breadcrumb trail: above-scope ancestors, then the camera-derived focus. */
const crumbs = computed(() => [
  ...aboveScopeCrumbs.value,
  ...focusChain.value.map((c) => ({ ...c, aboveScope: false })),
]);

onMounted(async () => {
  try {
    roots.value = await fetchRoots();
    if (roots.value.length > 0) {
      // Restore a scoped view from the URL (?root=…&at=…) so it survives refresh and is
      // linkable (feature 0016); fall back to the first root, unscoped. viewRoot is set
      // before selectedRootId so the reseed watch picks up the anchor on first load.
      const params = new URLSearchParams(location.search);
      const urlRoot = params.get("root");
      const initial = roots.value.find((r) => r.id === urlRoot)?.id ?? roots.value[0]!.id;
      if (urlRoot === initial) viewRoot.value = params.get("at") ?? "";
      selectedRootId.value = initial;
    }
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

/** (Re)seed the map from the selected root's live generation, at the current scope anchor. */
async function loadRoot(): Promise<void> {
  const rootId = selectedRootId.value;
  if (!rootId) return;
  scanError.value = null;
  notScanned.value = false;
  seed.value = null;
  focusChain.value = [];
  focusChildren.value = [];
  focusOmittedTail.value = null;
  try {
    seed.value = await fetchTree(rootId, viewRoot.value, { minSize: settings.minSize });
  } catch (error) {
    // A 404 on a *scoped* read means the folder was removed/renamed by a rescan (the
    // root itself was scanned) — fall back to the full root with a notice rather than
    // an empty map (feature 0016). A 404 at the root is a genuine "not scanned yet".
    if (error instanceof NotScannedError && viewRoot.value) {
      scopeNotice.value = `"${viewRoot.value}" is no longer in this scan — showing the full root.`;
      viewRoot.value = "";
      syncUrl();
      return void loadRoot();
    }
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

function onFocus(payload: {
  chain: Array<{ id: number; name: string; path: string }>;
  children: TreeChild[];
  size: number;
  omittedTail?: { count: number; bytes: number };
}): void {
  focusChain.value = payload.chain;
  focusChildren.value = payload.children;
  focusSize.value = payload.size;
  focusOmittedTail.value = payload.omittedTail ?? null;
}

function flyToChild(child: TreeChild): void {
  if (child.kind !== "directory") return;
  const path = focusPath.value ? `${focusPath.value}/${child.name}` : child.name;
  mapRef.value?.flyToPath(path);
}

/** Reflect the current root + scope anchor into the URL query (linkable, refresh-safe). */
function syncUrl(): void {
  const url = new URL(location.href);
  if (viewRoot.value) {
    url.searchParams.set("root", selectedRootId.value);
    url.searchParams.set("at", viewRoot.value);
  } else {
    url.searchParams.delete("root");
    url.searchParams.delete("at");
  }
  history.replaceState(null, "", url);
}

/** Scope the map to a subfolder (feature 0016) — a distinct reseed, not a camera fly. */
function scopeTo(path: string): void {
  const next = path.replace(/^\/+|\/+$/g, "");
  if (next === viewRoot.value) return;
  scopeNotice.value = null;
  viewRoot.value = next;
  syncUrl();
  void loadRoot();
}

/** Scope to a directory child of the current focus (its path is root-relative). */
function scopeChild(child: TreeChild): void {
  if (child.kind !== "directory") return;
  scopeTo(focusPath.value ? `${focusPath.value}/${child.name}` : child.name);
}

/** Switch the configured root; scope is per-root, so clear it before the reseed. */
function onRootPick(id: string): void {
  viewRoot.value = "";
  syncUrl();
  selectedRootId.value = id; // the watch below reseeds + refreshes status
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
      <select
        :value="selectedRootId"
        :disabled="roots.length === 0"
        @change="onRootPick(($event.target as HTMLSelectElement).value)"
      >
        <option v-for="root in roots" :key="root.id" :value="root.id">{{ root.label }}</option>
      </select>
      <button :disabled="!selectedRootId" @click="onStartStop">{{ globalScanning ? "Stop" : "Scan" }}</button>
      <select v-model="settings.colorMode" class="color-mode" title="Tile color mode">
        <option value="type">Color: Type</option>
        <option value="age">Color: Age</option>
      </select>
      <button class="ghost" :class="{ active: showSettings }" @click="showSettings = !showSettings">⚙ Settings</button>
      <button v-if="authRequired" class="ghost" title="Log out" @click="signOut">Log out</button>

      <ScanStatus :scanner="scanner" :roots="roots" :root-status="rootStatus" :error="scanError" />
    </header>

    <SettingsModal
      :open="showSettings"
      :roots="roots"
      :root-id="selectedRootId"
      @close="showSettings = false"
      @schedule-saved="refreshRootStatus"
    />

    <Breadcrumbs
      :chain="crumbs"
      :can-scope-here="focusPath !== viewRoot"
      @navigate="(path) => mapRef?.flyToPath(path)"
      @rescope="scopeTo"
      @scope-here="scopeTo(focusPath)"
    />

    <div v-if="scopeNotice" class="scope-notice">
      {{ scopeNotice }}
      <button class="ghost" @click="scopeNotice = null">Dismiss</button>
    </div>

    <main v-if="seed" class="content">
      <div class="side">
        <nav class="tabs" role="tablist">
          <button role="tab" :class="{ active: activeTab === 'files' }" @click="activeTab = 'files'">Files</button>
          <button role="tab" :class="{ active: activeTab === 'types' }" @click="activeTab = 'types'">Types</button>
          <button role="tab" :class="{ active: activeTab === 'search' }" @click="activeTab = 'search'">Search</button>
        </nav>
        <div class="side-body">
          <FileList
            v-if="activeTab === 'files'"
            :children="focusChildren"
            :total-size="focusSize"
            :omitted-tail="focusOmittedTail"
            @select="flyToChild"
            @scope="scopeChild"
            @hover="(id) => (highlightedId = id)"
          />
          <TypeList
            v-else-if="activeTab === 'types'"
            :root-id="selectedRootId"
            :generation="generation"
            :path="focusPath"
          />
          <SearchPanel
            v-else
            :root-id="selectedRootId"
            :generation="generation"
            :focus-path="focusPath"
            @reveal="revealResult"
          />
        </div>
      </div>

      <section class="treemap-pane">
        <MapTreemap
          ref="mapRef"
          :root-id="selectedRootId"
          :seed="seed"
          :base-path="viewRoot"
          :highlight-id="highlightedId"
          @focus="onFocus"
          @hover="(node) => (hoveredNode = node)"
          @stale="loadRoot"
          @scope="scopeTo"
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

.scope-notice {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.4rem 1rem;
  font-size: 0.8rem;
  color: var(--muted);
  background: var(--hover);
  border-bottom: 1px solid var(--border);
}

.content {
  flex: 1;
  display: flex;
  min-height: 0;
}

.side {
  width: 280px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--border);
  background: var(--hover);
}

.tabs {
  display: flex;
  flex-shrink: 0;
  border-bottom: 1px solid var(--border);
}

.tabs button {
  flex: 1;
  padding: 0.5rem 0.4rem;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--muted);
  font: inherit;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  cursor: pointer;
}

.tabs button:hover {
  color: inherit;
}

.tabs button.active {
  color: var(--accent);
  border-bottom-color: var(--accent);
}

.side-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
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
