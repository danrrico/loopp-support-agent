"use client";

import { useEffect, useRef, useState } from "react";
import { mintVoiceSession, postVoiceTranscript } from "@/lib/client/api";
import { Waveform } from "@/components/voice/Waveform";
import { pickFiller, VOICE_CONFIG } from "@/lib/voice/config";
import {
  connectRealtimeVoice,
  type RealtimeClientEvent,
  type RealtimeVoiceClient,
} from "@/lib/voice/realtime-client";
import { VoiceTranscriptState } from "@/lib/voice/transcript-state";

/**
 * Voice panel — live voice over WebRTC (architecture-v2.md §4).
 *
 * Voice is TRANSPORT ONLY: Realtime transcribes + speaks; the server
 * LangGraph decides everything. The flow per turn:
 *   Talk → mint ephemeral key → WebRTC connect → user speaks → Realtime
 *   emits the final transcript → POST /api/voice/transcript (same graph
 *   as text) → speak the graph's verbatim text via response.create.
 * A filler ("Let me check that for you.") covers the graph round-trip;
 * it is cancelled the moment the real answer is ready (the client
 * serializes create/cancel — see ResponseSequencer — so the answer is
 * never created while the filler is still live).
 * Interruption (§4.5): speech while the agent is speaking cancels the
 * in-flight response and returns to listening.
 *
 * Concurrency guards (live 2026-11-25 — a double-tap on Talk opened two
 * Realtime sessions on the same mic, duplicating every transcript and
 * racing two graph turns into a 409):
 * - handleTalk is guarded by a ref + a connecting state, so a second tap
 *   while mint/connect is in flight is ignored and any pre-existing
 *   client is disconnected first.
 * - Each final transcript is submitted once per item_id (see
 *   VoiceTranscriptState) — a duplicate delivery is dropped entirely.
 * - A graph result is only spoken if its turn is still the latest; a
 *   stale answer (user already spoke again) is dropped silently.
 */

export type VoiceState =
  | "idle"
  | "listening"
  | "awaiting_graph"
  | "speaking"
  | "interrupted"
  | "disconnected"
  | "error";

const STATE_LABEL: Record<VoiceState, string> = {
  idle: "Idle — press Talk to start",
  listening: "Listening…",
  awaiting_graph: "Checking that for you…",
  speaking: "Speaking…",
  interrupted: "Interrupted — tap to resume",
  disconnected: "Disconnected",
  error: "Voice unavailable",
};

const STATE_COLOR: Record<VoiceState, string> = {
  idle: "bg-zinc-400",
  listening: "bg-green-500",
  awaiting_graph: "bg-amber-500",
  speaking: "bg-blue-500",
  interrupted: "bg-orange-500",
  disconnected: "bg-zinc-400",
  error: "bg-red-500",
};

interface TranscriptLine {
  role: "user" | "assistant";
  text: string;
  final: boolean;
}

