import type { TypeRollupEntry } from "@webdirstat/shared";

/**
 * Static extension → family map for the grouped "By type" view (feature 0005).
 * Keys are lowercased and dot-less, matching the rollup's `ext`.
 *
 * TODO(feature 0007): this table should become user-customizable — editable
 * families persisted client-side (localStorage) via the display-settings pane —
 * rather than this hardcoded, opinionated default. Until then it is fixed; keep the
 * grouping logic below map-driven so swapping this constant for a stored config is
 * the only change needed.
 */
export const EXTENSION_FAMILIES: Record<string, string> = {
  // Video
  mov: "Video", mp4: "Video", m4v: "Video", mkv: "Video", avi: "Video", webm: "Video",
  wmv: "Video", flv: "Video", mpg: "Video", mpeg: "Video",
  // Images
  jpg: "Images", jpeg: "Images", png: "Images", gif: "Images", webp: "Images", bmp: "Images",
  tif: "Images", tiff: "Images", svg: "Images", heic: "Images", raw: "Images", cr2: "Images", nef: "Images",
  // Audio
  mp3: "Audio", flac: "Audio", wav: "Audio", aac: "Audio", ogg: "Audio", m4a: "Audio", wma: "Audio", aiff: "Audio",
  // Archives
  zip: "Archives", rar: "Archives", "7z": "Archives", tar: "Archives", gz: "Archives",
  bz2: "Archives", xz: "Archives", zst: "Archives",
  // Disk images
  iso: "Disk images", dmg: "Disk images", img: "Disk images", vhd: "Disk images", vhdx: "Disk images",
  vmdk: "Disk images", vdi: "Disk images",
  // Disk images — DAEMON Tools / optical-media formats
  mdx: "Disk images", mds: "Disk images", mdf: "Disk images", // Media Descriptor (Alcohol/DAEMON)
  ccd: "Disk images", sub: "Disk images", // CloneCD (paired with .img)
  nrg: "Disk images", // Nero
  cue: "Disk images", bin: "Disk images", // CDRWIN cue/bin
  cdi: "Disk images", // DiscJuggler
  b5t: "Disk images", b6t: "Disk images", bwt: "Disk images", // BlindWrite
  pdi: "Disk images", // Instant CD/DVD
  isz: "Disk images", // compressed ISO (UltraISO)
  // Documents
  pdf: "Documents", doc: "Documents", docx: "Documents", xls: "Documents", xlsx: "Documents",
  ppt: "Documents", pptx: "Documents", txt: "Documents", md: "Documents", rtf: "Documents",
  odt: "Documents", epub: "Documents",
  // Code
  js: "Code", ts: "Code", jsx: "Code", tsx: "Code", py: "Code", java: "Code", c: "Code", h: "Code",
  cpp: "Code", cs: "Code", go: "Code", rs: "Code", rb: "Code", php: "Code", sh: "Code",
  html: "Code", css: "Code", json: "Code", xml: "Code", yaml: "Code", yml: "Code",
};

/** One row of the grouped view: either a family (several extensions) or a single passthrough extension. */
export interface GroupedType {
  /** Stable key for :key and coloring. */
  key: string;
  label: string;
  /** Set only when the row is a single raw extension, so its swatch can match the tile exactly. */
  ext?: string;
  totalBytes: number;
  totalCount: number;
}

/**
 * Folds raw per-extension entries into families. Known extensions collapse into
 * their family; unknown ones pass through as their own row so a disk full of one
 * odd extension is never hidden under a bucket. The extension-less "" bucket stays
 * a single passthrough row. Size-sorted, largest first.
 *
 * Grouping runs over the (server-capped) entries the panel received, so when the
 * response carries an `omittedTail` the families reflect only the shown extensions;
 * the tail is surfaced separately by the caller.
 */
export function groupByFamily(types: TypeRollupEntry[]): GroupedType[] {
  const byKey = new Map<string, GroupedType>();
  for (const t of types) {
    const family = EXTENSION_FAMILIES[t.ext];
    const key = family ?? `ext:${t.ext}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.totalBytes += t.totalBytes;
      existing.totalCount += t.totalCount;
    } else {
      byKey.set(key, {
        key,
        label: family ?? (t.ext ? `.${t.ext}` : "(no extension)"),
        ...(family ? {} : { ext: t.ext }),
        totalBytes: t.totalBytes,
        totalCount: t.totalCount,
      });
    }
  }
  return [...byKey.values()].sort((a, b) => b.totalBytes - a.totalBytes);
}
