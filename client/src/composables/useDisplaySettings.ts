import { reactive, watch } from "vue";
import { formatBytes, type SizeUnitBase } from "../utils/format";

/**
 * Client-local, per-device display preferences (feature 0007). These live in the
 * browser, not the server store — the store is about *what was scanned*; these are
 * about *how one person likes to look at it*. Persisted under one namespaced key,
 * with a `version` so a future shape change can be migrated or discarded rather
 * than throwing on stale JSON.
 */
export interface DisplaySettings {
  version: number;
  /** Tooltip on hover shows the full relative path vs. just the leaf name. */
  hoverFullPath: boolean;
  /** Binary (KiB/MiB) vs. decimal (KB/MB) byte units. */
  sizeUnits: SizeUnitBase;
  /** Cushion (shaded) tile rendering vs. the flat fill (feature 0010). */
  shaded: boolean;
}

const KEY = "wds.display";
const VERSION = 1;

function defaults(): DisplaySettings {
  return { version: VERSION, hoverFullPath: false, sizeUnits: "binary", shaded: false };
}

function load(): DisplaySettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const parsed = JSON.parse(raw) as Partial<DisplaySettings> | null;
    // Unknown/older shape: start clean rather than trust stale fields.
    if (!parsed || parsed.version !== VERSION) return defaults();
    return { ...defaults(), ...parsed, version: VERSION };
  } catch {
    return defaults();
  }
}

/** One shared reactive object across every consumer + one persistence writer. */
const state = reactive<DisplaySettings>(load());

watch(
  state,
  (value) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(value));
    } catch {
      /* private-mode / quota — settings just won't survive a reload */
    }
  },
  { deep: true },
);

export function useDisplaySettings(): {
  settings: DisplaySettings;
  reset: () => void;
} {
  return {
    settings: state,
    reset: () => Object.assign(state, defaults()),
  };
}

/**
 * A byte formatter bound to the live unit preference. The returned closure reads
 * `settings.sizeUnits` at call time, so using it in a template re-renders when the
 * unit setting changes — no re-reading the composable at each call site.
 */
export function useByteFormat(): (bytes: number) => string {
  return (bytes: number) => formatBytes(bytes, state.sizeUnits);
}
