import { realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { RootSchedule, ScanRoot } from "@webdirstat/shared";
import { type AuthConfig, generateSessionSecret } from "./auth.ts";
import type { CompressionConfig } from "./http/compression.ts";
import { logger } from "./logger.ts";
import { parseDuration, parseWindows } from "./scan/schedule.ts";

export interface ResolvedRoot extends ScanRoot {
  /** Absolute host path this root points to. Never sent to the client. */
  absolutePath: string;
  /**
   * Canonical (symlinks resolved) form of `absolutePath`, used as the
   * containment boundary for traversal checks. Falls back to `absolutePath`
   * if the directory doesn't exist yet at startup.
   */
  canonicalPath: string;
}

export function slugify(label: string): string {
  return (
    label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "root"
  );
}

/** A parsed `ROOTS` entry before its path is resolved/realpathed against the filesystem. */
export interface RootSpec {
  id: string;
  label: string;
  path: string;
}

/**
 * The pure parse of the `ROOTS` env var — label/id/path only, no filesystem access.
 * Two accepted forms per comma-separated entry:
 *   - labeled:   `Label=/path` — everything before the first `=` is the label.
 *   - unlabeled: `/path` — the display label is derived from the path's basename.
 * Falls back to a single root pointing at `/data`, matching a `-v host:/data` mount.
 *
 * `=` is disambiguating but not perfectly: `=` (and `,`) are legal in filesystem
 * paths, so an unlabeled path containing `=`, or any path containing `,`, must be
 * given in the explicit `Label=/path` form. The label is derived from the basename
 * (never the raw path) so an unlabeled entry can't leak the host path to the client.
 * Ids are slugified and de-duplicated so they never collide.
 */
export function parseRootSpecs(raw: string | undefined): RootSpec[] {
  const entries = (raw ?? "Data=/data")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  const specs: RootSpec[] = [];
  const seenIds = new Set<string>();

  for (const entry of entries) {
    const separatorIndex = entry.indexOf("=");
    const path = (separatorIndex === -1 ? entry : entry.slice(separatorIndex + 1)).trim();
    if (!path) continue;
    // Unlabeled: label from basename, not the full path (labels go to the client).
    const label = separatorIndex === -1 ? basename(path) : entry.slice(0, separatorIndex).trim();

    let id = slugify(label);
    while (seenIds.has(id)) id = `${id}-2`;
    seenIds.add(id);

    specs.push({ id, label: label || id, path });
  }

  return specs;
}

/** Resolves parsed specs to absolute + canonical (symlink-resolved) host paths. */
async function parseRoots(raw: string | undefined): Promise<ResolvedRoot[]> {
  const roots: ResolvedRoot[] = [];

  for (const { id, label, path } of parseRootSpecs(raw)) {
    const absolutePath = resolve(path);
    let canonicalPath = absolutePath;
    try {
      canonicalPath = await realpath(absolutePath);
    } catch {
      logger.warn(`root "${label}" (${absolutePath}) does not exist yet`);
    }

    roots.push({ id, label, absolutePath, canonicalPath });
  }

  return roots;
}

export interface Config {
  port: number;
  host: string;
  roots: ResolvedRoot[];
  /** Directory containing the built Vue client (index.html + assets). Unset in dev. */
  clientDist: string | undefined;
  /** Path to the SQLite store file. Must be on writable storage, not the scanned share. */
  dbPath: string;
  /** Env-seeded per-root schedule defaults, written to `root_settings` on first run. */
  scheduleDefaults: RootSchedule;
  /** Shared-password gate (feature 0001). `null` = disabled (no `PASSWORD` set). */
  auth: AuthConfig | null;
  /** Content-negotiated response compression (feature 0018), env-seeded. */
  compression: CompressionConfig;
}

/**
 * Builds the response-compression config from env (feature 0018). On by default —
 * responses ship uncompressed otherwise, and there's no reverse proxy in the
 * container to do it for us. `COMPRESSION=false` disables it; `COMPRESSION_QUALITY`
 * tunes brotli (0–11, clamped, default 5 — a CPU/ratio balance for dynamic bodies);
 * `COMPRESSION_MIN_SIZE` is the byte threshold below which compression is skipped.
 */
function loadCompression(): CompressionConfig {
  const disabled = process.env.COMPRESSION === "false" || process.env.COMPRESSION === "0";
  const quality = Math.min(11, Math.max(0, Number(process.env.COMPRESSION_QUALITY) || 5));
  const threshold = Math.max(0, Number(process.env.COMPRESSION_MIN_SIZE) || 1024);
  return { enabled: !disabled, quality, threshold };
}

/**
 * Builds the auth gate from env. Opt-in like `ROOTS`: no `PASSWORD` → `null` (open).
 * The seal key is separate from the login password; if `SESSION_SECRET` is missing or
 * too weak we mint an ephemeral one and warn — logins then reset on restart and won't be
 * shared across replicas, which is fine for a single container but worth flagging.
 */
function loadAuth(): AuthConfig | null {
  const password = process.env.PASSWORD;
  if (!password) return null;

  let sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret || sessionSecret.length < 32) {
    if (sessionSecret) logger.warn("SESSION_SECRET is shorter than 32 chars; ignoring it");
    sessionSecret = generateSessionSecret();
    logger.warn(
      "SESSION_SECRET not set — using an ephemeral key. Logins reset on restart and won't work across replicas; set SESSION_SECRET (≥32 chars) to persist them.",
    );
  }
  logger.info("password gate enabled");
  return { password, sessionSecret };
}

const HOUR_MS = 3_600_000;

function defaultTimezone(): string {
  return process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export async function loadConfig(): Promise<Config> {
  const concurrency = Number(process.env.SCAN_CONCURRENCY) || 4;
  const historyGenerations = Math.max(0, Number(process.env.HISTORY_GENERATIONS) || 0);
  const intervalMs = parseDuration(process.env.SCAN_INTERVAL);
  const windows = parseWindows(process.env.SCAN_WINDOWS);
  // Automatic scanning is opt-in: on if the operator expressed any schedule intent.
  const enabled =
    process.env.SCAN_ENABLED != null
      ? process.env.SCAN_ENABLED === "true" || process.env.SCAN_ENABLED === "1"
      : intervalMs != null || windows.length > 0;

  return {
    port: Number(process.env.PORT) || 3000,
    host: process.env.HOST || "0.0.0.0",
    roots: await parseRoots(process.env.ROOTS),
    // Absolute so the static handler's containment guard (which compares against a
    // resolved, absolute request path) works even when CLIENT_DIST is given relative.
    clientDist: process.env.CLIENT_DIST ? resolve(process.env.CLIENT_DIST) : undefined,
    dbPath: process.env.DB_PATH || "./data/webdirstat.db",
    scheduleDefaults: {
      enabled,
      concurrency,
      intervalMs,
      windows,
      timezone: defaultTimezone(),
      minIntervalMs: parseDuration(process.env.SCAN_MIN_INTERVAL) ?? HOUR_MS,
      onWindowEnd: process.env.SCAN_ON_WINDOW_END === "abort" ? "abort" : "finish",
      historyGenerations,
    },
    auth: loadAuth(),
    compression: loadCompression(),
  };
}
