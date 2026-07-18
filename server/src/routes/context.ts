import type { H3 } from "h3";
import type { Config } from "../config.ts";
import type { Store } from "../store/db.ts";
import type { Scanner } from "../scan/scanner.ts";
import type { Scheduler } from "../scan/scheduler.ts";

/**
 * Everything a route factory might need, injected as one object. Built once in index.ts
 * and passed to each factory, so individual route modules import only {@link RouteFactory}
 * instead of re-importing every dependency type.
 */
export interface RouteContext {
  app: H3;
  config: Config;
  store: Store;
  scanner: Scanner;
  scheduler: Scheduler;
}

/** A route module's registration function: attach handlers to `ctx.app`, pull deps off `ctx`. */
export type RouteFactory = (ctx: RouteContext) => void;
