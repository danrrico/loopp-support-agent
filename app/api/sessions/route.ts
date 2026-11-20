/**
 * Sessions API (architecture-v2.md §7).
 *
 * GET  /api/sessions — resume the cookie session: messages (last 20),
 *   turn traces, escalated flag. Creates the session (and sets the
 *   cookie) when none exists. The confirmation token inside pendingAction
 *   is NEVER exposed to the browser.
 * POST /api/sessions — start a fresh session (new UUID, new row, new
 *   cookie). Used by "New chat".
 *
 * Resume is by cookie only — no `?session=` URL parameter.
 */

import { NextResponse } from "next/server";
import { getStore } from "@/lib/db/store";
import {
  newSessionId,
  parseSessionCookie,
  sessionCookieHeader,
} from "@/lib/session";

export async function GET(request: Request) {
  const cookieHeader = request.headers.get("cookie");
  let sessionId = parseSessionCookie(cookieHeader);
  let newCookie: string | null = null;
  if (!sessionId) {
    sessionId = newSessionId();
    newCookie = sessionCookieHeader(sessionId);
  }

  const store = await getStore();
  let session = await store.getSession(sessionId);
  if (!session) {
    session = await store.createSession(sessionId);
  }
  const messages = await store.getMessages(sessionId, 20);
  const traces = await store.getTurnTraces(sessionId);
  const turnCount = (session.state.turnNumber as number | undefined) ?? 0;

  const response = NextResponse.json({
    sessionId,
    escalated: session.escalated,
    turnCount,
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      modality: m.modality,
      possiblyTruncated: m.possiblyTruncated,
      createdAt: m.createdAt,
    })),
    traces: traces.map((t) => ({
      turnNumber: t.turnNumber,
      trace: t.trace,
      partial: t.partial,
    })),
  });
  if (newCookie) response.headers.set("Set-Cookie", newCookie);
  return response;
}

export async function POST() {
  const sessionId = newSessionId();
  const store = await getStore();
  await store.createSession(sessionId);
  const response = NextResponse.json({ sessionId });
  response.headers.set("Set-Cookie", sessionCookieHeader(sessionId));
  return response;
}
