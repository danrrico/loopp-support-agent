import { describe, expect, it } from "vitest";
import {
  __resetRateLimits,
  checkChatRateLimit,
  checkMintRateLimit,
  checkRateLimit,
} from "@/lib/rate-limit";

describe("checkRateLimit", () => {
  it("allows up to the limit, then blocks with a Retry-After", () => {
    __resetRateLimits();
    expect(checkRateLimit("k1", 2, 60_000).allowed).toBe(true);
    expect(checkRateLimit("k1", 2, 60_000).allowed).toBe(true);
    const blocked = checkRateLimit("k1", 2, 60_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("resets after the window passes", () => {
    __resetRateLimits();
    const now = Date.now();
    expect(checkRateLimit("k2", 1, 1000, now).allowed).toBe(true);
    expect(checkRateLimit("k2", 1, 1000, now + 500).allowed).toBe(false);
    expect(checkRateLimit("k2", 1, 1000, now + 1000).allowed).toBe(true);
  });
});

describe("chat + mint presets", () => {
  it("chat session limit is 10 turns/min", () => {
    __resetRateLimits();
    for (let i = 0; i < 10; i++) {
      expect(checkChatRateLimit("1.2.3.4", "sess-1").allowed).toBe(true);
    }
    expect(checkChatRateLimit("1.2.3.4", "sess-1").allowed).toBe(false);
    // A different session is unaffected.
    expect(checkChatRateLimit("1.2.3.4", "sess-2").allowed).toBe(true);
  });

  it("mint burst limit is 3 per 5 minutes per IP", () => {
    __resetRateLimits();
    for (let i = 0; i < 3; i++) {
      expect(checkMintRateLimit("5.6.7.8").allowed).toBe(true);
    }
    expect(checkMintRateLimit("5.6.7.8").allowed).toBe(false);
  });
});
