import { H3, onError, serve } from "h3";
import { loadConfig } from "./config.ts";
import { Store } from "./store/db.ts";
import { ScanRunner } from "./scan/runner.ts";
import { registerRootsRoute } from "./routes/roots.ts";
import { registerScanRoute } from "./routes/scan.ts";
import { registerTreeRoute } from "./routes/tree.ts";
import { createStaticHandler } from "./static/serve.ts";

const config = await loadConfig();
const store = Store.open(config.dbPath);
const runner = new ScanRunner();

const app = new H3();

app.use(
  onError((_event, error) => {
    console.error("[webdirstat]", error);
  }),
);

registerRootsRoute(app, config);
registerTreeRoute(app, config, store);
registerScanRoute(app, config, store, runner);

if (config.clientDist) {
  app.get("/**", createStaticHandler(config.clientDist));
}

console.log(`[webdirstat] store: ${config.dbPath}`);
console.log(`[webdirstat] roots: ${config.roots.map((r) => `${r.label}(${r.id})`).join(", ")}`);

serve(app, { port: config.port, hostname: config.host });
