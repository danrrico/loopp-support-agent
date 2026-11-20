import { NextResponse } from "next/server";
import type { Message } from "@/lib/types";

// TODO (build phase): wire Vercel AI SDK `streamText` + the LangGraph agent
// here — RAG retrieval, tool calls (orderLookup, initiateRefund,
// createTicket), confidence guardrails, and human escalation — and return a
// streaming response instead of this placeholder JSON.
export async function POST(request: Request) {
  const body = (await request.json()) as { messages?: Message[] };
  const messages = body.messages ?? [];

  return NextResponse.json({
    status: "placeholder",
    message:
      "Streaming chat is not wired up yet. The LangGraph agent + Vercel AI SDK streamText integration lands in the build phase.",
    receivedMessages: messages.length,
  });
}
