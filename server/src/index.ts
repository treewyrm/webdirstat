import { H3, onError, serve } from "h3";
import { loadConfig } from "./config.ts";
import { Store } from "./store/db.ts";
import { seedRootSettings } from "./store/settings.ts";
import { Scanner } from "./scan/scanner.ts";
import { Scheduler } from "./scan/scheduler.ts";
import { registerRootsRoute } from "./routes/roots.ts";
import { registerTreeRoute } from "./routes/tree.ts";
import { registerBatchRoute } from "./routes/batch.ts";
import { registerScanRoutes } from "./routes/scan.ts";
import { registerStatusRoutes } from "./routes/status.ts";
import { registerScheduleRoutes } from "./routes/schedule.ts";
import { createStaticHandler } from "./static/serve.ts";

const config = await loadConfig();
const store = Store.open(config.dbPath);

for (const root of config.roots) seedRootSettings(store, root.id, config.scheduleDefaults);

// Resolve the worker relative to THIS entry module so it works in both dev (tsx/.ts)
// and the bundled build (tsup/.js) — index sits one level above scan/ in both.
const isTs = import.meta.url.endsWith(".ts");
const workerUrl = new URL(`./scan/scan-worker${isTs ? ".ts" : ".js"}`, import.meta.url);
const workerExecArgv = isTs ? ["--import", "tsx"] : undefined;

const scanner = new Scanner({
  store,
  dbPath: config.dbPath,
  scheduleDefaults: config.scheduleDefaults,
  roots: config.roots,
  workerUrl,
  workerExecArgv,
});
const scheduler = new Scheduler(store, config.roots, config.scheduleDefaults, scanner);
scheduler.start();

const app = new H3();

app.use(
  onError((_event, error) => {
    console.error("[webdirstat]", error);
  }),
);

registerRootsRoute(app, config);
registerTreeRoute(app, config, store);
registerBatchRoute(app, config, store);
registerScanRoutes(app, scanner);
registerStatusRoutes(app, config, store, scanner);
registerScheduleRoutes(app, config, store, scheduler);

if (config.clientDist) {
  app.get("/**", createStaticHandler(config.clientDist));
}

console.log(`[webdirstat] store: ${config.dbPath}`);
console.log(`[webdirstat] roots: ${config.roots.map((r) => `${r.label}(${r.id})`).join(", ")}`);

serve(app, { port: config.port, hostname: config.host });

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[webdirstat] ${signal} received, shutting down`);
  scheduler.stop();
  await scanner.shutdown();
  try {
    store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    // best-effort checkpoint
  }
  store.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
