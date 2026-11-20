"use client";

import type { SessionMessage } from "@/lib/client/types";

export interface DisplayMessage extends SessionMessage {
  /** True while this assistant message is still streaming in. */
  streaming?: boolean;
}

function Bubble({ message }: { message: DisplayMessage }) {
  const isUser = message.role === "user";
  return (
    <div
      className={`max-w-xl rounded-2xl px-4 py-3 text-sm ${
        isUser
          ? "ml-auto bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
          : "bg-zinc-100 dark:bg-zinc-800"
      }`}
    >
      <p className="whitespace-pre-wrap">{message.content}</p>
      <div className="mt-1 flex gap-2 text-[11px] opacity-60">
        {message.modality === "voice" && <span>🎙 voice</span>}
        {message.possiblyTruncated && (
          <span title="The user interrupted playback; this text may not have been fully heard.">
            [possibly truncated]
          </span>
        )}
        {message.streaming && <span className="animate-pulse">▍</span>}
      </div>
    </div>
  );
}

export function MessageList({ messages }: { messages: DisplayMessage[] }) {
  if (messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-4 py-6">
        <p className="max-w-md text-center text-sm text-zinc-500 dark:text-zinc-400">
          Hi, I&apos;m the Northwind Outfitters support assistant. Ask me
          about returns, refunds, or an order — or try &ldquo;How long is the
          warranty?&rdquo;
        </p>
      </div>
    );
  }
  return (
    <div className="flex-1 space-y-4 overflow-y-auto px-4 py-6 sm:px-8">
      {messages.map((message) => (
        <Bubble key={message.id} message={message} />
      ))}
    </div>
  );
}
