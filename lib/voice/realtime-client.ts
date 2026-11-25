/**
 * Browser Realtime client — WebRTC transport for live voice (§4).
 *
 * Flow: mint (server) → getUserMedia → RTCPeerConnection → SDP exchange
 * POST /v1/realtime/calls?model=<model> (Bearer: ephemeral key) → the
 * data channel carries Realtime events both ways.
 *
 * Voice is TRANSPORT ONLY: Realtime transcribes the user and speaks text
 * handed to it via response.create. The minted session has
 * turn_detection.create_response=false, so the model never answers on its
 * own — every spoken reply comes from the server graph via
 * POST /api/voice/transcript, spoken verbatim.
 *
 * Interruption (§4.5): `input_audio_buffer.speech_started` while the agent
 * is speaking emits `speech-started`; the panel cancels the in-flight
 * response and returns to listening. The transcript turn is never marked
 * with a false precise cut point.
 *
 * Lifecycle is explicit: disconnect() stops the mic tracks, closes the
 * data channel + peer connection. The client also enforces the session
 * cap (5 min) and idle disconnect (60s without speech) from VOICE_CONFIG.
 */

import { VOICE_CONFIG } from "./config";

export const REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";

export type RealtimeClientEvent =
  | { type: "ready" }
  | { type: "transcript-partial"; text: string; itemId: string }
  | { type: "transcript-final"; text: string; itemId: string }
  | { type: "agent-transcript-partial"; text: string }
  | { type: "agent-transcript-final"; text: string }
  | { type: "speech-started" }
  | { type: "speech-stopped" }
  | { type: "response-started" }
  | { type: "response-done" }
  | { type: "disconnected"; reason: "ended" | "idle" | "cap" | "error" }
  | { type: "error"; message: string };

export interface RealtimeVoiceClient {
  /** Local mic stream (feed it to the Waveform). */
  readonly micStream: MediaStream;
  /** Speak graph output verbatim via response.create. */
  speak(text: string): void;
  /** Cancel the in-flight spoken response (barge-in). */
  cancelResponse(): void;
  /** Stop tracks, close the channel + peer connection. Idempotent. */
  disconnect(reason?: "ended" | "idle" | "cap"): void;
}

/**
 * Build the `response.create` client event for speaking graph output.
 *
 * GA Realtime API (gpt-realtime-2.1, verified live 2026-11-25): the
 * Response object has NO `modalities` field — sending it fails with
 * `unknown_parameter: 'response.modalities'`. Modalities are a
 * session-level concept; the minted session already defaults to
 * `output_modalities: ["audio"]` (see session.created), so audio output
 * needs nothing per response. `instructions` alone is the valid payload.
 */
export function buildResponseCreatePayload(
  text: string,
): Record<string, unknown> {
  return {
    type: "response.create",
    response: {
      instructions: `${VOICE_CONFIG.speakInstructions}\n\n${text}`,
    },
  };
}

export type ResponsePhase = "idle" | "creating" | "active" | "cancelling";

/**
 * Serializes Realtime response.create / response.cancel so the client
 * never has two responses in flight.
 *
 * Regression (live 2026-11-25): the panel spoke the filler
 * ("Let me check that for you.") via response.create, then — the moment
 * the graph answer landed — sent response.cancel AND a second
 * response.create back-to-back. The server had not processed the cancel
 * yet, so the create failed with "Conversation already has an active
 * response in progress: resp_…". The fix: a create is only sent when no
 * response is live; a speak() issued while one is live cancels it first
 * and queues the text until the server confirms the cancel
 * (response.cancelled / response.done). Latest speak wins; a barge-in
 * cancel discards queued speech.
 */
export class ResponseSequencer {
  private phase: ResponsePhase = "idle";
  private pendingSpeak: string | null = null;
  private creatingText: string | null = null;
  private cancelRequested = false;

  constructor(private send: (event: Record<string, unknown>) => void) {}