export function VoicePanel({
  onClose,
  onVoiceTurn,
}: {
  onClose: () => void;
  /**
   * Fires when a voice turn completes (graph answer received). The chat
   * page appends the turn's trace to the Observability drawer and its
   * messages to the list — without this, voice turns are invisible in
   * the drawer (observed live: 5 voice turns, drawer read "0 turns").
   */
  onVoiceTurn?: (turn: {
    turnNumber: number;
    trace: import("@/lib/client/types").TraceEvent[];
    userText: string;
    assistantText: string;
    terminalState: string;
  }) => void;
}) {
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  const [userDraft, setUserDraft] = useState<string | null>(null);
  const [agentDraft, setAgentDraft] = useState<string | null>(null);

  const clientRef = useRef<RealtimeVoiceClient | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const stateRef = useRef<VoiceState>("idle");
  const mountedRef = useRef(true);
  const connectingRef = useRef(false);
  // Draft accumulation + per-itemId submit dedupe (pure, unit-tested).
  const transcriptStateRef = useRef(new VoiceTranscriptState());
  // Generation counter: a graph result only speaks if its turn is still
  // the latest — a stale answer (user already spoke again) is dropped.
  const turnRef = useRef(0);

  function setState(next: VoiceState) {
    stateRef.current = next;
    setVoiceState(next);
  }

  // Explicit audio lifecycle (§4.3): disconnect on unmount so microphone
  // capture never continues after the panel closes.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clientRef.current?.disconnect();
      clientRef.current = null;
    };
  }, []);

  function pushLine(line: TranscriptLine) {
    setTranscript((prev) => [...prev, line]);
  }

  function handleClientEvent(event: RealtimeClientEvent) {
    if (!mountedRef.current) return;
    const client = clientRef.current;
    const tstate = transcriptStateRef.current;
    switch (event.type) {
      case "ready":
        break;
      case "transcript-partial":
        // Incremental deltas accumulate into ONE dimmed draft line in
        // place — never a new line per chunk.
        setUserDraft(tstate.accumulateUserPartial(event.itemId, event.text));
        break;
      case "transcript-final": {
        tstate.clearUserDraft();
        setUserDraft(null);
        if (!event.text.trim()) break;
        // Duplicate delivery of the same input item (double client /
        // double event): drop it entirely — no second line, no second
        // POST, no second graph turn.
        if (tstate.isDuplicateFinal(event.itemId)) break;
        tstate.markSubmitted(event.itemId);
        pushLine({ role: "user", text: event.text, final: true });
        setState("awaiting_graph");
        const myTurn = ++turnRef.current;
        // Contextual filler covers the graph round-trip; cancelled when
        // the answer lands. Varied per topic (never the same phrase
        // 5 times in a row).
        client?.speak(pickFiller(event.text));
        void postVoiceTranscript(event.text, event.itemId)
          .then((result) => {
            // Stale turn: the user already spoke again — do not speak
            // this answer over the new utterance.
            if (!mountedRef.current || turnRef.current !== myTurn) return;
            client?.cancelResponse();
            // Report the completed voice turn to the chat page so the
            // Observability drawer + message list show it (voice turns
            // otherwise never appear there). Skip duplicates — a retried
            // POST replays a stored result, not a new turn.
            if (!result.duplicate && result.speakableText.trim()) {
              onVoiceTurn?.({
                turnNumber: result.turnNumber,
                trace: result.trace,
                userText: event.text,
                assistantText: result.speakableText,
                terminalState: result.terminalState,
              });
            }
            if (result.speakableText.trim()) {
              client?.speak(result.speakableText);
              setState("speaking");
            } else {
              setState("listening");
            }
          })
          .catch((err: unknown) => {
            if (!mountedRef.current || turnRef.current !== myTurn) return;
            client?.cancelResponse();
            setError(
              err instanceof Error
                ? err.message
                : "The voice turn failed — try speaking again.",
            );
            setState("listening");
          });
        break;
      }
      case "agent-transcript-partial":
        // Incremental deltas accumulate into ONE dimmed draft line —
        // never a bare fragment ("that", "?") as its own line.
        setAgentDraft(tstate.accumulateAgentPartial(event.text));
        break;
      case "agent-transcript-final":
        tstate.clearAgentDraft();
        setAgentDraft(null);
        if (event.text.trim()) {
          pushLine({ role: "assistant", text: event.text, final: true });
        }
        break;
      case "response-started":
        // A new response starts — its partials belong to a fresh draft.
        tstate.clearAgentDraft();
        setAgentDraft(null);
        break;
      case "speech-started":
        // A new utterance started — drop any stale user draft.
        tstate.clearUserDraft();
        setUserDraft(null);
        // Barge-in (§4.5): stop the agent mid-sentence (or mid-filler),
        // listen to the user.
        if (
          stateRef.current === "speaking" ||
          stateRef.current === "awaiting_graph"
        ) {
          client?.cancelResponse();
          setState("interrupted");
          window.setTimeout(() => {
            if (mountedRef.current && stateRef.current === "interrupted") {
              setState("listening");
            }
          }, 600);
        }
        break;
      case "speech-stopped":
        break;
      case "response-done":
        if (stateRef.current === "speaking") setState("listening");
        break;
      case "disconnected":
        clientRef.current = null;
        setMicStream(null);
        setUserDraft(null);
        setAgentDraft(null);
        if (event.reason === "idle") {
          setInfo("Voice session ended after 60 seconds without speech.");
        } else if (event.reason === "cap") {
          setInfo("Voice session ended at the 5-minute cap.");
        }
        setState("disconnected");
        window.setTimeout(() => {
          if (mountedRef.current && stateRef.current === "disconnected") {
            setState("idle");
          }
        }, 1500);
        break;
      case "error":
        setError(event.message);
        break;
    }
  }

  async function handleTalk() {
    // Double-tap guard: mint + connect is async and the button stays
    // enabled until it resolves — a second tap used to open a second
    // Realtime session on the same mic, duplicating every transcript
    // and racing two graph turns into a 409.
    if (connectingRef.current) return;
    if (clientRef.current) return;
    connectingRef.current = true;
    setConnecting(true);
    setError(null);
    setInfo(null);
    try {
      const minted = await mintVoiceSession();
      const client = await connectRealtimeVoice({
        ephemeralKey: minted.ephemeralKey,
        model: minted.model,
        onEvent: handleClientEvent,
        onRemoteStream: (stream) => {
          const audio = remoteAudioRef.current;
          if (audio) audio.srcObject = stream;
        },
      });
      if (!mountedRef.current) {
        client.disconnect();
        return;
      }
      // Fresh call: new session, new item ids.
      transcriptStateRef.current.resetSubmitted();
      clientRef.current = client;
      setMicStream(client.micStream);
      setState("listening");
    } catch (err) {
      const e = err as Error & { status?: number; code?: string };
      setState("error");
      if (e.status === 503) {
        setError(
          "Voice needs an OpenAI key — the Day 1 voice spike (Realtime model pin + minting) is still pending. Text chat works fully in the meantime.",
        );
      } else if (e.status === 429) {
        setError(
          "Too many voice sessions from this device — wait a few minutes and try again.",
        );
      } else {
        setError(e.message);
      }
    } finally {
      connectingRef.current = false;
      setConnecting(false);
    }
  }

  function handleDisconnect() {
    // Explicit audio lifecycle (§4.3): stop tracks, close the peer
    // connection + data channel; the Waveform's AudioContext closes with
    // the stream change.
    clientRef.current?.disconnect();
    clientRef.current = null;
    setMicStream(null);
    setTranscript([]);
    setUserDraft(null);
    setAgentDraft(null);
    transcriptStateRef.current.resetSubmitted();
    transcriptStateRef.current.clearUserDraft();
    transcriptStateRef.current.clearAgentDraft();
    setState("disconnected");
    window.setTimeout(() => {
      if (mountedRef.current && stateRef.current === "disconnected") {
        setState("idle");
      }
    }, 1500);
  }

  const active = voiceState === "listening" || voiceState === "speaking";

  return (
    <div className="border-b border-zinc-200 px-4 py-4 dark:border-zinc-800 sm:px-8">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className={`inline-block h-2.5 w-2.5 rounded-full ${STATE_COLOR[voiceState]}`}
            aria-hidden
          />
          <h2 className="text-sm font-semibold">
            Live voice {voiceState !== "idle" && `— ${STATE_LABEL[voiceState]}`}
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close voice panel"
          className="rounded-full px-2 py-1 text-sm text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          ✕
        </button>
      </div>

      <div className="mt-3">
        <Waveform stream={micStream} active={active} />
      </div>

      {/* Remote agent audio — hidden element, driven by the Realtime track. */}
      <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />

      {error && (
        <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      {info && !error && (
        <p className="mt-3 rounded-lg bg-zinc-100 px-3 py-2 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
          {info}
        </p>
      )}

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={handleTalk}
          disabled={
            connecting ||
            voiceState === "listening" ||
            voiceState === "awaiting_graph" ||
            voiceState === "speaking"
          }
          className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          🎙 Talk
        </button>
        {(voiceState === "listening" ||
          voiceState === "speaking" ||
          voiceState === "interrupted" ||
          voiceState === "awaiting_graph") && (
          <button
            type="button"
            onClick={handleDisconnect}
            className="rounded-full border border-zinc-300 px-5 py-2 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            End call
          </button>
        )}
      </div>

      {/* Live transcript pane — partial transcripts render dimmed/italic. */}
      <div className="mt-3 min-h-10 rounded-lg bg-zinc-50 p-3 text-sm dark:bg-zinc-900">
        {transcript.length === 0 && !userDraft && !agentDraft ? (
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Live transcript appears here during a voice call. Final
            transcripts land in the message list alongside text chat — one
            conversation, two modalities.
          </p>
        ) : (
          <>
            {transcript.map((line, i) => (
              <p
                key={i}
                className={line.final ? "" : "italic text-zinc-400"}
              >
                <span className="font-semibold">
                  {line.role === "user" ? "You" : "Agent"}:
                </span>{" "}
                {line.text}
              </p>
            ))}
            {userDraft && (
              <p className="italic text-zinc-400">
                <span className="font-semibold">You:</span> {userDraft}
              </p>
            )}
            {agentDraft && (
              <p className="italic text-zinc-400">
                <span className="font-semibold">Agent:</span> {agentDraft}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
