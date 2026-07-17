import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { HTTPError } from "h3";
import type { ResolvedRoot } from "../config.ts";

/**
 * Resolves a client-supplied relative path against a configured root, refusing
 * anything that escapes the root directory (via `..`, absolute paths, or a
 * symlink pointing outside the root).
 */
export async function resolveScanPath(root: ResolvedRoot, relativePath: string | undefined): Promise<string> {
  const target = resolve(root.absolutePath, relativePath ?? "");

  if (target !== root.absolutePath && !target.startsWith(root.absolutePath + sep)) {
    throw HTTPError.status(403, "Forbidden", { message: "Path escapes the configured root" });
  }

  let real: string;
  try {
    real = await realpath(target);
  } catch (error) {
    throw HTTPError.status(404, "Not Found", { message: "Path does not exist", cause: error });
  }

  if (real !== root.canonicalPath && !real.startsWith(root.canonicalPath + sep)) {
    throw HTTPError.status(403, "Forbidden", { message: "Path escapes the configured root via a symlink" });
  }

  return target;
}

export function findRoot(roots: ResolvedRoot[], id: string): ResolvedRoot {
  const root = roots.find((r) => r.id === id);
  if (!root) {
    throw HTTPError.status(404, "Not Found", { message: `Unknown root "${id}"` });
  }
  return root;
}
