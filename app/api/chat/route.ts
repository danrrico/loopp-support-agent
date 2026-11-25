/**
 * POST /api/chat — streaming chat (architecture-v2.md §1.3, §5.5, §6.3).
 *
 * Flow: validate (zod) → rate limit → cookie session → run the LangGraph
 * graph (buffered) → stream-replay the VERIFIED answer over SSE.
 *
 * The draft is verified BEFORE anything streams (§3.2): the graph buffers
 * the draft, the verifier checks it, and only then does this route replay
 * the text. A `checking_policy` trace event goes out first so the UI stays
 * live during verification (~1–2s TTFT trade, disclosed in the drawer).
 *
 * Stream protocol (pinned, §6.3): SSE events `text` (verified tokens),
 * `trace` (typed trace events), `done` (turn complete + totals), `error`
 * (typed error with `code`). A stream that ends without `done` is
 * INTERRUPTED, not complete. Message + trace persistence runs in
 * Next.js `after()` so a slow write cannot block the stream — but the
 * session-state snapshot is saved synchronously before streaming, because
 * the next turn (e.g. a refund confirmation) depends on it.
 */

import { after } from "next/server";
import { z } from "zod";
import { getStore, VersionConflictError } from "@/lib/db/store";
import { checkChatRateLimit } from "@/lib/rate-limit";
import {
  newSessionId,
  parseSessionCookie,
  sessionCookieHeader,
} from "@/lib/session";
import { runAgentTurn } from "@/lib/turn-runner";
import type { TraceEvent } from "@/lib/trace";

// 60s: a cold start (~8s) + a full graph turn (~6s) does not fit in the
// 10s default — the function was killed mid-turn on cold starts. 60s is
// the Hobby maximum under the pre-Fluid limit and well under Fluid's 300s.
export const maxDuration = 60;

const bodySchema = z.object({
  message: z.string().min(1).max(4000),
});

function clientIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Split the verified answer into word-chunks for the stream replay. */
function chunkText(text: string, wordsPerChunk = 4): string[] {
  const words = text.split(/(?<=\s)/);
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += wordsPerChunk) {
    chunks.push(words.slice(i, i + wordsPerChunk).join(""));
  }
  return chunks;
}

export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid request body", code: "VALIDATION_ERROR" },
      { status: 400 },
    );
  }

  // Session from the httpOnly cookie — never from the body or URL.
  const cookieHeader = request.headers.get("cookie");
  let sessionId = parseSessionCookie(cookieHeader);
  let newCookie: string | null = null;
  if (!sessionId) {
    sessionId = newSessionId();
    newCookie = sessionCookieHeader(sessionId);
  }

  const rate = checkChatRateLimit(clientIp(request), sessionId);
  if (!rate.allowed) {
    return Response.json(
      { error: "Rate limit exceeded", code: "RATE_LIMITED" },
      {
        status: 429,
        headers: { "Retry-After": String(rate.retryAfterSeconds) },
      },
    );
  }

  const { message } = parsed.data;

  // Records to persist in after(): filled in once the turn runs.
  const records: {
    turnNumber: number | null;
    trace: TraceEvent[] | null;
    assistantContent: string | null;
    partial: boolean;
  } = { turnNumber: null, trace: null, assistantContent: null, partial: true };

  after(async () => {
    if (records.turnNumber === null) return;
    try {
      const store = await getStore();
      await store.appendMessage(sessionId, {
        role: "user",
        content: message,
        modality: "text",
        possiblyTruncated: false,
        interruptionMeta: null,
      });
      if (records.assistantContent !== null) {
        await store.appendMessage(sessionId, {
          role: "assistant",
          content: records.assistantContent,
          modality: "text",
          possiblyTruncated: false,
          interruptionMeta: null,
        });
      }
      if (records.trace) {
        await store.saveTurnTrace(
          sessionId,
          records.turnNumber,
          records.trace,
          records.partial,
        );
      }
    } catch (err) {
      console.error("[chat] after() persistence failed:", err);
    }
  });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(sseEvent(event, data)));
      };
      try {
        // Liveness first: the UI shows "checking policy" while the graph runs.
        send("trace", {
          type: "checking_policy",
          turn: 0,
          at: new Date().toISOString(),
          elapsedMs: 0,
          payload: { note: "Running the support agent — verifying before answering." },
        } satisfies TraceEvent);

        const result = await runAgentTurn({
          sessionId,
          userMessage: message,
          modality: "text",
        });
        if (result.outcome !== "ran" || !result.run) {
          throw new Error("Unexpected turn outcome");
        }
        const { state, trace } = result.run;
        const finalAnswer = state.finalAnswer ?? "";
        records.turnNumber = result.turnNumber;
        records.trace = trace;
        records.assistantContent = finalAnswer;

        // Replay the server trace, then the verified text.
        for (const event of trace) {
          if (event.type === "done") continue; // re-emitted below as `done`
          send("trace", event);
        }
        for (const chunk of chunkText(finalAnswer)) {
          send("text", { delta: chunk });
        }
        records.partial = false;
        send("done", {
          turnNumber: result.turnNumber,
          terminalState: state.terminalState,
          totalLatencyMs: trace.at(-1)?.elapsedMs ?? 0,
          partial: false,
        });
      } catch (err) {
        if (err instanceof VersionConflictError) {
          send("error", {
            code: "VERSION_CONFLICT",
            message:
              "Another turn ran concurrently for this session. Please resend your message.",
          });
        } else {
          console.error("[chat] turn failed:", err);
          send("error", {
            code: "GRAPH_ERROR",
            message: "The support agent hit an unexpected error. Please try again.",
          });
        }
      } finally {
        controller.close();
      }
    },
  });

  const headers: Record<string, string> = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  };
  if (newCookie) headers["Set-Cookie"] = newCookie;
  return new Response(stream, { headers });
}
