import type { ScanRoot } from "@webdirstat/shared";
import type { RouteFactory } from "./context.ts";

export const registerRootsRoute: RouteFactory = ({ app, config }) => {
  app.get("/api/roots", (): ScanRoot[] => config.roots.map(({ id, label }) => ({ id, label })));
};
