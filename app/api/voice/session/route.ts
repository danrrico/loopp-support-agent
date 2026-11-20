/**
 * POST /api/voice/session — mint an ephemeral Realtime key (§4.1, §4.7).
 *
 * STUB (503) until the Day 1 voice spike lands: minting needs the OpenAI
 * key AND a pinned Realtime model version, neither of which exists yet.
 * When it lands, this route POSTs to /v1/realtime/sessions with
 * turn_detection.create_response=false, input transcription ON, and ZERO
 * functions declared (voice is transport only).
 *
 * The mint rate limit is live already (5/hour/IP + 3 mints/5-min/IP) —
 * Realtime audio is the most expensive meter in the system, and the limit
 * applies before the 503 so the endpoint cannot be hammered.
 */

import { NextResponse } from "next/server";
import { checkMintRateLimit } from "@/lib/rate-limit";

function clientIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

export async function POST(request: Request) {
  const rate = checkMintRateLimit(clientIp(request));
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded", code: "RATE_LIMITED" },
      {
        status: 429,
        headers: { "Retry-After": String(rate.retryAfterSeconds) },
      },
    );
  }
  return NextResponse.json(
    {
      error: "Voice is not configured yet — the OpenAI key and the Day 1 voice spike are still pending.",
      code: "VOICE_NOT_CONFIGURED",
    },
    { status: 503 },
  );
}
