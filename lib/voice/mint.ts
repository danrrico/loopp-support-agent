/**
 * Realtime mint — POST /v1/realtime/client_secrets (GA Realtime API).
 *
 * The server trades the long-lived OpenAI key for a short-lived ephemeral
 * client secret (`ek_…`) the browser uses for the WebRTC SDP exchange.
 * The key never leaves the server.
 *
 * Session config is TRANSPORT ONLY (architecture-v2.md §4): zero
 * functions, tool_choice "none", and — critically —
 * turn_detection.create_response=false, so the Realtime model never
 * answers on its own. It transcribes; the server graph decides; the
 * browser speaks the graph's verbatim text via response.create.
 *
 * Pure functions (payload builder + response parser) are unit-tested;
 * `mintRealtimeClientSecret` takes fetch as a parameter so tests never
 * touch the network.
 */

import { VOICE_CONFIG } from "./config";

export const REALTIME_CLIENT_SECRETS_URL =
  "https://api.openai.com/v1/realtime/client_secrets";

/** Error from the mint call. `status` is the upstream HTTP status (0 = network/timeout). */
export class MintError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "MintError";
    this.status = status;
    this.code = code;
  }
}

/** Request body for POST /v1/realtime/client_secrets. */
export function buildMintPayload(): Record<string, unknown> {
  return {
    expires_after: {
      anchor: "created_at",
      seconds: VOICE_CONFIG.mintTtlSeconds,
    },
    session: {
      type: "realtime",
      model: VOICE_CONFIG.realtimeModel,
      instructions: VOICE_CONFIG.transportInstructions,
      audio: {
        input: {
          transcription: { model: "whisper-1" },
          turn_detection: {
            type: VOICE_CONFIG.vad.type,
            silence_duration_ms: VOICE_CONFIG.vad.silenceDurationMs,
            threshold: VOICE_CONFIG.vad.threshold,
            prefix_padding_ms: VOICE_CONFIG.vad.prefixPaddingMs,
            // The graph answers, not the model — never auto-create a response.
            create_response: false,
          },
        },
        output: { voice: VOICE_CONFIG.voice },
      },
      tools: [],
      tool_choice: "none",
    },
  };
}

export interface MintedSession {
  /** Ephemeral client secret (`ek_…`) for the browser's SDP exchange. */
  ephemeralKey: string;
  model: string;
  /** Unix expiry of the client secret (null when OpenAI omits it). */
  expiresAt: number | null;
  sessionId: string | null;
}

/** Parse a successful client_secrets response. Throws MintError on a malformed body. */
export function parseMintResponse(data: unknown): MintedSession {
  const d = (data ?? {}) as Record<string, unknown>;
  const value = d.value;
  if (typeof value !== "string" || value.length === 0) {
    throw new MintError(502, "MINT_FAILED", "OpenAI mint response had no client secret.");
  }
  const session = (d.session ?? {}) as Record<string, unknown>;
  return {
    ephemeralKey: value,
    model:
      typeof session.model === "string"
        ? session.model
        : VOICE_CONFIG.realtimeModel,
    expiresAt: typeof d.expires_at === "number" ? d.expires_at : null,
    sessionId: typeof session.id === "string" ? session.id : null,
  };
}

const MINT_TIMEOUT_MS = 10_000;

/**
 * Mint an ephemeral Realtime client secret from OpenAI.
 * `fetchFn` is injectable for tests (defaults to global fetch).
 */
export async function mintRealtimeClientSecret(
  apiKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<MintedSession> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MINT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchFn(REALTIME_CLIENT_SECRETS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(buildMintPayload()),
      signal: controller.signal,
    });
  } catch (err) {
    throw new MintError(
      0,
      "MINT_FAILED",
      `Could not reach OpenAI to mint a voice session: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    if (res.status === 429) {
      throw new MintError(
        429,
        "OPENAI_RATE_LIMITED",
        "OpenAI is rate-limiting voice sessions right now.",
      );
    }
    const text = await res.text().catch(() => "");
    // Never include the key or the full provider body in the error.
    throw new MintError(
      res.status,
      "MINT_FAILED",
      `OpenAI mint failed with HTTP ${res.status}: ${text.slice(0, 200)}`,
    );
  }

  const data: unknown = await res.json().catch(() => null);
  return parseMintResponse(data);
}
