/**
 * In-memory rate limiting (architecture-v2.md §8.2).
 *
 * Fixed-window counters per key. Provisional limits:
 * - chat: 60 req/min/IP, 10 turns/min/session
 * - mint: 5 mints/hour/IP, 3 mints/5-min/IP (practical proxy for "3
 *   concurrent voice sessions per IP" — the mint route has no disconnect
 *   signal, so concurrency is approximated by recent mints; the 5-minute
 *   voice session cap bounds the error)
 * - health: cached ~30s (implemented in the health route, not here)
 *
 * In-memory limiting is acceptable for a demo; a production deployment
 * would use a shared store (Upstash or similar). Noted in the README.
 */

interface WindowEntry {
  count: number;
  windowStart: number;
}

const windows = new Map<string, WindowEntry>();

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the window resets (for the 429 Retry-After header). */
  retryAfterSeconds: number;
}

export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): RateLimitResult {
  const entry = windows.get(key);
  if (!entry || now - entry.windowStart >= windowMs) {
    windows.set(key, { count: 1, windowStart: now });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (entry.count < limit) {
    entry.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }
  const retryAfterSeconds = Math.ceil(
    (entry.windowStart + windowMs - now) / 1000,
  );
  return { allowed: false, retryAfterSeconds: Math.max(retryAfterSeconds, 1) };
}

// --- Presets (single source of truth for the limits) ---

export const CHAT_IP_LIMIT = 60;
export const CHAT_IP_WINDOW_MS = 60_000;
export const CHAT_SESSION_LIMIT = 10;
export const CHAT_SESSION_WINDOW_MS = 60_000;
export const MINT_IP_LIMIT = 5;
export const MINT_IP_WINDOW_MS = 60 * 60_000;
export const MINT_BURST_LIMIT = 3;
export const MINT_BURST_WINDOW_MS = 5 * 60_000;

export function checkChatRateLimit(ip: string, sessionId: string): RateLimitResult {
  const byIp = checkRateLimit(`chat:ip:${ip}`, CHAT_IP_LIMIT, CHAT_IP_WINDOW_MS);
  if (!byIp.allowed) return byIp;
  return checkRateLimit(
    `chat:session:${sessionId}`,
    CHAT_SESSION_LIMIT,
    CHAT_SESSION_WINDOW_MS,
  );
}

export function checkMintRateLimit(ip: string): RateLimitResult {
  const hourly = checkRateLimit(`mint:ip:${ip}`, MINT_IP_LIMIT, MINT_IP_WINDOW_MS);
  if (!hourly.allowed) return hourly;
  return checkRateLimit(
    `mint:burst:${ip}`,
    MINT_BURST_LIMIT,
    MINT_BURST_WINDOW_MS,
  );
}

/** Test hook: clear all windows. */
export function __resetRateLimits(): void {
  windows.clear();
}
