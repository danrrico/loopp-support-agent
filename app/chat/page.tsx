"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Composer } from "@/components/chat/Composer";
import {
  MessageList,
  type DisplayMessage,
} from "@/components/chat/MessageList";
import { ObservabilityDrawer } from "@/components/observability/Drawer";
import { VoicePanel } from "@/components/voice/VoicePanel";
import {
  fetchSession,
  startNewSession,
} from "@/lib/client/api";
import { streamChat } from "@/lib/client/sse";
import type { TraceEvent, TurnTrace } from "@/lib/client/types";

export default function ChatPage() {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [traces, setTraces] = useState<TurnTrace[]>([]);
  const [escalated, setEscalated] = useState(false);
  const [turnCount, setTurnCount] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [liveTrace, setLiveTrace] = useState<TraceEvent[] | null>(null);
  const [liveTurnNumber, setLiveTurnNumber] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const liveTraceRef = useRef<TraceEvent[]>([]);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Hydrate the cookie session on mount (messages + traces + escalated flag).
  useEffect(() => {
    fetchSession()
      .then((data) => {
        setMessages(data.messages);
        setTraces(data.traces);
        setEscalated(data.escalated);
        setTurnCount(data.turnCount);
      })
      .catch((err) => {
        setError(
          err instanceof Error ? err.message : "Failed to load the session.",
        );
      })
      .finally(() => setLoading(false));
  }, []);

  // Auto-scroll the message list as new content streams in.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  async function handleSend(text: string) {
    if (streaming) return;
    setError(null);
    setStreaming(true);

    const userId = `user-${Date.now()}`;
    const assistantId = `assistant-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      {
        id: userId,
        role: "user",
        content: text,
        modality: "text",
        possiblyTruncated: false,
        createdAt: new Date().toISOString(),
      },
      {
        id: assistantId,
        role: "assistant",
        content: "",
        modality: "text",
        possiblyTruncated: false,
        createdAt: new Date().toISOString(),
        streaming: true,
      },
    ]);

    liveTraceRef.current = [];
    setLiveTrace([]);
    const thisTurn = turnCount + 1;
    setLiveTurnNumber(thisTurn);

    const finalizeAssistant = (updater: (m: DisplayMessage) => DisplayMessage) => {
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantId ? updater(m) : m)),
      );
    };

    try {
      await streamChat(
        text,
        {
          onText: (delta) => {
            finalizeAssistant((m) => ({
              ...m,
              content: m.content + delta,
            }));
          },
          onTrace: (event) => {
            liveTraceRef.current = [...liveTraceRef.current, event];
            setLiveTrace(liveTraceRef.current);
          },
          onDone: (done) => {
            setTraces((prev) => [
              ...prev,
              {
                turnNumber: done.turnNumber,
                trace: liveTraceRef.current,
                partial: done.partial,
              },
            ]);
            setTurnCount(done.turnNumber);
            if (done.terminalState === "escalated") setEscalated(true);
            finalizeAssistant((m) => ({ ...m, streaming: false }));
            setLiveTrace(null);
            setLiveTurnNumber(null);
            setStreaming(false);
          },
          onError: (err) => {
            setError(err.message);
            setTraces((prev) => [
              ...prev,
              {
                turnNumber: thisTurn,
                trace: liveTraceRef.current,
                partial: true,
              },
            ]);
            finalizeAssistant((m) => ({
              ...m,
              content:
                m.content ||
                "Something went wrong on our side — please try again.",
              streaming: false,
            }));
            setLiveTrace(null);
            setLiveTurnNumber(null);
            setStreaming(false);
          },
          onInterrupted: () => {
            setError(
              "The connection dropped before the turn completed. The turn may have completed server-side — check the trace.",
            );
            setTraces((prev) => [
              ...prev,
              {
                turnNumber: thisTurn,
                trace: liveTraceRef.current,
                partial: true,
              },
            ]);
            finalizeAssistant((m) => ({ ...m, streaming: false }));
            setLiveTrace(null);
            setLiveTurnNumber(null);
            setStreaming(false);
          },
        },
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send.");
      setMessages((prev) => prev.filter((m) => m.id !== assistantId));
      setLiveTrace(null);
      setLiveTurnNumber(null);
      setStreaming(false);
    }
  }

  async function handleNewChat() {
    if (streaming) return;
    try {
      await startNewSession();
      setMessages([]);
      setTraces([]);
      setEscalated(false);
      setTurnCount(0);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start a new chat.");
    }
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <Link href="/" className="text-sm font-semibold">
          ← Loopp Support Agent
        </Link>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setVoiceOpen((open) => !open)}
            aria-expanded={voiceOpen}
            className="rounded-full border border-zinc-300 px-4 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            🎙 Voice
          </button>
          <button
            type="button"
            onClick={handleNewChat}
            disabled={streaming}
            className="rounded-full border border-zinc-300 px-4 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            New chat
          </button>
          <button
            type="button"
            onClick={() => setDrawerOpen((open) => !open)}
            aria-expanded={drawerOpen}
            className="rounded-full bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            Observability
          </button>
        </div>
      </header>

      {escalated && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          Escalated to a human agent — a ticket has been opened and our team
          will follow up. You can start a new chat for a different question.
        </div>
      )}

      <div className="flex flex-1">
        <main className="flex min-h-0 flex-1 flex-col">
          {voiceOpen && <VoicePanel onClose={() => setVoiceOpen(false)} />}

          {error && (
            <div className="mx-4 mt-4 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 sm:mx-8 dark:bg-red-950 dark:text-red-300">
              {error}
            </div>
          )}

          <div ref={listRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            {loading ? (
              <div className="flex flex-1 items-center justify-center">
                <p className="text-sm text-zinc-500">Loading your conversation…</p>
              </div>
            ) : (
              <MessageList messages={messages} />
            )}
          </div>

          <Composer
            onSend={handleSend}
            disabled={streaming || loading}
            placeholder={
              escalated
                ? "This conversation was escalated — start a new chat for a different question."
                : "Type your message…"
            }
          />
        </main>

        {drawerOpen && (
          <div className="fixed inset-y-0 right-0 z-20 lg:static lg:z-auto">
            <ObservabilityDrawer
              traces={traces}
              liveTrace={liveTrace}
              liveTurnNumber={liveTurnNumber}
              onClose={() => setDrawerOpen(false)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
