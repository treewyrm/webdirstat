<script setup lang="ts">
import { useDisplaySettings } from "../composables/useDisplaySettings";

/**
 * Toolbar for the treemap (tileview) — feature 0019 (prototype).
 *
 * A docked control strip *above* the map, not a global app control: it belongs to
 * this particular view, so a future non-treemap view can carry its own strip in the
 * same slot. It surfaces the now-richer canvas interaction model (tool + target) and
 * consolidates the tile-color controls that today float loose in the header / hide in
 * Settings, plus the selection status + export hooks.
 *
 * Prototype scope: the layout, the two segmented controls, and the color controls are
 * real (color binds the shared `settings` state). The interaction behavior behind the
 * tool/target switches and a live selection set land in follow-up work; the count is a
 * placeholder and the export buttons are inert.
 */

/**
 * Canvas interaction tool — Navigate pans/clicks; the two marquee tools each drag a
 * selection box but hit-test differently: `marquee` (Enclose) grabs only tiles the box
 * fully covers, `marquee-touch` (Touch) grabs any tile the box overlaps.
 */
export type Tool = "navigate" | "marquee" | "marquee-touch";
/** What a canvas click/marquee targets. */
export type TargetMode = "files" | "folders";

const props = defineProps<{
  tool: Tool;
  targetMode: TargetMode;
  /** Number of marked items in the selection set. */
  selectionCount: number;
  /** Pre-formatted total size (bytes) across the marks. */
  selectionSize: string;
}>();

const emit = defineEmits<{
  (e: "update:tool", value: Tool): void;
  (e: "update:targetMode", value: TargetMode): void;
  (e: "clear"): void;
  (e: "copy"): void;
  (e: "save"): void;
}>();

/** Color-mode + shaded controls bind the shared display settings (a relocation). */
const { settings } = useDisplaySettings();
</script>

