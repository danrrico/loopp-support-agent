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
  | { type: "transcript-partial"; text: string }
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
        markActivity();
        onEvent({
          type: "agent-transcript-partial",
          text: String(event.delta ?? ""),
        });
        break;
      case "response.audio_transcript.done":
        markActivity();
        onEvent({
          type: "agent-transcript-final",
          text: String(event.transcript ?? ""),
        });
        break;
      case "response.created":
        markActivity();
        onEvent({ type: "response-started" });
        break;
      case "response.done":
      case "response.cancelled":
        markActivity();
        onEvent({ type: "response-done" });
        break;
      case "error": {
        const err = event.error as Record<string, unknown> | undefined;
        onEvent({
          type: "error",
          message: String(err?.message ?? "Realtime error"),
        });
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
      dc.send(
        JSON.stringify({
          type: "response.create",
          response: {
            modalities: ["audio"],
            instructions: `${VOICE_CONFIG.speakInstructions}\n\n${text}`,
          },
        }),
      );
    },
    cancelResponse() {
      if (closed || dc.readyState !== "open") return;
      dc.send(JSON.stringify({ type: "response.cancel" }));
    },
    disconnect(reason: "ended" | "idle" | "cap" = "ended") {
      shutdown(reason);
    },
  };
}
