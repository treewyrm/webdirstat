<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { SearchParams, SearchResponse, SearchResult, SearchSort } from "@webdirstat/shared";
import { fetchSearch, NotScannedError } from "../api";
import { formatCount } from "../utils/format";
import { useByteFormat } from "../composables/useDisplaySettings";

const formatBytes = useByteFormat();

/**
 * Search & filter panel (feature 0004). Self-fetches from `rootId` + the seeded
 * `generation`; when scope is "here" it restricts to `focusPath` (the folder the
 * camera currently frames). Every filter is optional and ANDed server-side — an
 * empty form is a valid "biggest files" listing. Clicking a result asks the map to
 * reveal it (`reveal` event); the map seeds the spine and flies there.
 */
const props = defineProps<{ rootId: string; generation: number | null; focusPath: string }>();
const emit = defineEmits<{ reveal: [SearchResult] }>();

// Raw form inputs (strings from <input>, parsed into predicates below).
const nameLike = ref("");
const minSizeMb = ref("");
const ext = ref("");
const olderDays = ref("");
const scope = ref<"root" | "here">("root");
const sort = ref<SearchSort>("size");

const data = ref<SearchResponse | null>(null);
const error = ref<string | null>(null);
const loading = ref(false);

const DAY_MS = 86_400_000;
const MB = 1_000_000; // input is in MB (decimal), matching the size unit labels

/** The folder name "here" scopes to, for the toggle label (root at the top level). */
const hereLabel = computed(() => props.focusPath.split("/").filter(Boolean).at(-1) ?? "root");

/** Parses the form into a {@link SearchParams}, omitting blank/garbage predicates. */
const params = computed<SearchParams>(() => {
  const p: SearchParams = { root: props.rootId, sort: sort.value };
  if (props.generation != null) p.generation = props.generation;
  const name = nameLike.value.trim();
  if (name) p.nameLike = name;
  const mb = Number(minSizeMb.value);
  if (minSizeMb.value.trim() && Number.isFinite(mb) && mb > 0) p.minSize = Math.floor(mb * MB);
  const e = ext.value.trim().replace(/^\.+/, "");
  if (e) p.ext = e;
  const days = Number(olderDays.value);
  if (olderDays.value.trim() && Number.isFinite(days) && days > 0) p.olderThan = Date.now() - days * DAY_MS;
  if (scope.value === "here" && props.focusPath) {
    p.scope = "here";
    p.path = props.focusPath;
  }
  return p;
});

let timer: ReturnType<typeof setTimeout> | null = null;
let seq = 0;
watch([params, () => props.rootId, () => props.generation], scheduleLoad, { immediate: true });
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer);
});

/** Coalesce keystrokes / rapid focus changes into one request. */
function scheduleLoad(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void load(), 250);
}

async function load(): Promise<void> {
  if (!props.rootId || props.generation == null) return;
  error.value = null;
  loading.value = true;
  const mine = ++seq; // drop out-of-order responses from superseded queries
  try {
    const res = await fetchSearch(params.value);
    if (mine === seq) data.value = res;
  } catch (e) {
    if (mine !== seq) return;
    data.value = null;
    error.value = e instanceof NotScannedError ? "Not scanned yet." : e instanceof Error ? e.message : String(e);
  } finally {
    if (mine === seq) loading.value = false;
  }
}

/** Directory portion of a result path, shown muted before the file name. */
function dirOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash > 0 ? path.slice(0, slash + 1) : "";
}
</script>

<template>
  <aside class="search">
    <header class="head">
      <span>Search</span>
      <button
        class="toggle"
        :class="{ active: scope === 'here' }"
        :disabled="!focusPath"
        :title="focusPath ? `Search within ${hereLabel}` : 'Navigate into a folder to scope here'"
        @click="scope = scope === 'here' ? 'root' : 'here'"
      >
        {{ scope === "here" ? `Here · ${hereLabel}` : "Everywhere" }}
      </button>
    </header>

    <div class="filters">
      <input v-model="nameLike" class="f-name" type="search" placeholder="name contains…" />
      <div class="f-row">
        <input v-model="minSizeMb" class="f-num" type="number" min="0" placeholder="min MB" title="Minimum size, MB" />
        <input v-model="ext" class="f-ext" type="text" placeholder="ext" title="Extension, e.g. iso" />
      </div>
      <div class="f-row">
        <input
          v-model="olderDays"
          class="f-num"
          type="number"
          min="0"
          placeholder="older than (days)"
          title="Not modified within this many days"
        />
        <select v-model="sort" class="f-sort" title="Sort results by">
          <option value="size">Size</option>
          <option value="mtime">Modified</option>
          <option value="name">Name</option>
        </select>
      </div>
    </div>

    <p v-if="error" class="note err">{{ error }}</p>
    <p v-else-if="loading && !data" class="note">Searching…</p>
    <p v-else-if="data && data.results.length === 0" class="note">No matches.</p>
    <template v-else-if="data">
      <button
        v-for="r in data.results"
        :key="r.id"
        class="row"
        :title="r.path"
        @click="emit('reveal', r)"
      >
        <span class="name"><span class="dir">{{ dirOf(r.path) }}</span>{{ r.name }}</span>
        <span class="size">{{ formatBytes(r.size) }}</span>
      </button>
      <p v-if="data.omittedCount > 0" class="note tail">
        + {{ formatCount(data.omittedCount) }} more — narrow the filters
      </p>
    </template>
  </aside>
</template>

<style scoped>
.search {
  width: 280px;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  border-right: 1px solid var(--border);
  flex-shrink: 0;
  background: var(--hover);
}

.head {
  position: sticky;
  top: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.5rem 0.6rem;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
  background: var(--hover);
  border-bottom: 1px solid var(--border);
  z-index: 2;
}

.toggle {
  flex-shrink: 0;
  max-width: 60%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  background: none;
  border: 1px solid var(--border);
  color: var(--muted);
  border-radius: 4px;
  padding: 0.1rem 0.4rem;
  font: inherit;
  font-size: 0.7rem;
  cursor: pointer;
}

.toggle.active {
  color: var(--accent);
  border-color: var(--accent);
}

.toggle:disabled {
  opacity: 0.5;
  cursor: default;
}

.filters {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.6rem;
  border-bottom: 1px solid var(--border);
}

.filters input,
.filters select {
  font: inherit;
  font-size: 0.85rem;
  background: var(--bg);
  color: inherit;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0.25rem 0.4rem;
  min-width: 0;
}

.f-row {
  display: flex;
  gap: 0.4rem;
}

.f-name {
  width: 100%;
}

.f-num {
  flex: 1;
}

.f-ext,
.f-sort {
  flex: 1;
}

.row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
  width: 100%;
  text-align: left;
  padding: 0.3rem 0.6rem;
  font: inherit;
  font-size: 0.85rem;
  background: none;
  border: none;
  border-bottom: 1px solid transparent;
  color: inherit;
  cursor: pointer;
}

.row:hover {
  background: var(--bg);
}

.name {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  min-width: 0;
}

.name .dir {
  color: var(--muted);
}

.size {
  flex-shrink: 0;
  color: var(--muted);
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
