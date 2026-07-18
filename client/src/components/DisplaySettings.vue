<script setup lang="ts">
import { useDisplaySettings } from "../composables/useDisplaySettings";

/** The "Display" category of the settings modal — client-local, global prefs. */
const { settings, reset } = useDisplaySettings();
</script>

<template>
  <form class="display" @submit.prevent>
    <label class="row toggle">
      <input v-model="settings.hoverFullPath" type="checkbox" />
      <span>Hover label shows full path</span>
    </label>

    <label class="row toggle">
      <input v-model="settings.shaded" type="checkbox" />
      <span>Shaded (cushion) tiles</span>
    </label>

    <label class="row">
      <span>Size units</span>
      <select v-model="settings.sizeUnits">
        <option value="binary">Binary — KiB, MiB, GiB</option>
        <option value="decimal">Decimal — KB, MB, GB</option>
      </select>
    </label>

    <div class="actions">
      <button type="button" class="reset" @click="reset">Restore defaults</button>
    </div>
  </form>
</template>

<style scoped>
.display {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  font-size: 0.85rem;
}

.row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.row > span {
  color: var(--muted);
  min-width: 11rem;
}

.row.toggle > span {
  min-width: 0;
}

.row select {
  flex: 1;
  min-width: 0;
  padding: 0.25rem 0.4rem;
}

.actions {
  margin-top: 0.25rem;
}

.reset {
  background: none;
  border: 1px solid var(--border);
  color: var(--muted);
  border-radius: 4px;
  padding: 0.25rem 0.6rem;
  cursor: pointer;
}
</style>
