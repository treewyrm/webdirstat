<script setup lang="ts">
import { computed } from "vue";
import type { TreeChild } from "@webdirstat/shared";
import { File, Folder, Link2, Maximize2 } from "@lucide/vue";
import { useByteFormat } from "../composables/useDisplaySettings";
import { useSelection } from "../composables/useSelection";

const formatBytes = useByteFormat();
const selection = useSelection();

/** Max rows the pane renders before folding the rest into one summary row (feature 0015). */
const ROW_CAP = 50;

/**
 * Size-sorted children of the focused directory; clicking a row selects it.
 * `omittedTail` is the map's remainder past its fetch cap (count + summed bytes),
 * plumbed through so the pane's "… X more" row reports it instead of dropping it.
 * `rootId` + `basePath` (the focused directory's root-relative path) let each row read
 * and write the shared, path-keyed selection set (feature 0019).
 */
const props = defineProps<{
  children: TreeChild[];
  totalSize: number;
  omittedTail?: { count: number; bytes: number } | null;
  rootId: string;
  basePath: string;
}>();

/** Root-relative path of a child, the key it selects under. */
function pathOf(child: TreeChild): string {
  return props.basePath ? `${props.basePath}/${child.name}` : child.name;
}
/** A row is checked when it's an exact mark or subsumed by a marked ancestor. */
function isChecked(child: TreeChild): boolean {
  return selection.isCovered(props.rootId, pathOf(child));
}
/** Subsumed-by-ancestor rows are checked but locked — un-marking would fracture a folder (v2). */
function isLocked(child: TreeChild): boolean {
  const path = pathOf(child);
  return selection.isCovered(props.rootId, path) && !selection.has(props.rootId, path);
}
function toggleMark(child: TreeChild): void {
  selection.toggle(props.rootId, pathOf(child));
}
const emit = defineEmits<{
  select: [child: TreeChild];
  /** Scope the map to this directory (feature 0016) — button click or shift-click a row. */
  scope: [child: TreeChild];
  /** The hovered row's node id (feature 0012, list → map highlight), or null on leave. */
  hover: [id: number | null];
}>();

/** A row click flies in; shift-click scopes the map to that folder (feature 0016). */
function onRowClick(child: TreeChild, event: MouseEvent): void {
  if (event.shiftKey && child.kind === "directory") emit("scope", child);
  else emit("select", child);
}

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
      @click="onRowClick(child, $event)"
      @mouseenter="emit('hover', child.id)"
      @mouseleave="emit('hover', null)"
    >
      <div class="bar" :style="{ width: percentOfTotal(child) + '%' }"></div>
      <input
        class="mark"
        type="checkbox"
        :checked="isChecked(child)"
        :disabled="isLocked(child)"
        :title="isLocked(child) ? 'Covered by a marked parent folder' : 'Mark for export'"
        @click.stop="toggleMark(child)"
      />
      <component :is="iconForKind(child.kind)" class="icon" :size="14" aria-hidden="true" />
      <span class="name" :title="child.name">{{ child.name }}</span>
      <span class="size">{{ formatBytes(child.size) }}</span>
      <!-- Scope-to-folder (feature 0016): icon-only, hover-revealed, so it costs no width. -->
      <button
        v-if="child.kind === 'directory'"
        class="scope-btn"
        title="Scope map to this folder"
        aria-label="Scope map to this folder"
        @click.stop="emit('scope', child)"
      >
        <Maximize2 :size="13" aria-hidden="true" />
      </button>
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
  grid-template-columns: auto auto 1fr auto;
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

.list-row .mark,
.list-row .icon,
.list-row .name,
.list-row .size {
  position: relative;
  z-index: 1;
}

.list-row .mark {
  margin: 0;
  cursor: pointer;
  /* Dim until the row (or the box) is hovered, so unmarked rows stay visually quiet. */
  opacity: 0.35;
}

.list-row .mark:checked,
.list-row:hover .mark {
  opacity: 1;
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

/*
 * Icon-only scope button (feature 0016): parked at the row's trailing edge, revealed
 * only on row hover so it never claims layout width. It overlays the size chip while
 * hovering (the size is re-readable the moment the pointer leaves).
 */
.list-row .scope-btn {
  position: absolute;
  z-index: 2;
  top: 50%;
  right: 0.4rem;
  transform: translateY(-50%);
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: var(--hover);
  color: var(--muted);
  cursor: pointer;
  opacity: 0;
  pointer-events: none;
}

.list-row:hover .scope-btn {
  opacity: 1;
  pointer-events: auto;
}

.list-row .scope-btn:hover {
  color: var(--accent);
  background: var(--border);
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
