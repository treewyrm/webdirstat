<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { TypeRollupResponse } from "@webdirstat/shared";
import { fetchTypes, NotScannedError } from "../api";
import { colorForExt, colorForFamily } from "../utils/color";
import { groupByFamily } from "../utils/families";
import { formatCount } from "../utils/format";
import { useByteFormat } from "../composables/useDisplaySettings";

const formatBytes = useByteFormat();

/**
 * The "by type" panel (feature 0005): a breakdown of space by file extension,
 * size-sorted. Self-fetching from rootId + the seeded generation, scoped to `path`
 * (the currently focused folder; "" = the whole root). Refetches when any of them
 * changes, debounced so flying through folders coalesces into one request.
 */
const props = defineProps<{ rootId: string; generation: number | null; path: string }>();

const data = ref<TypeRollupResponse | null>(null);
const error = ref<string | null>(null);
const loading = ref(false);
/** Raw per-extension rows vs. folded into families. Session-local for now; a persisted
 * preference belongs with the other display settings (feature 0007). */
const grouped = ref(false);

let timer: ReturnType<typeof setTimeout> | null = null;
watch([() => props.rootId, () => props.generation, () => props.path], scheduleLoad, { immediate: true });
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer);
});

/** The folder this breakdown covers, for the header ("root" at the top level). */
const scopeLabel = computed(() => props.path.split("/").filter(Boolean).at(-1) ?? "root");

/** Coalesce rapid path changes (fly-through) into a single fetch. */
function scheduleLoad(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void load(), 200);
}

async function load(): Promise<void> {
  error.value = null;
  if (!props.rootId) return;
  loading.value = true;
  try {
    data.value = await fetchTypes(props.rootId, props.path, props.generation ?? undefined);
  } catch (e) {
    data.value = null;
    error.value = e instanceof NotScannedError ? "Not scanned yet." : e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

/** A rendered row, unified across the raw and grouped views so the template is one loop. */
interface Row {
  key: string;
  label: string;
  color: string;
  count: number;
  bytes: number;
  /** The extension-less bucket, styled muted+italic. */
  muted: boolean;
}

const rows = computed<Row[]>(() => {
  const types = data.value?.types ?? [];
  if (!grouped.value) {
    return types.map((t) => ({
      key: t.ext || "(none)",
      label: t.ext ? `.${t.ext}` : "(no extension)",
      color: colorForExt(t.ext),
      count: t.totalCount,
      bytes: t.totalBytes,
      muted: !t.ext,
    }));
  }
  return groupByFamily(types).map((g) => ({
    key: g.key,
    label: g.label,
    // A passthrough single extension keeps its exact tile color; a family (no `ext`)
    // spans several extensions, so it gets a stable per-label swatch instead.
    color: g.ext !== undefined ? colorForExt(g.ext) : colorForFamily(g.label),
    count: g.totalCount,
    bytes: g.totalBytes,
    muted: g.ext === "",
  }));
});

/** Bars are scaled against the largest shown row, so the top row fills its width. */
const maxBytes = computed(() => rows.value[0]?.bytes ?? 0);
function barWidth(bytes: number): number {
  return maxBytes.value > 0 ? (bytes / maxBytes.value) * 100 : 0;
}
</script>

<template>
  <aside class="types">
    <header class="head">
      <span>By type <span class="scope" :title="path || 'root'">· {{ scopeLabel }}</span></span>
      <button
        class="toggle"
        :class="{ active: grouped }"
        :title="grouped ? 'Show raw extensions' : 'Group extensions into families'"
        @click="grouped = !grouped"
      >
        {{ grouped ? "Grouped" : "Raw" }}
      </button>
    </header>
    <p v-if="error" class="note err">{{ error }}</p>
    <p v-else-if="loading && !data" class="note">Loading…</p>
    <p v-else-if="data && rows.length === 0" class="note">No files.</p>
    <template v-else-if="data">
      <div v-for="r in rows" :key="r.key" class="row" :title="`${r.label} — ${formatCount(r.count)} files`">
        <div class="bar" :style="{ width: barWidth(r.bytes) + '%' }"></div>
        <span class="swatch" :style="{ background: r.color }"></span>
        <span class="ext" :class="{ none: r.muted }">{{ r.label }}</span>
        <span class="count">{{ formatCount(r.count) }}</span>
        <span class="size">{{ formatBytes(r.bytes) }}</span>
      </div>
      <p v-if="data.omittedTail" class="note tail">
        + {{ formatCount(data.omittedTail.count) }} more types · {{ formatBytes(data.omittedTail.bytes) }}
      </p>
    </template>
  </aside>
</template>

<style scoped>
.types {
  width: 260px;
  overflow-y: auto;
  border-right: 1px solid var(--border);
  flex-shrink: 0;
  background: var(--hover);
}

.head {
  position: sticky;
  top: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.5rem 0.6rem;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
  background: var(--hover);
  border-bottom: 1px solid var(--border);
}

.head .scope {
  color: var(--accent);
  text-transform: none;
  letter-spacing: 0;
}

.toggle {
  flex-shrink: 0;
  background: none;
  border: 1px solid var(--border);
  color: var(--muted);
  border-radius: 4px;
  padding: 0.1rem 0.4rem;
  font: inherit;
  font-size: 0.7rem;
  cursor: pointer;
}

.toggle.active {
  color: var(--accent);
  border-color: var(--accent);
}

.row {
  position: relative;
  display: grid;
  grid-template-columns: auto 1fr auto auto;
  gap: 0.4rem;
  align-items: center;
  padding: 0.3rem 0.6rem;
  font-size: 0.85rem;
}

.row > * {
  position: relative;
  z-index: 1;
}

.row .bar {
  position: absolute;
  inset: 0;
  z-index: 0;
  background: var(--bar);
}

.swatch {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  flex-shrink: 0;
}

.ext {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  min-width: 0;
  font-variant-numeric: tabular-nums;
}

.ext.none {
  color: var(--muted);
  font-style: italic;
}

.count {
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

.size {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.note {
  padding: 0.6rem;
  color: var(--muted);
  font-size: 0.85rem;
}

.note.tail {
  border-top: 1px solid var(--border);
}

.note.err {
  color: var(--danger);
}
</style>
