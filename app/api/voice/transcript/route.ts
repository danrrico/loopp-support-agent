/**
 * POST /api/voice/transcript — voice turn (architecture-v2.md §4.2).
 *
 * The browser POSTs each completed Realtime transcript here (cookie
 * session). The server runs the SAME LangGraph as text and returns the
 * gated speakable text + trace; the browser speaks it verbatim via
 * `response.create` ("read verbatim"). Realtime is transport only — zero
 * functions are declared, and there is no endpoint that executes a tool
 * from a voice function call.
 *
 * Dedup: each POST carries the Realtime `item_id` of the completed input
 * item; the turn runner dedupes on (session_id, item_id) so a retried
 * POST cannot double-run a turn or double-execute a tool.
 *
 * Interruption: if the user barged in while the agent was speaking, the
 * browser marks the turn with possiblyTruncated + interruption metadata —
 * the stored turn never claims a false precise cut point (§4.5).
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

// Hobby plan limit until the Vercel plan is confirmed (Pro: 60s).
export const maxDuration = 10;

const bodySchema = z.object({
  transcript: z.string().min(1).max(2000),
  itemId: z.string().min(1).max(200),
  possiblyTruncated: z.boolean().optional(),
  interruptionMeta: z
    .object({
      interruptedAtMs: z.number().nullable().optional(),
      responseId: z.string().optional(),
      itemId: z.string().optional(),
    })
    .optional(),
});

function clientIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid request body", code: "VALIDATION_ERROR" },
      { status: 400 },
    );
  }

  const cookieHeader = request.headers.get("cookie");
  let sessionId = parseSessionCookie(cookieHeader);
  let newCookie: string | null = null;
  if (!sessionId) {
    sessionId = newSessionId();
    newCookie = sessionCookieHeader(sessionId);
  }

  // Each transcript is a graph run — same per-session limit as chat.
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

  const { transcript, itemId, possiblyTruncated, interruptionMeta } =
    parsed.data;

  let result;
  try {
    result = await runAgentTurn({
      sessionId,
      userMessage: transcript,
      modality: "voice",
      itemId,
    });
  } catch (err) {
    if (err instanceof VersionConflictError) {
      return Response.json(
        {
          error: "Another turn ran concurrently for this session.",
          code: "VERSION_CONFLICT",
        },
        { status: 409 },
      );
    }
    console.error("[voice/transcript] turn failed:", err);
    return Response.json(
      { error: "The support agent hit an unexpected error.", code: "GRAPH_ERROR" },
      { status: 500 },
    );
  }

  const headers: Record<string, string> = {};
  if (newCookie) headers["Set-Cookie"] = newCookie;

  if (result.outcome === "duplicate") {
    // Retried POST — replay the stored result, no new turn persisted.
    return Response.json(
      {
        speakableText: result.speakableText,
        trace: [],
        turnNumber: result.turnNumber,
        terminalState: result.terminalState,
        duplicate: true,
      },
      { headers },
    );
  }

  const { state, trace } = result.run!;
  const speakableText = state.finalAnswer ?? "";
  const turnNumber = result.turnNumber;

  after(async () => {
    try {
      const store = await getStore();
      await store.appendMessage(sessionId, {
        role: "user",
        content: transcript,
        modality: "voice",
        possiblyTruncated: possiblyTruncated ?? false,
        interruptionMeta:
          (interruptionMeta as unknown as Record<string, unknown>) ?? null,
      });
      await store.appendMessage(sessionId, {
        role: "assistant",
        content: speakableText,
        modality: "voice",
        possiblyTruncated: false,
        interruptionMeta: null,
      });
      await store.saveTurnTrace(sessionId, turnNumber, trace, false);
    } catch (err) {
      console.error("[voice/transcript] after() persistence failed:", err);
    }
  });

  return Response.json(
    {
      speakableText,
      trace,
      turnNumber,
      terminalState: state.terminalState,
      ticketId: state.escalation?.ticketId ?? null,
    },
    { headers },
  );
}
