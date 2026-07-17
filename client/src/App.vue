<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import type { ScanEvent, ScanNode, ScanRoot } from "@webdirstat/shared";
import { fetchRoots, startScan } from "./api";
import { formatBytes, formatCount } from "./utils/format";
import Treemap from "./components/Treemap.vue";

const roots = ref<ScanRoot[]>([]);
const selectedRootId = ref<string>("");

const scanning = ref(false);
const scanError = ref<string | null>(null);
const progress = ref<{ entries: number; bytes: number; path: string } | null>(null);
const lastScanSummary = ref<{ entries: number; bytes: number; durationMs: number } | null>(null);

const focusPath = shallowRef<ScanNode[]>([]);
const focus = computed<ScanNode | null>(() => focusPath.value.at(-1) ?? null);
const hoveredNode = shallowRef<ScanNode | null>(null);

let cancelScan: (() => void) | null = null;

const sortedChildren = computed<ScanNode[]>(() => focus.value?.children ?? []);

onMounted(async () => {
  try {
    roots.value = await fetchRoots();
    if (roots.value.length > 0) selectedRootId.value = roots.value[0]!.id;
  } catch (error) {
    scanError.value = error instanceof Error ? error.message : String(error);
  }
});

onBeforeUnmount(() => {
  cancelScan?.();
});

function beginScan(): void {
  if (!selectedRootId.value || scanning.value) return;

  cancelScan?.();
  scanning.value = true;
  scanError.value = null;
  progress.value = null;
  lastScanSummary.value = null;
  focusPath.value = [];

  cancelScan = startScan(selectedRootId.value, "", {
    onEvent: (event: ScanEvent) => {
      if (event.type === "progress") {
        progress.value = { entries: event.entries, bytes: event.bytes, path: event.path };
      } else if (event.type === "done") {
        scanning.value = false;
        lastScanSummary.value = { entries: event.entries, bytes: event.bytes, durationMs: event.durationMs };
        focusPath.value = [event.tree];
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

function drill(chain: ScanNode[]): void {
  focusPath.value = [...focusPath.value, ...chain];
}

function jumpTo(index: number): void {
  focusPath.value = focusPath.value.slice(0, index + 1);
}

function percentOfFocus(node: ScanNode): number {
  const total = focus.value?.size ?? 0;
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
        {{ (lastScanSummary.durationMs / 1000).toFixed(1) }}s
      </div>
      <div v-if="scanError" class="status error">{{ scanError }}</div>
    </header>

    <nav v-if="focusPath.length > 0" class="breadcrumbs">
      <button v-for="(node, index) in focusPath" :key="index" @click="jumpTo(index)">
        {{ index === 0 ? node.name || "/" : node.name }}
      </button>
    </nav>

    <main v-if="focus" class="content">
      <aside class="list-pane">
        <div
          v-for="child in sortedChildren"
          :key="child.name"
          class="list-row"
          :class="{ error: !!child.error }"
          @click="drill([child])"
        >
          <div class="bar" :style="{ width: percentOfFocus(child) + '%' }"></div>
          <span class="name">{{ child.name }}</span>
          <span class="size">{{ formatBytes(child.size) }}</span>
        </div>
        <p v-if="sortedChildren.length === 0" class="empty">Empty directory</p>
      </aside>

      <section class="treemap-pane">
        <Treemap :node="focus" @drill="drill" @hover="(node) => (hoveredNode = node)" />
        <div v-if="hoveredNode" class="tooltip">
          {{ hoveredNode.name }} — {{ formatBytes(hoveredNode.size) }}
          <template v-if="hoveredNode.error">({{ hoveredNode.error }})</template>
        </div>
      </section>
    </main>

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
  cursor: pointer;
  font-size: 0.85rem;
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
