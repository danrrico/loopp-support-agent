/**
 * SSE client for POST /api/chat (architecture-v2.md §6.3).
 *
 * The chat route streams `text` (verified tokens), `trace` (typed trace
 * events), `done` (turn complete), and `error` (typed error). A stream
 * that ends WITHOUT `done` is INTERRUPTED, not complete — the caller marks
 * the turn partial and tells the user honestly.
 */

import type {
  ChatDone,
  ChatStreamError,
  TraceEvent,
} from "@/lib/client/types";

export interface ChatStreamHandlers {
  onText: (delta: string) => void;
  onTrace: (event: TraceEvent) => void;
  onDone: (done: ChatDone) => void;
  onError: (error: ChatStreamError) => void;
  /** Stream closed without a `done` event (network drop, timeout). */
  onInterrupted: () => void;
}

/** POST a chat message and stream the response. Throws on HTTP errors. */
export async function streamChat(
  message: string,
  handlers: ChatStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
    signal,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      code?: string;
      error?: string;
    };
    throw new Error(body.error ?? `Chat request failed (${res.status})`);
  }
  if (!res.body) throw new Error("No response body from /api/chat");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawDone = false;

  const handleBlock = (block: string) => {
    let event: string | null = null;
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!event || !data) return;
    try {
      const parsed = JSON.parse(data) as unknown;
      if (event === "text") {
        handlers.onText((parsed as { delta: string }).delta ?? "");
      } else if (event === "trace") {
        handlers.onTrace(parsed as TraceEvent);
      } else if (event === "done") {
        sawDone = true;
        handlers.onDone(parsed as ChatDone);
      } else if (event === "error") {
        handlers.onError(parsed as ChatStreamError);
      }
    } catch {
      // Malformed event — ignore, the stream continues.
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      handleBlock(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 2);
    }
  }
  if (buffer.trim().length > 0) handleBlock(buffer);

  if (!sawDone) handlers.onInterrupted();
}
