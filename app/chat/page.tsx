"use client";

import { useState } from "react";
import Link from "next/link";
import type { Message } from "@/lib/types";

const PLACEHOLDER_MESSAGES: Message[] = [
  {
    id: "welcome",
    role: "assistant",
    content:
      "Hi, I'm the Loopp support agent. Ask me about your order, a refund, or anything else — streaming replies arrive in the build phase.",
    createdAt: new Date().toISOString(),
  },
];

const OBSERVABILITY_SECTIONS = [
  {
    title: "Traces",
    body: "Agent run traces will appear here once the LangGraph agent is wired up.",
  },
  {
    title: "Latency",
    body: "Per-step timings (retrieval, model, tools) will appear here.",
  },
  {
    title: "Retrieval",
    body: "RAG hits, scores, and confidence will appear here.",
  },
  {
    title: "Tool calls",
    body: "orderLookup, initiateRefund, and createTicket calls will appear here.",
  },
];

export default function ChatPage() {
  const [messages] = useState<Message[]>(PLACEHOLDER_MESSAGES);
  const [input, setInput] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim()) return;
    // TODO: POST to /api/chat and stream the response (build phase).
    setInput("");
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <Link href="/" className="text-sm font-semibold">
          ← Loopp Support Agent
        </Link>
        <div className="flex items-center gap-2">
          {/* Voice is a non-functional placeholder until the Realtime build phase. */}
          <button
            type="button"
            disabled
            title="Live voice — coming next"
            className="cursor-not-allowed rounded-full border border-zinc-300 px-4 py-1.5 text-sm text-zinc-400 dark:border-zinc-700"
          >
            🎙 Voice (coming next)
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

      <div className="flex flex-1">
        <main className="flex flex-1 flex-col">
          {/* Message list */}
          <div className="flex-1 space-y-4 overflow-y-auto px-4 py-6 sm:px-8">
            {messages.map((message) => (
              <div
                key={message.id}
                className={`max-w-xl rounded-2xl px-4 py-3 text-sm ${
                  message.role === "assistant"
                    ? "bg-zinc-100 dark:bg-zinc-800"
                    : "ml-auto bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                }`}
              >
                {message.content}
              </div>
            ))}
          </div>

          {/* Input */}
          <form
            onSubmit={handleSubmit}
            className="flex gap-2 border-t border-zinc-200 px-4 py-4 dark:border-zinc-800 sm:px-8"
          >
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Type your message…"
              className="flex-1 rounded-full border border-zinc-300 bg-transparent px-4 py-2 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700"
            />
            <button
              type="submit"
              className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
            >
              Send
            </button>
          </form>
        </main>

        {/* Observability drawer */}
        {drawerOpen && (
          <aside className="w-80 shrink-0 overflow-y-auto border-l border-zinc-200 p-4 dark:border-zinc-800">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Observability</h2>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                aria-label="Close observability drawer"
                className="rounded-full px-2 py-1 text-sm text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                ✕
              </button>
            </div>
            <div className="mt-4 space-y-4">
              {OBSERVABILITY_SECTIONS.map((section) => (
                <section
                  key={section.title}
                  className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800"
                >
                  <h3 className="text-sm font-medium">{section.title}</h3>
                  <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                    {section.body}
                  </p>
                </section>
              ))}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
