import { H3, onError, serve } from "h3";
import { loadConfig } from "./config.ts";
import { registerRootsRoute } from "./routes/roots.ts";
import { registerScanRoute } from "./routes/scan.ts";
import { createStaticHandler } from "./static/serve.ts";

const config = await loadConfig();

const app = new H3();

app.use(
  onError((_event, error) => {
    console.error("[webdirstat]", error);
  }),
);

registerRootsRoute(app, config);
registerScanRoute(app, config);

if (config.clientDist) {
  app.get("/**", createStaticHandler(config.clientDist));
}

console.log(`[webdirstat] roots: ${config.roots.map((r) => `${r.label}(${r.id})`).join(", ")}`);

serve(app, { port: config.port, hostname: config.host });
