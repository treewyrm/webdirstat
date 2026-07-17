<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import type { ScanEvent, ScanRoot, ScanSummary, TreeChild, TreeSlice } from "@webdirstat/shared";
import { fetchRoots, fetchTree, NotScannedError, startScan } from "./api";
import type { TreemapNode } from "./types";
import { formatBytes, formatCount } from "./utils/format";
import Treemap from "./components/Treemap.vue";

const roots = ref<ScanRoot[]>([]);
const selectedRootId = ref<string>("");

const scanning = ref(false);
const scanError = ref<string | null>(null);
const notScanned = ref(false);
const progress = ref<{ entries: number; bytes: number; path: string } | null>(null);
const lastScanSummary = ref<ScanSummary | null>(null);

/** The generation every read in this session pins. */
const generation = ref<number | null>(null);
/** Breadcrumb of loaded slices, root → current focus. Each slice is one directory level. */
const stack = shallowRef<TreeSlice[]>([]);
const focus = computed<TreeSlice | null>(() => stack.value.at(-1) ?? null);
const hoveredNode = shallowRef<TreemapNode | null>(null);

let cancelScan: (() => void) | null = null;

const sortedChildren = computed<TreeChild[]>(() => focus.value?.children ?? []);

/** One-level treemap node synthesized from the focused slice (nested layout is M4). */
const treemapNode = computed<TreemapNode | null>(() => {
  const f = focus.value;
  if (!f) return null;
  return {
    id: f.node.id,
    name: f.node.name,
    kind: f.node.kind,
    size: f.node.size,
    childCount: f.node.childCount,
    children: f.children.map((c) => ({
      id: c.id,
      name: c.name,
      kind: c.kind,
      size: c.size,
      childCount: c.childCount,
      ...(c.ext != null ? { ext: c.ext } : {}),
      ...(c.error != null ? { error: c.error } : {}),
    })),
  };
});

onMounted(async () => {
  try {
    roots.value = await fetchRoots();
    if (roots.value.length > 0) selectedRootId.value = roots.value[0]!.id;
  } catch (error) {
    scanError.value = error instanceof Error ? error.message : String(error);
  }
});

onBeforeUnmount(() => cancelScan?.());

// Load whatever is already in the store whenever the selected root changes.
watch(selectedRootId, () => void loadRoot());

/** Fetches the root slice of the selected root from its live generation (if scanned). */
async function loadRoot(): Promise<void> {
  const rootId = selectedRootId.value;
  if (!rootId) return;
  scanError.value = null;
  notScanned.value = false;
  stack.value = [];
  generation.value = null;
  try {
    const slice = await fetchTree(rootId, "");
    generation.value = slice.generation;
    stack.value = [slice];
  } catch (error) {
    if (error instanceof NotScannedError) notScanned.value = true;
    else scanError.value = error instanceof Error ? error.message : String(error);
  }
}

function beginScan(): void {
  if (!selectedRootId.value || scanning.value) return;
  const rootId = selectedRootId.value;

  cancelScan?.();
  scanning.value = true;
  scanError.value = null;
  progress.value = null;

  cancelScan = startScan(rootId, {
    onEvent: (event: ScanEvent) => {
      if (event.type === "progress") {
        progress.value = { entries: event.entries, bytes: event.bytes, path: event.path };
      } else if (event.type === "done") {
        scanning.value = false;
        lastScanSummary.value = event.summary;
        void loadRoot();
      } else if (event.type === "error") {
        scanning.value = false;
        scanError.value = event.message;
      }
    },
    onError: () => {
      scanning.value = false;
      scanError.value = "Connection to the server was lost.";
    },
  });
}

