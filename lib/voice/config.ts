/**
 * Voice configuration (architecture-v2.md §4.6).
 *
 * Voice is TRANSPORT ONLY: Realtime transcribes + speaks; the server
 * LangGraph decides everything. Zero Realtime functions are declared.
 *
 * The Realtime model version is UNPINNED until the Day 1 voice spike
 * verifies availability (needs the OpenAI key). `gpt-4o-realtime-preview`
 * is the starting candidate only — do not assume it exists. When the spike
 * pins a version, record it here AND in the README.
 */

export const VOICE_CONFIG = {
  /** UNPINNED candidate — the Day 1 spike verifies availability. */
  realtimeModel: "gpt-4o-realtime-preview",
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
  /** Filler spoken while the graph runs, so the user is never in silence. */
  fillerText: "Let me check that for you.",
  /** The browser speaks graph output verbatim — never improvised. */
  speakInstructions:
    "Read the following text verbatim. Do not add, remove, or rephrase any words.",
} as const;
