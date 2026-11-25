/**
 * Voice configuration (architecture-v2.md §4.6).
 *
 * Voice is TRANSPORT ONLY: Realtime transcribes + speaks; the server
 * LangGraph decides everything. Zero Realtime functions are declared.
 *
 * Realtime model PINNED 2026-11-25 (Day 1 voice spike, verified live
 * against the OpenAI API):
 * - `gpt-realtime-2.1` — POST /v1/realtime/client_secrets returns 200
 *   with an `ek_…` client secret for this model.
 * - The old candidate `gpt-4o-realtime-preview` does NOT exist on this
 *   key (absent from GET /v1/models after the GA Realtime launch).
 * - The beta POST /v1/realtime/sessions endpoint is retired (404
 *   "Invalid URL"); the GA mint is POST /v1/realtime/client_secrets,
 *   and the WebRTC SDP exchange is POST /v1/realtime/calls?model=<model>.
 * Do not change the pin without re-verifying the mint.
 */

export const VOICE_CONFIG = {
  /** PINNED — verified live 2026-11-25 (see above). */
  realtimeModel: "gpt-realtime-2.1",
  voice: "alloy",
  /** Server VAD: 700–900ms silence so order numbers aren't cut off. */
  vad: {
    type: "server_vad",
    silenceDurationMs: 800,
    threshold: 0.5,
    prefixPaddingMs: 300,
  },
  /** getUserMedia constraints — without echo cancellation the agent interrupts itself. */
  mediaConstraints: {
    echoCancellation: true,
    noiseSuppression: true,
  },
  /** Hard cap per voice session (abuse control, §4.7). */
  sessionCapSeconds: 5 * 60,
  /** Idle disconnect after 60s without speech. */
  idleDisconnectSeconds: 60,
  /** TTL of the minted ephemeral client secret (seconds). The secret only
   *  needs to live long enough for the browser to complete the SDP
   *  exchange; the session itself continues after the secret expires. */
  mintTtlSeconds: 180,
  /** Filler spoken while the graph runs, so the user is never in silence. */
  fillerText: "Let me check that for you.",
  /** The browser speaks graph output verbatim — never improvised. */
  speakInstructions:
    "Read the following text verbatim. Do not add, remove, or rephrase any words.",
  /** Session-level instructions for the Realtime model: it is a transport
   *  layer only. It must never answer on its own (turn_detection
   *  create_response is false); it only speaks text handed to it via
   *  response.create. */
  transportInstructions:
    "You are a voice transport layer. Transcribe the user's speech accurately. Never respond on your own; only speak text provided via response.create instructions, reading it verbatim.",
} as const;