/** Drills into a child directory by fetching its slice and pushing it on the stack. */
async function drillChild(node: { name: string; kind: string } | undefined): Promise<void> {
  const parent = focus.value;
  if (!parent || !node || node.kind !== "directory") return;
  const path = parent.path ? `${parent.path}/${node.name}` : node.name;
  try {
    const slice = await fetchTree(selectedRootId.value, path, { generation: generation.value ?? undefined });
    stack.value = [...stack.value, slice];
  } catch (error) {
    // A pinned generation that has been swapped/pruned out → re-seed from the live root.
    if (error instanceof Error && /410|Gone/.test(error.message)) void loadRoot();
    else scanError.value = error instanceof Error ? error.message : String(error);
  }
}

function jumpTo(index: number): void {
  stack.value = stack.value.slice(0, index + 1);
}

function percentOfFocus(node: TreeChild): number {
  const total = focus.value?.node.size ?? 0;
  return total > 0 ? (node.size / total) * 100 : 0;
}
</script>

<template>
  <div class="app">
    <header class="toolbar">
      <h1>WebDirStat</h1>
      <select v-model="selectedRootId" :disabled="scanning || roots.length === 0">
        <option v-for="root in roots" :key="root.id" :value="root.id">{{ root.label }}</option>
      </select>
      <button :disabled="!selectedRootId || scanning" @click="beginScan">
        {{ scanning ? "Scanning…" : "Scan" }}
      </button>

      <div v-if="scanning && progress" class="status">
        {{ formatCount(progress.entries) }} entries · {{ formatBytes(progress.bytes) }} · {{ progress.path }}
      </div>
      <div v-else-if="lastScanSummary" class="status">
        {{ formatCount(lastScanSummary.entries) }} entries · {{ formatBytes(lastScanSummary.bytes) }} in
        {{ (lastScanSummary.durationMs / 1000).toFixed(1) }}s · gen {{ lastScanSummary.generation }}
      </div>
      <div v-else-if="generation != null" class="status">
        stored data · gen {{ generation }}
      </div>
      <div v-if="scanError" class="status error">{{ scanError }}</div>
    </header>

    <nav v-if="stack.length > 0" class="breadcrumbs">
      <button v-for="(slice, index) in stack" :key="index" @click="jumpTo(index)">
        {{ index === 0 ? slice.node.name || "/" : slice.node.name }}
      </button>
    </nav>

    <main v-if="focus" class="content">
      <aside class="list-pane">
        <div
          v-for="child in sortedChildren"
          :key="child.id"
          class="list-row"
          :class="{ error: !!child.error, dir: child.kind === 'directory' }"
          @click="drillChild(child)"
        >
          <div class="bar" :style="{ width: percentOfFocus(child) + '%' }"></div>
          <span class="name">{{ child.name }}</span>
          <span class="size">{{ formatBytes(child.size) }}</span>
        </div>
        <p v-if="sortedChildren.length === 0" class="empty">Empty directory</p>
        <p v-if="focus.omittedTail" class="empty">
          + {{ formatCount(focus.omittedTail.count) }} smaller items ({{ formatBytes(focus.omittedTail.bytes) }})
        </p>
      </aside>

      <section class="treemap-pane">
        <Treemap
          v-if="treemapNode"
          :node="treemapNode"
          @drill="(chain) => drillChild(chain.at(-1))"
          @hover="(node) => (hoveredNode = node)"
        />
        <div v-if="hoveredNode" class="tooltip">
          {{ hoveredNode.name }} — {{ formatBytes(hoveredNode.size) }}
          <template v-if="hoveredNode.error">({{ hoveredNode.error }})</template>
        </div>
      </section>
    </main>

    <p v-else-if="notScanned && !scanning" class="placeholder">
      This root hasn't been scanned yet. Hit Scan to build the store.
    </p>
    <p v-else-if="!scanning" class="placeholder">Pick a root and hit Scan to see where your space went.</p>
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

.status {
  font-size: 0.85rem;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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
  display: flex;
  justify-content: space-between;
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

.list-row .name,
.list-row .size {
  position: relative;
  z-index: 1;
}

.list-row.error .name {
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

.placeholder {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
}
</style>
