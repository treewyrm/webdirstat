<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { ScanRoot } from "@webdirstat/shared";
import DisplaySettings from "./DisplaySettings.vue";
import ScheduleEditor from "./ScheduleEditor.vue";

/**
 * The unified settings modal (feature 0007). A native `<dialog>` — free backdrop,
 * focus-trap, Esc-to-close — with a category rail on the left and the active
 * category's panel on the right. Home for everything configurable: client-local
 * Display prefs and the per-root server scan schedule.
 */
const props = defineProps<{
  open: boolean;
  roots: ScanRoot[];
  /** Seeds the modal-wide root switcher when opened. */
  rootId: string;
}>();
const emit = defineEmits<{ close: []; "schedule-saved": [] }>();

type Category = "display" | "scanning";
const category = ref<Category>("display");

/** Per-root categories drive the header root switcher; global ones ignore it. */
const perRoot = computed(() => category.value === "scanning");

/** The root the per-root categories configure — modal-local, seeded on open, so
 * changing it here doesn't renavigate the main view. */
const activeRoot = ref(props.rootId);

const dialog = ref<HTMLDialogElement | null>(null);

watch(
  () => props.open,
  (open) => {
    const el = dialog.value;
    if (!el) return;
    if (open) {
      activeRoot.value = props.rootId;
      if (!el.open) el.showModal();
    } else if (el.open) {
      el.close();
    }
  },
);

/** Backdrop click (target is the dialog itself; inner shell stops propagation). */
function onDialogClick(event: MouseEvent): void {
  if (event.target === dialog.value) emit("close");
}
</script>

<template>
  <dialog ref="dialog" class="settings" @close="emit('close')" @click="onDialogClick">
    <div class="shell" @click.stop>
      <header class="head">
        <h2>Settings</h2>
        <select v-if="perRoot" v-model="activeRoot" class="root-switch" aria-label="Root">
          <option v-for="root in roots" :key="root.id" :value="root.id">{{ root.label }}</option>
        </select>
        <button class="close" type="button" aria-label="Close" @click="emit('close')">✕</button>
      </header>

      <div class="body">
        <nav class="rail">
          <button type="button" :class="{ active: category === 'display' }" @click="category = 'display'">Display</button>
          <button type="button" :class="{ active: category === 'scanning' }" @click="category = 'scanning'">Scanning</button>
        </nav>

        <section class="panel">
          <DisplaySettings v-if="category === 'display'" />
          <ScheduleEditor
            v-else-if="category === 'scanning' && activeRoot"
            :root-id="activeRoot"
            @saved="emit('schedule-saved')"
          />
        </section>
      </div>
    </div>
  </dialog>
</template>

<style scoped>
.settings {
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  color: inherit;
  width: min(640px, 92vw);
  max-height: 85vh;
}

.settings::backdrop {
  background: rgba(0, 0, 0, 0.5);
}

.shell {
  display: flex;
  flex-direction: column;
  max-height: 85vh;
}

.head {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border);
}

.head h2 {
  margin: 0;
  font-size: 1rem;
}

.root-switch {
  margin-left: auto;
  padding: 0.2rem 0.4rem;
}

.close {
  margin-left: auto;
  background: none;
  border: none;
  color: var(--muted);
  font-size: 1rem;
  line-height: 1;
  cursor: pointer;
  padding: 0.25rem;
}

/* When the switcher is present it takes the margin-left:auto slot; keep the
   close button hard against the right edge. */
.root-switch ~ .close {
  margin-left: 0;
}

.close:hover {
  color: inherit;
}

.body {
  display: flex;
  min-height: 0;
}

.rail {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  width: 9rem;
  padding: 0.5rem;
  gap: 0.25rem;
  border-right: 1px solid var(--border);
}

.rail button {
  text-align: left;
  background: none;
  border: none;
  border-radius: 4px;
  color: var(--muted);
  padding: 0.4rem 0.6rem;
  font: inherit;
  font-size: 0.85rem;
  cursor: pointer;
}

.rail button:hover {
  background: var(--hover);
}

.rail button.active {
  color: var(--accent);
  background: var(--hover);
}

.panel {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 1rem;
}
</style>
