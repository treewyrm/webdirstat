<script setup lang="ts">
/**
 * Camera-derived focus trail, optionally prefixed by above-scope ancestors when the
 * view is scoped to a subfolder (feature 0016). Two behaviours share the strip:
 *   - in-scope crumbs *fly* the map to that ancestor (`navigate`, root-relative path);
 *   - above-scope crumbs (dimmed) *re-scope outward* to that ancestor (`rescope`) — they
 *     aren't in the current world, so flying can't reach them.
 * A trailing ⤢ control scopes the map to the current focus (`scopeHere`).
 */
import { Maximize2 } from "@lucide/vue";

defineProps<{
  chain: Array<{ id?: number; name: string; path: string; aboveScope?: boolean }>;
  /** Show the "scope here" control — only when the focus is deeper than the scope root. */
  canScopeHere?: boolean;
}>();
const emit = defineEmits<{ navigate: [path: string]; rescope: [path: string]; scopeHere: [] }>();
</script>

<template>
  <nav v-if="chain.length > 0" class="breadcrumbs">
    <button
      v-for="(node, index) in chain"
      :key="index"
      class="crumb"
      :class="{ above: node.aboveScope }"
      :title="node.aboveScope ? 'Scope out to here' : undefined"
      @click="node.aboveScope ? emit('rescope', node.path) : emit('navigate', node.path)"
    >
      {{ index === 0 ? node.name || "/" : node.name }}
    </button>
    <button v-if="canScopeHere" class="scope-here" title="Scope map to the current folder" aria-label="Scope map to the current folder" @click="emit('scopeHere')">
      <Maximize2 :size="13" aria-hidden="true" />
    </button>
  </nav>
</template>

<style scoped>
.breadcrumbs {
  display: flex;
  align-items: center;
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

/* Above-scope ancestors: present as context and the way out, but visually recessed. */
.breadcrumbs button.above {
  color: var(--muted);
}

.breadcrumbs button.above:hover {
  color: var(--accent);
}

/* Separator between adjacent crumbs only — not after the deepest, and not before ⤢. */
.breadcrumbs button.crumb:has(+ button.crumb)::after {
  content: "/";
  margin-left: 0.25rem;
  color: var(--muted);
}

.breadcrumbs .scope-here {
  display: grid;
  place-items: center;
  margin-left: 0.15rem;
  padding: 0.15rem;
  color: var(--muted);
  border-radius: 4px;
  flex-shrink: 0;
}

.breadcrumbs .scope-here:hover {
  color: var(--accent);
  background: var(--hover);
}
</style>