  /** Queue text to speak; sent only when no response is live. Latest wins. */
  speak(text: string): void {
    this.pendingSpeak = text;
    if (this.phase === "idle") this.flush();
    else this.requestCancel();
  }

  /** Cancel the live (or in-flight) response; discards queued speech. */
  cancel(): void {
    this.pendingSpeak = null;
    this.cancelRequested = true;
    this.requestCancel();
  }

  /** Server confirmed a response was created. */
  onCreated(): void {
    this.phase = "active";
    this.creatingText = null;
    if (this.cancelRequested) {
      this.cancelRequested = false;
      this.requestCancel();
    } else if (this.pendingSpeak !== null) {
      this.requestCancel();
    }
  }

  /** Server confirmed the response ended (done or cancelled). */
  onEnded(): void {
    this.phase = "idle";
    this.creatingText = null;
    this.cancelRequested = false;
    this.flush();
  }

  /**
   * Server rejected a create because another response is still active.
   * Should be unreachable once creates are serialized, but recover
   * instead of surfacing a red banner: re-queue the failed text, cancel
   * the live response, and let the cancel confirmation flush the retry.
   */
  onActiveResponseError(): void {
    if (this.phase === "creating" && this.creatingText !== null) {
      this.pendingSpeak = this.creatingText;
      this.creatingText = null;
      this.phase = "active";
      this.requestCancel();
    }
  }

  private requestCancel(): void {
    if (this.phase === "active") {
      this.phase = "cancelling";
      this.send({ type: "response.cancel" });
    }
    // "creating": the onCreated handler cancels it as soon as it exists.
    // "cancelling"/"idle": nothing to cancel.
  }

  private flush(): void {
    if (this.pendingSpeak === null || this.phase !== "idle") return;
    const text = this.pendingSpeak;
    this.pendingSpeak = null;
    this.creatingText = text;
    this.phase = "creating";
    this.cancelRequested = false;
    this.send(buildResponseCreatePayload(text));
  }
}

export interface ConnectOptions {
  ephemeralKey: string;
  model: string;
  onEvent: (event: RealtimeClientEvent) => void;
  /** Fires with the remote agent audio stream — attach to an <audio> element. */
  onRemoteStream: (stream: MediaStream) => void;
}

const IDLE_CHECK_MS = 5_000;

