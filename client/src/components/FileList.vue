<script setup lang="ts">
import { computed } from "vue";
import type { TreeChild } from "@webdirstat/shared";
import { File, Folder, Link2 } from "@lucide/vue";
import { useByteFormat } from "../composables/useDisplaySettings";

const formatBytes = useByteFormat();

/** Max rows the pane renders before folding the rest into one summary row (feature 0015). */
const ROW_CAP = 50;

/**
 * Size-sorted children of the focused directory; clicking a row selects it.
 * `omittedTail` is the map's remainder past its fetch cap (count + summed bytes),
 * plumbed through so the pane's "… X more" row reports it instead of dropping it.
 */
const props = defineProps<{
  children: TreeChild[];
  totalSize: number;
  omittedTail?: { count: number; bytes: number } | null;
}>();
const emit = defineEmits<{
  select: [child: TreeChild];
  /** The hovered row's node id (feature 0012, list → map highlight), or null on leave. */
  hover: [id: number | null];
}>();

/** The rows actually drawn: at most ROW_CAP, largest-first (children arrive sorted). */
const visibleChildren = computed(() => props.children.slice(0, ROW_CAP));

/**
 * The single folded remainder: rows hidden by the cap plus the map's omitted tail.
 * `null` when nothing is hidden, so the summary row is omitted entirely.
 */
const remainder = computed(() => {
  const hidden = props.children.slice(ROW_CAP);
  const count = hidden.length + (props.omittedTail?.count ?? 0);
  if (count === 0) return null;
  const bytes = hidden.reduce((sum, c) => sum + c.size, 0) + (props.omittedTail?.bytes ?? 0);
  return { count, bytes };
});

/** Leading list-row glyph for a child's kind (directory / symlink / everything else). */
function iconForKind(kind: TreeChild["kind"]) {
  if (kind === "directory") return Folder;
  if (kind === "symlink") return Link2;
  return File;
}

function percentOfTotal(node: TreeChild): number {
  return props.totalSize > 0 ? (node.size / props.totalSize) * 100 : 0;
}
</script>

<template>
  <aside class="list-pane">
    <div
      v-for="child in visibleChildren"
      :key="child.id"
      class="list-row"
      :class="{ error: !!child.error, dir: child.kind === 'directory' }"
      @click="emit('select', child)"
      @mouseenter="emit('hover', child.id)"
      @mouseleave="emit('hover', null)"
    >
      <div class="bar" :style="{ width: percentOfTotal(child) + '%' }"></div>
      <component :is="iconForKind(child.kind)" class="icon" :size="14" aria-hidden="true" />
      <span class="name" :title="child.name">{{ child.name }}</span>
      <span class="size">{{ formatBytes(child.size) }}</span>
    </div>
    <!-- The list analog of the map's omitted-tail tile: muted, dashed, inert. -->
    <div v-if="remainder" class="list-row more">
      <File class="icon" :size="14" aria-hidden="true" />
      <span class="name">… {{ remainder.count.toLocaleString() }} more</span>
      <span class="size">{{ formatBytes(remainder.bytes) }}</span>
    </div>
    <p v-if="children.length === 0" class="empty">Empty directory</p>
  </aside>
</template>

<style scoped>
.list-pane {
  /* Sizing, scroll, and border are owned by the shared side shell (App.vue). */
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

.list-row.more {
  color: var(--muted);
  border-top: 1px dashed var(--border);
  cursor: default;
  font-style: italic;
}

.list-row.more:hover {
  background: transparent;
}

.list-row.more .icon {
  color: var(--muted);
}

.empty {
  padding: 0.6rem;
  color: var(--muted);
  font-size: 0.85rem;
}
</style>
