import { HTTPError } from "h3";
import type { RouteFactory } from "./context.ts";

/**
 * Liveness/readiness probe for the container orchestrator (Docker/Unraid healthcheck).
 * Cheap and dependency-light: confirms the process is up and the SQLite store answers a
 * trivial query. Throws 503 (not 500) when the store is unreachable so a healthcheck loop
 * reads it as "not ready" rather than an unexpected crash.
 */
export const registerHealthRoute: RouteFactory = ({ app, store }) => {
  app.get("/api/health", () => {
    try {
      store.db.prepare("SELECT 1").get();
    } catch {
      throw HTTPError.status(503, "Service Unavailable", { message: "Store unreachable" });
    }
    return { status: "ok" };
  });
};
