<script setup lang="ts">
import { ref, watch } from "vue";
import type { RootSchedule } from "@webdirstat/shared";
import { fetchSchedule, putSchedule } from "../api";
import { formatWindows, parseWindows } from "../utils/windows";

const props = defineProps<{ rootId: string }>();
const emit = defineEmits<{ saved: [] }>();

const schedule = ref<RootSchedule | null>(null);
const windowsText = ref("");
const intervalHours = ref<number | null>(null);
const minIntervalMinutes = ref<number>(60);
const error = ref<string | null>(null);
const saving = ref(false);
const savedAt = ref(false);

watch(() => props.rootId, load, { immediate: true });

async function load(): Promise<void> {
  error.value = null;
  savedAt.value = false;
  if (!props.rootId) return;
  try {
    const s = await fetchSchedule(props.rootId);
    schedule.value = s;
    windowsText.value = formatWindows(s.windows);
    intervalHours.value = s.intervalMs != null ? s.intervalMs / 3_600_000 : null;
    minIntervalMinutes.value = Math.round(s.minIntervalMs / 60_000);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function save(): Promise<void> {
  if (!schedule.value) return;
  error.value = null;
  savedAt.value = false;
  let windows;
  try {
    windows = parseWindows(windowsText.value);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    return;
  }
  const next: RootSchedule = {
    ...schedule.value,
    windows,
    intervalMs: intervalHours.value != null && intervalHours.value > 0 ? Math.round(intervalHours.value * 3_600_000) : null,
    minIntervalMs: Math.max(0, Math.round(minIntervalMinutes.value * 60_000)),
  };
  saving.value = true;
  try {
    schedule.value = await putSchedule(props.rootId, next);
    savedAt.value = true;
    emit("saved");
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <form v-if="schedule" class="schedule" @submit.prevent="save">
    <label class="row toggle">
      <input v-model="schedule.enabled" type="checkbox" />
      <span>Automatic scanning</span>
    </label>

    <label class="row">
      <span>Refresh every (hours)</span>
      <input v-model.number="intervalHours" type="number" min="0" step="0.5" placeholder="off" />
    </label>

    <label class="row">
      <span>Quiet-hours windows</span>
      <input v-model="windowsText" type="text" placeholder="Mon-Fri 01:00-05:00; Sat,Sun 00:00-08:00" />
    </label>

    <label class="row">
      <span>Timezone</span>
      <input v-model="schedule.timezone" type="text" placeholder="Europe/Moscow" />
    </label>

    <label class="row">
      <span>Concurrency</span>
      <input v-model.number="schedule.concurrency" type="number" min="1" />
    </label>
    <label class="row">
      <span>Min gap (min)</span>
      <input v-model.number="minIntervalMinutes" type="number" min="0" />
    </label>
    <label class="row">
      <span>On window end</span>
      <select v-model="schedule.onWindowEnd">
        <option value="finish">finish</option>
        <option value="abort">abort</option>
      </select>
    </label>
    <label class="row">
      <span>History gens</span>
      <input v-model.number="schedule.historyGenerations" type="number" min="0" />
    </label>

    <div class="actions">
      <button type="submit" :disabled="saving">{{ saving ? "Saving…" : "Save schedule" }}</button>
      <span v-if="savedAt" class="ok">Saved</span>
      <span v-if="error" class="err">{{ error }}</span>
    </div>
  </form>
</template>

<style scoped>
.schedule {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  font-size: 0.85rem;
}

.row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.row > span {
  color: var(--muted);
  min-width: 9rem;
}

.row.toggle > span {
  min-width: 0;
}

.row input[type="text"],
.row input[type="number"],
.row select {
  flex: 1;
  min-width: 0;
  padding: 0.25rem 0.4rem;
}

.actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.actions .ok {
  color: var(--accent);
}

.actions .err {
  color: var(--danger);
}
</style>
