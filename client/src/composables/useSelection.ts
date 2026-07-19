import { reactive, watch } from "vue";

/**
 * The shared selection set (feature 0019). A single, path-keyed, heterogeneous set —
 * files *and* directories are first-class marks — shared by every surface (canvas,
 * file-list, later search) and persisted to `localStorage`.
 *
 * **Keyed by path, not `id`.** `id`s are reassigned on every rescan swap; paths are the
 * durable anchor already used by breadcrumbs and the stale-reseed, so the set survives
 * LOD churn *and* a generation swap mid-session. The path-keyed form *is* the durable
 * form, so persistence is just serializing it.
 *
 * **Subsumption is maintained on write.** A marked directory subsumes its descendants:
 * adding a path drops any already-marked descendants, and is a no-op if an ancestor is
 * already marked. So the stored set is always the shallowest-ancestors form the export
 * wants (feature 0006), and `size` is the real mark count. Un-marking a descendant of a
 * marked folder would require fracturing the folder — that's hole-punching, deferred to
 * v2 — so it's a no-op here.
 *
 * Vanished paths are **not** auto-pruned: a deleted path is still a meaningful "delete
 * this" line; it just won't resolve to an on-map wash.
 *
 * **Each mark carries its `size`** (bytes) captured at mark time — a folder's aggregate
 * or a file's own — so the toolbar can total the selection without re-fetching. It's a
 * snapshot: a rescan can change the real size, but the mark's path re-resolves and the
 * next time it's re-marked the size refreshes. Subsumption keeps the total honest: a
 * marked folder's size already includes any descendants it drops.
 */
interface SelectionMark {
  /** Root-relative path — the durable anchor and the export line. */
  path: string;
  /** Bytes at mark time (folder aggregate or file size). */
  size: number;
}

interface SelectionState {
  version: number;
  /** rootId → its marks (root-relative paths), kept in subsumed (shallowest) form. */
  roots: Record<string, SelectionMark[]>;
}

const KEY = "wds.selection";
const VERSION = 2;

function load(): SelectionState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { version: VERSION, roots: {} };
    const parsed = JSON.parse(raw) as Partial<SelectionState> | null;
    if (!parsed || parsed.version !== VERSION || typeof parsed.roots !== "object" || !parsed.roots) {
      return { version: VERSION, roots: {} };
    }
    return { version: VERSION, roots: parsed.roots };
  } catch {
    return { version: VERSION, roots: {} };
  }
}

const state = reactive<SelectionState>(load());

watch(
  state,
  (value) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(value));
    } catch {
      /* private-mode / quota — the set just won't survive a reload */
    }
  },
  { deep: true },
);

/** True when `path` is `ancestor` itself or lies underneath it. */
function isUnder(ancestor: string, path: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}/`);
}

function entriesFor(rootId: string): SelectionMark[] {
  return state.roots[rootId] ?? [];
}

/** The marked paths (root-relative) — the export lines and the wash keys. */
function marksFor(rootId: string): string[] {
  return entriesFor(rootId).map((m) => m.path);
}

/** Exact membership — is *this path* a mark (vs. merely covered by a marked ancestor)? */
function has(rootId: string, path: string): boolean {
  return entriesFor(rootId).some((m) => m.path === path);
}

/** Covered = exact mark or under a marked ancestor. Drives the on-map wash. */
function isCovered(rootId: string, path: string): boolean {
  return entriesFor(rootId).some((m) => isUnder(m.path, path));
}

/**
 * Add `path` (with its `size`), maintaining subsumption: skip it if an ancestor is
 * already marked, else drop any marked descendants it now subsumes. Returns true if the
 * set changed.
 */
function add(rootId: string, path: string, size: number): boolean {
  const list = state.roots[rootId] ?? (state.roots[rootId] = []);
  if (list.some((m) => isUnder(m.path, path))) return false; // already covered by self/ancestor
  const kept = list.filter((m) => !isUnder(path, m.path)); // drop now-subsumed descendants
  kept.push({ path, size });
  state.roots[rootId] = kept;
  return true;
}

/** Remove an exact mark. Removing a descendant of a marked folder is a no-op (v2). */
function remove(rootId: string, path: string): boolean {
  const list = state.roots[rootId];
  if (!list) return false;
  const next = list.filter((m) => m.path !== path);
  if (next.length === list.length) return false;
  state.roots[rootId] = next;
  return true;
}

/** Toggle one mark: exact mark → unmark; covered-by-ancestor → no-op (v2); else add. */
function toggle(rootId: string, path: string, size: number): void {
  if (has(rootId, path)) remove(rootId, path);
  else if (!isCovered(rootId, path)) add(rootId, path, size);
}

/** Add many marks at once (marquee); returns how many actually landed after subsumption. */
function addMany(rootId: string, marks: SelectionMark[]): number {
  let added = 0;
  for (const m of marks) if (add(rootId, m.path, m.size)) added++;
  return added;
}

/** Subtract many exact marks (subtract-marquee); whole marks only, never fractures (v2). */
function removeMany(rootId: string, paths: string[]): number {
  let removed = 0;
  for (const p of paths) if (remove(rootId, p)) removed++;
  return removed;
}

function clear(rootId: string): void {
  if (state.roots[rootId]?.length) state.roots[rootId] = [];
}

function count(rootId: string): number {
  return entriesFor(rootId).length;
}

/** Total bytes across the marks (snapshot sizes; subsumption keeps it non-double-counting). */
function totalSize(rootId: string): number {
  return entriesFor(rootId).reduce((sum, m) => sum + m.size, 0);
}

export function useSelection(): {
  marksFor: (rootId: string) => string[];
  has: (rootId: string, path: string) => boolean;
  isCovered: (rootId: string, path: string) => boolean;
  add: (rootId: string, path: string, size: number) => boolean;
  remove: (rootId: string, path: string) => boolean;
  toggle: (rootId: string, path: string, size: number) => void;
  addMany: (rootId: string, marks: SelectionMark[]) => number;
  removeMany: (rootId: string, paths: string[]) => number;
  clear: (rootId: string) => void;
  count: (rootId: string) => number;
  totalSize: (rootId: string) => number;
} {
  return { marksFor, has, isCovered, add, remove, toggle, addMany, removeMany, clear, count, totalSize };
}

export type { SelectionMark };
