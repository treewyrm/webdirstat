import { defineConfig } from "tsdown";

export default defineConfig({
  // Two entries: the server and the scan worker it spawns. The scan/ subdir is
  // preserved, so the worker lands at dist/scan/scan-worker.js — index.js resolves
  // it as ./scan/scan-worker.js, matching the dev (tsx) relative path.
  entry: ["src/index.ts", "src/scan/scan-worker.ts"],
  format: "esm",
  platform: "node",
  target: "node24",
  outDir: "dist",
  clean: true,
  // App bundle, not a library — no declaration files needed. rolldown keeps Node
  // builtins (incl. node:sqlite) external with their node: prefix intact.
  dts: false,
  // Emit .js (the package is type:module, so .js is ESM) to keep dist/index.js
  // stable for `pnpm start` and the Dockerfile.
  outExtensions: () => ({ js: ".js" }),
});
