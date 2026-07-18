/** Binary (base-1024, KiB/MiB) vs. decimal (base-1000, KB/MB) size units — a display preference. */
export type SizeUnitBase = "binary" | "decimal";

const SCALES = {
  binary: { base: 1024, units: ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] },
  decimal: { base: 1000, units: ["B", "KB", "MB", "GB", "TB", "PB"] },
} as const;

export function formatBytes(bytes: number, unit: SizeUnitBase = "binary"): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const { base, units } = SCALES[unit];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(base)), units.length - 1);
  const value = bytes / base ** exponent;
  const digits = exponent === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[exponent]}`;
}

export function formatCount(count: number): string {
  return new Intl.NumberFormat().format(count);
}

/** "just now" / "5m ago" / "3h ago" / "2d ago" for a past timestamp (ms). */
export function formatAgo(ms: number | null): string {
  if (ms == null) return "never";
  const delta = Date.now() - ms;
  if (delta < 45_000) return "just now";
  const mins = Math.round(delta / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** "in 5m" / "in 3h" / "in 2d" for a future timestamp (ms), or null if in the past. */
export function formatUntil(ms: number | null): string | null {
  if (ms == null) return null;
  const delta = ms - Date.now();
  if (delta <= 0) return "due now";
  const mins = Math.round(delta / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}
