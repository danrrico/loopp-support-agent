/**
 * Session identity (architecture-v2.md §7.1, §8.1).
 *
 * The session ID is an unguessable UUID v4 carried in the httpOnly
 * ownership cookie `loopp_sid` (Secure in prod, SameSite=Lax, HttpOnly,
 * Path=/). There is NO `?session=` URL parameter — a URL-borne session ID
 * is a bearer token in browser history, logs, and shared links.
 *
 * The cookie is the only session auth. Appropriate for a public demo with
 * synthetic data; a production system would add real user accounts.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";

export const SESSION_COOKIE = "loopp_sid";

/** 30 days — the demo session lifetime. */
const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

const uuidSchema = z.string().uuid();

export function isValidSessionId(value: string | null | undefined): value is string {
  if (!value) return false;
  return uuidSchema.safeParse(value).success;
}

export function newSessionId(): string {
  return randomUUID();
}

/** Parse the session ID from a Cookie header value. Returns null when absent/invalid. */
export function parseSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) {
      const value = rest.join("=").trim();
      return isValidSessionId(value) ? value : null;
    }
  }
  return null;
}

/** Set-Cookie header value for the ownership cookie. */
export function sessionCookieHeader(sessionId: string): string {
  const secure =
    process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_SECONDS}${secure}`;
}
