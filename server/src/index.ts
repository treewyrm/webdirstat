import { H3, onError, serve } from "h3";
import { loadConfig } from "./config.ts";
import { compressResponse } from "./http/compression.ts";
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
import { registerTypesRoute } from "./routes/types.ts";
import { registerSearchRoute } from "./routes/search.ts";
import { registerHealthRoute } from "./routes/health.ts";
import { registerAuthRoutes } from "./routes/auth.ts";
import type { RouteContext } from "./routes/context.ts";
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

const ctx: RouteContext = { app, config, store, scanner, scheduler };
// Registered first so the /api/** password guard (feature 0001) fronts every data route.
registerAuthRoutes(ctx);
registerRootsRoute(ctx);
registerTreeRoute(ctx);
registerBatchRoute(ctx);
registerScanRoutes(ctx);
registerStatusRoutes(ctx);
registerScheduleRoutes(ctx);
registerTypesRoute(ctx);
registerSearchRoute(ctx);
registerHealthRoute(ctx);

if (config.clientDist) {
  app.get("/**", createStaticHandler(config.clientDist));
}

logger.info(`store: ${config.dbPath}`);
logger.info(`roots: ${config.roots.map((r) => `${r.label}(${r.id})`).join(", ")}`);

// Content-negotiated response compression (feature 0018), applied at the fully
// normalized web-Response boundary by wrapping the app's fetch — uniform across the
// JSON API, static SPA, and (excluded there) the SSE stream. `serve` reads
// `app.fetch` after a `freezeApp` that only freezes config, so this reassignment sticks.
const baseFetch = app.fetch.bind(app);
app.fetch = (request: Parameters<typeof app.fetch>[0]): Response | Promise<Response> => {
  const result = baseFetch(request);
  return result instanceof Promise
    ? result.then((response) => compressResponse(request, response, config.compression))
    : compressResponse(request, result, config.compression);
};

serve(app, { port: config.port, hostname: config.host });
logger.success(`listening on http://${config.host}:${config.port}`);
if (config.compression.enabled) logger.info(`response compression: on (brotli q${config.compression.quality})`);

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
