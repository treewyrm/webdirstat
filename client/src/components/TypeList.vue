<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { TypeRollupResponse } from "@webdirstat/shared";
import { fetchTypes, NotScannedError } from "../api";
import { colorForExt } from "../utils/color";
import { formatBytes, formatCount } from "../utils/format";

/**
 * The "by type" panel (feature 0005): a per-root breakdown of space by file
 * extension, size-sorted. Self-fetching from rootId + the seeded generation, so it
 * reads the same generation the map is pinned to and refetches when either changes.
 */
const props = defineProps<{ rootId: string; generation: number | null }>();

const data = ref<TypeRollupResponse | null>(null);
const error = ref<string | null>(null);
const loading = ref(false);

watch([() => props.rootId, () => props.generation], load, { immediate: true });

async function load(): Promise<void> {
  error.value = null;
  if (!props.rootId) return;
  loading.value = true;
  try {
    data.value = await fetchTypes(props.rootId, props.generation ?? undefined);
  } catch (e) {
    data.value = null;
    error.value = e instanceof NotScannedError ? "Not scanned yet." : e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

/** Bars are scaled against the largest shown type, so the top type fills the row. */
const maxBytes = computed(() => data.value?.types[0]?.totalBytes ?? 0);
function barWidth(bytes: number): number {
  return maxBytes.value > 0 ? (bytes / maxBytes.value) * 100 : 0;
}

function label(ext: string): string {
  return ext ? `.${ext}` : "(no extension)";
}
</script>

<template>
  <aside class="types">
    <header class="head">By type</header>
    <p v-if="error" class="note err">{{ error }}</p>
    <p v-else-if="loading && !data" class="note">Loading…</p>
    <p v-else-if="data && data.types.length === 0" class="note">No files.</p>
    <template v-else-if="data">
      <div v-for="t in data.types" :key="t.ext" class="row" :title="`${label(t.ext)} — ${formatCount(t.totalCount)} files`">
        <div class="bar" :style="{ width: barWidth(t.totalBytes) + '%' }"></div>
        <span class="swatch" :style="{ background: colorForExt(t.ext) }"></span>
        <span class="ext" :class="{ none: !t.ext }">{{ label(t.ext) }}</span>
        <span class="count">{{ formatCount(t.totalCount) }}</span>
        <span class="size">{{ formatBytes(t.totalBytes) }}</span>
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
  padding: 0.5rem 0.6rem;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
  background: var(--hover);
  border-bottom: 1px solid var(--border);
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
