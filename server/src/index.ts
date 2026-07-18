import { H3, onError, serve } from "h3";
import { loadConfig } from "./config.ts";
import { logger } from "./logger.ts";
import { Store } from "./store/db.ts";
import { seedRootSettings } from "./store/settings.ts";
import { Scanner } from "./scan/scanner.ts";
import { createScanWorkerFactory } from "./scan/worker-factory.ts";
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

const scanner = new Scanner({
  store,
  dbPath: config.dbPath,
  scheduleDefaults: config.scheduleDefaults,
  roots: config.roots,
  // Resolve the worker entry relative to THIS module (index sits above scan/ in both layouts).
  spawnWorker: createScanWorkerFactory(import.meta.url),
});
const scheduler = new Scheduler(store, config.roots, config.scheduleDefaults, scanner);
scheduler.start();

const app = new H3();

app.use(
  // h3's onError hook is (error, event) — logging the event instead would walk into
  // event.req, whose lazy Request rebuild throws on an already-consumed POST body.
  // Only surface genuinely unexpected failures; expected 4xx (e.g. the 410 that drives
  // the client's generation re-seed during a rescan) are normal protocol flow, not noise.
  onError((error) => {
    if (error.unhandled || error.status >= 500) logger.error(error);
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

logger.info(`store: ${config.dbPath}`);
logger.info(`roots: ${config.roots.map((r) => `${r.label}(${r.id})`).join(", ")}`);

serve(app, { port: config.port, hostname: config.host });
logger.success(`listening on http://${config.host}:${config.port}`);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received, shutting down`);
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
