<script setup lang="ts">
/** Camera-derived focus trail; each click flies the map to that ancestor's path. */
defineProps<{ chain: Array<{ id: number; name: string; path: string }> }>();
const emit = defineEmits<{ navigate: [path: string] }>();
</script>

<template>
  <nav v-if="chain.length > 0" class="breadcrumbs">
    <button v-for="(node, index) in chain" :key="index" @click="emit('navigate', node.path)">
      {{ index === 0 ? node.name || "/" : node.name }}
    </button>
  </nav>
</template>

<style scoped>
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
</style>
