# Loopp Support Agent

Customer Support AI Agent — **Loopp AI Engineer technical assessment** (due Wed Nov 25, 2026).

A full-stack support agent with streaming chat, live voice, RAG over a
Supabase pgvector knowledge base, multi-step tool orchestration, and a
built-in observability drawer.

## Stack

- **Next.js 16** (App Router, TypeScript) + **Tailwind CSS 4**
- **Vercel AI SDK** (`ai` + `@ai-sdk/openai`) — streaming chat
- **LangGraph.js** (`@langchain/langgraph`, `@langchain/core`, `@langchain/openai`) — agent orchestration
- **Supabase** (`@supabase/supabase-js`, pgvector) — RAG knowledge base + session state
- **OpenAI Realtime over WebRTC** — live voice

## Setup

```bash
npm install
cp .env.example .env.local   # fill in your keys — never commit .env.local
npm run dev                  # http://localhost:3000
```

## Feature checklist

- [ ] Streaming chat (Vercel AI SDK `streamText` + LangGraph agent)
- [ ] Live voice (OpenAI Realtime over WebRTC)
- [ ] RAG with confidence guardrails + human escalation
- [ ] Mock tools: `orderLookup`, `initiateRefund`, `createTicket`
- [ ] Observability drawer (traces, latency, retrieval, tool calls)
- [ ] Session state (Supabase)

## Deploy

Deploy on [Vercel](https://vercel.com). Set the same environment variables
from `.env.example` in the Vercel project settings.
