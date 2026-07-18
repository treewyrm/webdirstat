<script setup lang="ts">
import { computed } from "vue";
import type { RootStatus, ScannerStatus, ScanRoot } from "@webdirstat/shared";
import { formatAgo, formatCount, formatUntil } from "../utils/format";
import { useByteFormat } from "../composables/useDisplaySettings";

const formatBytes = useByteFormat();

const props = defineProps<{
  scanner: ScannerStatus;
  roots: ScanRoot[];
  rootStatus: RootStatus | null;
  error: string | null;
}>();

const rootLabel = (id: string) => props.roots.find((r) => r.id === id)?.label ?? id;

/** Live progress line while a scan is running/swapping, or null when idle. */
const scanLine = computed<string | null>(() => {
  const s = props.scanner.state;
  if (s.phase === "idle") return null;
  const who = `${rootLabel(s.root)} (${s.trigger})`;
  if (s.phase === "swapping") return `Swapping in ${who}…`;
  if (s.progress) {
    return `Scanning ${who}: ${formatCount(s.progress.entries)} entries · ${formatBytes(s.progress.bytes)} · ${s.progress.path}`;
  }
  return `Scanning ${who}…`;
});
</script>

<template>
  <div v-if="scanLine" class="status">{{ scanLine }}</div>
  <div v-else-if="rootStatus" class="status">
    <template v-if="rootStatus.generation != null">
      {{ formatCount(rootStatus.totalCount ?? 0) }} entries ·
      {{ formatBytes(rootStatus.totalBytes ?? 0) }} ·
      scanned {{ formatAgo(rootStatus.lastScanEndedAt) }}
      <span v-if="rootStatus.lastScanStatus && rootStatus.lastScanStatus !== 'ok'" class="badge">
        ({{ rootStatus.lastScanStatus }})
      </span>
      <span v-if="rootStatus.enabled && rootStatus.nextScanAt" class="muted">
        · next {{ formatUntil(rootStatus.nextScanAt) }}
      </span>
      <span v-else-if="!rootStatus.enabled" class="muted">· manual only</span>
    </template>
    <template v-else>not scanned yet</template>
  </div>
  <div v-if="error" class="status error">{{ error }}</div>
</template>

<style scoped>
.status {
  font-size: 0.85rem;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  /* Take the remaining toolbar width and allow shrinking below content size, so a
     long scan path ellipsizes here instead of wrapping the whole header to a new row. */
  flex: 1;
  min-width: 0;
}

.status .badge {
  color: var(--danger);
}

.status .muted {
  color: var(--muted);
}

.status.error {
  color: var(--danger);
}
</style>
