<script setup lang="ts">
import type { TreeChild } from "@webdirstat/shared";
import { File, Folder, Link2 } from "@lucide/vue";
import { formatBytes } from "../utils/format";

/** Size-sorted children of the focused directory; clicking a row selects it. */
const props = defineProps<{ children: TreeChild[]; totalSize: number }>();
const emit = defineEmits<{ select: [child: TreeChild] }>();

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
      v-for="child in children"
      :key="child.id"
      class="list-row"
      :class="{ error: !!child.error, dir: child.kind === 'directory' }"
      @click="emit('select', child)"
    >
      <div class="bar" :style="{ width: percentOfTotal(child) + '%' }"></div>
      <component :is="iconForKind(child.kind)" class="icon" :size="14" aria-hidden="true" />
      <span class="name" :title="child.name">{{ child.name }}</span>
      <span class="size">{{ formatBytes(child.size) }}</span>
    </div>
    <p v-if="children.length === 0" class="empty">Empty directory</p>
  </aside>
</template>

<style scoped>
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
</style>
