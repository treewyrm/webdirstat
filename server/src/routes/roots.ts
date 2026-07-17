import type { H3 } from "h3";
import type { ScanRoot } from "@webdirstat/shared";
import type { Config } from "../config.ts";

export function registerRootsRoute(app: H3, config: Config): void {
  app.get("/api/roots", (): ScanRoot[] => config.roots.map(({ id, label }) => ({ id, label })));
}
