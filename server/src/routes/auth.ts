import { clearSession, getRequestPath, getSession, HTTPError, readBody, updateSession } from "h3";
import { z } from "zod";
import { passwordMatches, sessionConfig, type SessionData } from "../auth.ts";
import type { RouteFactory } from "./context.ts";

const LoginBody = z.object({ password: z.string() });

/** Paths under /api the guard lets through unauthenticated (login + probes). */
const PUBLIC_API = new Set(["/api/login", "/api/logout", "/api/session", "/api/health"]);

/**
 * Feature 0001 — password gate. Always exposes `GET /api/session` so the SPA can learn
 * whether a gate is even configured; when `PASSWORD` is set it additionally installs a
 * blanket `/api/**` guard plus the login/logout routes. The static SPA bundle is served
 * freely (it holds no data) so the login form can load — everything private is under /api.
 */
export const registerAuthRoutes: RouteFactory = ({ app, config }) => {
  const auth = config.auth;

  // Single probe the SPA hits on load: is a gate required, and are we already in?
  app.get("/api/session", async (event) => {
    if (!auth) return { required: false, authenticated: true };
    const session = await getSession<SessionData>(event, sessionConfig(auth));
    return { required: true, authenticated: session.data.auth === true };
  });

  if (!auth) return; // Gate disabled → no guard, no login machinery.

  const session = sessionConfig(auth);

  // Guard: every /api call needs a valid session except the public ones above. Registered
  // before the data routes so it fronts all of them. Throwing short-circuits with a 401;
  // returning next() continues to the matched handler.
  app.use("/api/**", async (event, next) => {
    const path = getRequestPath(event).split("?")[0] ?? "";
    if (PUBLIC_API.has(path)) return next();
    const s = await getSession<SessionData>(event, session);
    if (s.data.auth === true) return next();
    throw HTTPError.status(401, "Unauthorized", { message: "Authentication required" });
  });

  app.post("/api/login", async (event) => {
    const body = ((await readBody(event).catch(() => undefined)) ?? {}) as Record<string, unknown>;
    const parsed = LoginBody.safeParse(body);
    if (!parsed.success || !passwordMatches(parsed.data.password, auth.password)) {
      throw HTTPError.status(401, "Unauthorized", { message: "Incorrect password" });
    }
    await updateSession<SessionData>(event, session, { auth: true });
    return { ok: true };
  });

  app.post("/api/logout", async (event) => {
    await clearSession(event, session);
    return { ok: true };
  });
};
