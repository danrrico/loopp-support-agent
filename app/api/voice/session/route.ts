/**
 * POST /api/voice/session — mint an ephemeral Realtime client secret (§4.1, §4.7).
 *
 * GA flow (verified live 2026-11-25): POST /v1/realtime/client_secrets
 * with the pinned model `gpt-realtime-2.1` and a transport-only session
 * (turn_detection.create_response=false, input transcription ON, ZERO
 * functions declared — voice is transport only). Returns
 * { ephemeralKey, model, expiresAt, sessionId } for the browser's WebRTC
 * SDP exchange (POST /v1/realtime/calls?model=<model>). The long-lived
 * OpenAI key never leaves the server.
 *
 * The mint rate limit (5/hour/IP + 3 mints/5-min/IP) applies before
 * minting — Realtime audio is the most expensive meter in the system.
 * Without an OpenAI key the route still answers 503 VOICE_NOT_CONFIGURED.
 */

// 60s: same cold-start headroom as /api/chat (see that route).
export const maxDuration = 60;

import { NextResponse } from "next/server";
import { checkMintRateLimit } from "@/lib/rate-limit";
import { MintError, mintRealtimeClientSecret } from "@/lib/voice/mint";

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

  // Same key resolution as the chat model (lib/agent/model.ts).
  const apiKey =
    process.env.MODEL_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          "Voice is not configured yet — the OpenAI key and the Day 1 voice spike are still pending.",
        code: "VOICE_NOT_CONFIGURED",
      },
      { status: 503 },
    );
  }

  try {
    const minted = await mintRealtimeClientSecret(apiKey);
    return NextResponse.json({
      ephemeralKey: minted.ephemeralKey,
      model: minted.model,
      expiresAt: minted.expiresAt,
      sessionId: minted.sessionId,
    });
  } catch (err) {
    if (err instanceof MintError && err.status === 429) {
      return NextResponse.json(
        {
          error: "OpenAI is rate-limiting voice sessions right now — try again shortly.",
          code: "OPENAI_RATE_LIMITED",
        },
        { status: 429 },
      );
    }
    // Never include the key or the provider body in the error.
    console.error(
      "[voice/session] mint failed:",
      err instanceof Error ? err.message : String(err),
    );
    return NextResponse.json(
      {
        error: "Voice mint failed — could not start a voice session.",
        code: "MINT_FAILED",
      },
      { status: 502 },
    );
  }
}