export async function connectRealtimeVoice(
  opts: ConnectOptions,
): Promise<RealtimeVoiceClient> {
  const { ephemeralKey, model, onEvent, onRemoteStream } = opts;

  let micStream: MediaStream;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: VOICE_CONFIG.mediaConstraints,
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    throw new Error(
      name === "NotAllowedError"
        ? "Microphone access was denied — allow the microphone and try again."
        : "Could not access the microphone.",
    );
  }

  const pc = new RTCPeerConnection();
  let closed = false;
  let lastActivityAt = Date.now();
  const connectedAt = Date.now();

  const markActivity = () => {
    lastActivityAt = Date.now();
  };

  function shutdown(reason: "ended" | "idle" | "cap" | "error") {
    if (closed) return;
    closed = true;
    window.clearInterval(idleTimer);
    try {
      dc.close();
    } catch {
      /* already closed */
    }
    try {
      pc.close();
    } catch {
      /* already closed */
    }
    micStream.getTracks().forEach((t) => t.stop());
    onEvent({ type: "disconnected", reason });
  }

  // Session cap + idle disconnect (§4.7).
  const idleTimer = window.setInterval(() => {
    if (closed) return;
    if (Date.now() - connectedAt > VOICE_CONFIG.sessionCapSeconds * 1000) {
      shutdown("cap");
    } else if (
      Date.now() - lastActivityAt >
      VOICE_CONFIG.idleDisconnectSeconds * 1000
    ) {
      shutdown("idle");
    }
  }, IDLE_CHECK_MS);

  const dc = pc.createDataChannel("oai-events");

  // Serializes response.create / response.cancel — see ResponseSequencer.
  const sequencer = new ResponseSequencer((event) => {
    if (!closed && dc.readyState === "open") {
      dc.send(JSON.stringify(event));
    }
  });

  dc.onmessage = (msg) => {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(msg.data as string) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = event.type as string | undefined;
    switch (type) {
      case "session.created":
      case "session.updated":
        markActivity();
        onEvent({ type: "ready" });
        break;
      case "input_audio_buffer.speech_started":
        markActivity();
        onEvent({ type: "speech-started" });
        break;
      case "input_audio_buffer.speech_stopped":
        markActivity();
        onEvent({ type: "speech-stopped" });
        break;
      case "conversation.item.input_audio_transcription.delta":
        markActivity();
        onEvent({
          type: "transcript-partial",
          text: String(event.delta ?? ""),
          itemId: String(event.item_id ?? ""),
        });
        break;
      case "conversation.item.input_audio_transcription.completed": {
        markActivity();
        onEvent({
          type: "transcript-final",
          text: String(event.transcript ?? ""),
          itemId: String(event.item_id ?? ""),
        });
        break;
      }
      case "response.audio_transcript.delta":
      case "response.output_audio_transcript.delta":
        markActivity();
        onEvent({
          type: "agent-transcript-partial",
          text: String(event.delta ?? ""),
        });
        break;
      case "response.audio_transcript.done":
      case "response.output_audio_transcript.done":
        markActivity();
        onEvent({
          type: "agent-transcript-final",
          text: String(event.transcript ?? ""),
        });
        break;
      case "response.created":
        markActivity();
        sequencer.onCreated();
        onEvent({ type: "response-started" });
        break;
      case "response.done":
        markActivity();
        sequencer.onEnded();
        onEvent({ type: "response-done" });
        break;
      case "response.cancelled":
        markActivity();
        sequencer.onEnded();
        onEvent({ type: "response-done" });
        break;
      case "error": {
        const err = event.error as Record<string, unknown> | undefined;
        const message = String(err?.message ?? "Realtime error");
        // Benign race: a cancel sent after the response already finished
        // (or after a failed create) has no active response to cancel.
        // Never surface that as a user-facing error banner.
        if (/no active response/i.test(message)) return;
        // A create that raced a still-live response: the sequencer
        // re-queues the text and cancels the live one, so the retry
        // lands cleanly. Never surface it either — it is recoverable.
        if (/active response in progress/i.test(message)) {
          sequencer.onActiveResponseError();
          return;
        }
        onEvent({ type: "error", message });
        break;
      }
      default:
        break;
    }
  };

  dc.onerror = () => {
    onEvent({ type: "error", message: "Voice connection error." });
    shutdown("error");
  };

  pc.ontrack = (e) => {
    if (e.streams[0]) onRemoteStream(e.streams[0]);
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed") {
      onEvent({ type: "error", message: "Voice connection failed." });
      shutdown("error");
    }
  };

  micStream.getTracks().forEach((track) => pc.addTrack(track, micStream));

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const res = await fetch(
      `${REALTIME_CALLS_URL}?model=${encodeURIComponent(model)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ephemeralKey}`,
          "Content-Type": "application/sdp",
        },
        body: offer.sdp,
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Voice connection failed (HTTP ${res.status}): ${text.slice(0, 120)}`,
      );
    }
    const answerSdp = await res.text();
    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
  } catch (err) {
    shutdown("error");
    throw err instanceof Error
      ? err
      : new Error("Voice connection failed.");
  }

  return {
    micStream,
    speak(text: string) {
      if (closed || dc.readyState !== "open") return;
      markActivity();
      // The sequencer sends the create only when no response is live;
      // if one is (filler still speaking), it cancels it first and
      // queues this text until the cancel is confirmed server-side.
      sequencer.speak(text);
    },
    cancelResponse() {
      // No-op when nothing is live (sequencer tracks it); a cancel
      // requested while a create is still in flight cancels it as soon
      // as the server confirms it exists.
      if (closed || dc.readyState !== "open") return;
      sequencer.cancel();
    },
    disconnect(reason: "ended" | "idle" | "cap" = "ended") {
      shutdown(reason);
    },
  };
}