<template>
  <div class="tile-toolbar" role="toolbar" aria-label="Tileview controls">
    <!-- Interaction tool: Navigate vs. Marquee (mutually exclusive) -->
    <div class="group segmented" role="group" aria-label="Interaction tool">
      <button
        type="button"
        :class="{ active: props.tool === 'navigate' }"
        :aria-pressed="props.tool === 'navigate'"
        title="Navigate — drag to pan, click to mark one"
        @click="emit('update:tool', 'navigate')"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" width="15" height="15">
          <path
            d="M3 2l9 4-3.6 1.3L7 11z"
            fill="currentColor"
            stroke="currentColor"
            stroke-width="1"
            stroke-linejoin="round"
          />
        </svg>
        <span class="label">Navigate</span>
      </button>
      <button
        type="button"
        :class="{ active: props.tool === 'marquee' }"
        :aria-pressed="props.tool === 'marquee'"
        title="Marquee (Enclose) — grabs only tiles the box fully covers (space-drag pans)"
        @click="emit('update:tool', 'marquee')"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" width="15" height="15">
          <rect
            x="2.5"
            y="2.5"
            width="11"
            height="11"
            rx="1"
            fill="none"
            stroke="currentColor"
            stroke-width="1.2"
            stroke-dasharray="2.5 2"
          />
          <rect x="5.5" y="5.5" width="5" height="5" rx="0.5" fill="currentColor" opacity="0.85" />
        </svg>
        <span class="label">Enclose</span>
      </button>
      <button
        type="button"
        :class="{ active: props.tool === 'marquee-touch' }"
        :aria-pressed="props.tool === 'marquee-touch'"
        title="Marquee (Touch) — grabs any tile the box overlaps (space-drag pans)"
        @click="emit('update:tool', 'marquee-touch')"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" width="15" height="15">
          <rect
            x="1.5"
            y="1.5"
            width="9"
            height="9"
            rx="1"
            fill="none"
            stroke="currentColor"
            stroke-width="1.2"
            stroke-dasharray="2.5 2"
          />
          <rect x="7" y="7" width="7.5" height="7.5" rx="0.5" fill="currentColor" opacity="0.85" />
        </svg>
        <span class="label">Touch</span>
      </button>
    </div>

    <!-- Selection target: Files vs. Folders (icon-only segmented) -->
    <div class="group segmented icon-only" role="group" aria-label="Selection target">
      <button
        type="button"
        :class="{ active: props.targetMode === 'files' }"
        :aria-pressed="props.targetMode === 'files'"
        title="Target files"
        @click="emit('update:targetMode', 'files')"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" width="15" height="15">
          <path
            d="M4 1.5h5l3 3v9.5a.5.5 0 01-.5.5H4a.5.5 0 01-.5-.5V2a.5.5 0 01.5-.5z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.1"
            stroke-linejoin="round"
          />
          <path d="M9 1.5V4.5h3" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" />
        </svg>
      </button>
      <button
        type="button"
        :class="{ active: props.targetMode === 'folders' }"
        :aria-pressed="props.targetMode === 'folders'"
        title="Target folders"
        @click="emit('update:targetMode', 'folders')"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" width="15" height="15">
          <path
            d="M1.8 3.5h4l1.2 1.5h7.2a.5.5 0 01.5.5v6.5a.5.5 0 01-.5.5H1.8a.5.5 0 01-.5-.5V4a.5.5 0 01.5-.5z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.1"
            stroke-linejoin="round"
          />
        </svg>
      </button>
    </div>

    <!-- View / color: color mode + cushion shading (relocated from header/Settings) -->
    <div class="group color">
      <select v-model="settings.colorMode" title="Tile color mode" aria-label="Tile color mode">
        <option value="type">Color: Type</option>
        <option value="age">Color: Age</option>
        <option value="folder">Color: Folder</option>
      </select>
      <label class="shaded" title="Shaded (cushion) tiles">
        <input v-model="settings.shaded" type="checkbox" />
        <span>Shaded</span>
      </label>
    </div>

    <!-- Selection status + export -->
    <div class="group status">
      <span class="count" :class="{ empty: props.selectionCount === 0 }">
        {{ props.selectionCount }} marked<template v-if="props.selectionCount > 0"> · {{ props.selectionSize }}</template>
      </span>
      <button type="button" class="text" :disabled="props.selectionCount === 0" @click="emit('clear')">Clear</button>
      <button type="button" class="text" :disabled="props.selectionCount === 0" @click="emit('copy')">Copy</button>
      <button type="button" class="text" :disabled="props.selectionCount === 0" @click="emit('save')">Save</button>
    </div>
  </div>
</template>

<style scoped>
.tile-toolbar {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
  padding: 0.4rem 0.6rem;
  border-bottom: 1px solid var(--border);
  background: var(--hover);
  font-size: 0.8rem;
}

.group {
  display: flex;
  align-items: center;
}

/* A visually-joined segmented control. */
.segmented {
  border: 1px solid var(--border);
  border-radius: 5px;
  overflow: hidden;
}

.segmented button {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.3rem 0.55rem;
  background: none;
  border: none;
  border-right: 1px solid var(--border);
  color: var(--muted);
  font: inherit;
  font-size: 0.8rem;
  cursor: pointer;
}

.segmented button:last-child {
  border-right: none;
}

.segmented button:hover {
  color: inherit;
}

.segmented button.active {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, transparent);
}

.segmented svg {
  display: block;
}

.icon-only button {
  padding: 0.3rem 0.5rem;
}

.color {
  gap: 0.6rem;
}

.color select {
  font-size: 0.8rem;
  padding: 0.2rem 0.3rem;
}

.shaded {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  color: var(--muted);
  cursor: pointer;
}

.status {
  gap: 0.5rem;
  margin-left: auto;
}

.count {
  color: var(--muted);
}

.count.empty {
  opacity: 0.6;
}

.text {
  background: none;
  border: none;
  color: var(--accent);
  font: inherit;
  font-size: 0.8rem;
  cursor: pointer;
  padding: 0.15rem 0.2rem;
}

.text:disabled {
  color: var(--muted);
  opacity: 0.5;
  cursor: default;
}
</style>
