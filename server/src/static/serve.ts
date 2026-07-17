import { readFile, realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { serveStatic } from "h3";
import type { EventHandler } from "h3";

/**
 * Serves the built Vue client (index.html + assets) from `distAbs`.
 *
 * Resolves each request `id` against `distAbs` and refuses anything that
 * would escape it (via `..`, encoded separators, or a symlink), matching the
 * traversal guidance in h3's `serveStatic` docs.
 */
export function createStaticHandler(distAbs: string): EventHandler {
  let distRealPath: string | undefined;

  async function resolveAsset(id: string): Promise<string | undefined> {
    let decoded: string;
    try {
      decoded = decodeURIComponent(id);
    } catch {
      return undefined;
    }

    const target = resolve(distAbs, "." + decoded);
    if (target !== distAbs && !target.startsWith(distAbs + sep)) return undefined;

    distRealPath ??= await realpath(distAbs);
    let real: string;
    try {
      real = await realpath(target);
    } catch {
      return undefined;
    }
    if (real !== distRealPath && !real.startsWith(distRealPath + sep)) return undefined;

    return target;
  }

  return (event) =>
    serveStatic(event, {
      indexNames: ["/index.html"],
      async getMeta(id) {
        const target = await resolveAsset(id);
        if (!target) return undefined;
        try {
          const info = await stat(target);
          if (!info.isFile()) return undefined;
          return {
            size: info.size,
            mtime: info.mtimeMs,
            path: target,
            etag: `W/"${info.size}-${info.mtimeMs}"`,
          };
        } catch {
          return undefined;
        }
      },
      async getContents(id) {
        const target = await resolveAsset(id);
        if (!target) return undefined;
        return await readFile(target);
      },
    });
}
