import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { SessionConfig } from "h3";

/**
 * Feature 0001 — a single shared password gating the whole app. No accounts: if you
 * know the password you're in, matching the "one NAS, one admin" reality. Enabled by
 * setting `PASSWORD`; the session is a signed/encrypted cookie (h3's session utils).
 *
 * Two distinct secrets, deliberately not conflated:
 *  - {@link AuthConfig.password} is the *user* login password (what you type).
 *  - {@link AuthConfig.sessionSecret} is the *server* seal key for the cookie — never
 *    seen by the user, must be ≥32 chars of entropy ({@link generateSessionSecret}).
 */
export interface AuthConfig {
  /** The shared login password checked against `POST /api/login`. */
  password: string;
  /** Server-side key (≥32 chars) that seals the session cookie. */
  sessionSecret: string;
}

/** Session cookie name and lifetime. A week balances "not annoying" against staleness. */
export const SESSION_COOKIE = "wds_session";
export const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 7;

/**
 * The h3 session config. `secure: false` so the cookie is accepted over plain HTTP on a
 * trusted LAN (the common NAS case); put TLS in front (reverse proxy / Tailscale) for any
 * exposure beyond it. `httpOnly` keeps it away from JS; `sameSite: "lax"` is enough for a
 * same-origin SPA and still rides along with the EventSource scan stream.
 */
export function sessionConfig(auth: AuthConfig): SessionConfig {
  return {
    password: auth.sessionSecret,
    name: SESSION_COOKIE,
    maxAge: SESSION_MAX_AGE_SEC,
    cookie: { httpOnly: true, sameSite: "lax", path: "/", secure: false },
  };
}

/** Shape of what we store in the session once logged in. */
export interface SessionData {
  auth?: boolean;
}

/**
 * Constant-time password check. Hashing both sides to a fixed 32 bytes first lets us use
 * `timingSafeEqual` (which throws on length mismatch) without leaking the length of the
 * configured password through timing.
 */
export function passwordMatches(input: string, expected: string): boolean {
  const a = createHash("sha256").update(input).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** A fresh, high-entropy seal key for when `SESSION_SECRET` isn't provided. */
export function generateSessionSecret(): string {
  return randomBytes(32).toString("base64url");
}
