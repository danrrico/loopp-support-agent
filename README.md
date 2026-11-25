# Loopp Support Agent

Customer Support AI Agent — **Loopp AI Engineer technical assessment** (due Wed Nov 25, 2026).

A full-stack support agent for the fictional retailer **Northwind Outfitters** (US outdoor gear): streaming chat, live voice, RAG over a Supabase pgvector knowledge base, multi-step tool orchestration with two-phase refunds, deterministic confidence guardrails, and a built-in observability drawer.

**Live demo:** https://loopp-support-agent-two.vercel.app

## Quick start (no keys needed — demo mode)

```bash
npm install
npm run dev                  # http://localhost:3000 → /chat
```

With zero env vars configured, the app runs in **demo mode**: the deterministic mock model answers, retrieval runs an IDF-overlap keyword search over the local policy corpus, and state lives in an in-memory store seeded from `data/mock-orders.json`. Everything works end to end — including the full refund flow — with no network calls to any model provider. Demo state does not survive a restart or cross Vercel instances; the health endpoint reports `{ ok: true, db: false, openai: false }` in this mode.

To run with real services, copy `.env.example` to `.env.local` and fill in the keys (never commit `.env.local`).

## Architecture

```
Browser ──POST /api/chat (SSE)──▶ Next.js Route Handlers ──▶ LangGraph graph
                                                              │ route → retrieve
                                                              │ → gate → tools
                                                              │ → draft → verify
                                                              ▼
Voice ──WebRTC──▶ OpenAI Realtime (TRANSPORT ONLY: transcribe + speak,
                  zero functions) ──transcript──▶ POST /api/voice/transcript
                  ──▶ SAME LangGraph graph ──▶ speakable text (spoken verbatim)
```

**One graph serves text and voice.** The graph is the only authority: route intent (one structured-output call) → retrieve policies (shared `retrieve()`, top-k 5) → Stage-1 evidence gate → tool loop (max 3 iterations, `parallel_tool_calls: false`) → draft with structured claims → Stage-2 deterministic verifier → stream-replay of the **verified** answer. Escalation is a deterministic system node, never a model decision.

**Two-stage confidence gate (no pseudo-scores):**

- **Stage 1 (pre-generation, retrieval-only, intent-conditional):** policy/complaint intents use top-1 similarity bands (Answer ≥ 0.55, Caveat 0.40–0.55, Escalate < 0.40 or zero chunks); refunds require the rules to be retrievable before any tool call; order status is tool-answered and ungated.
- **Stage 2 (post-generation, downgrade-only):** the draft is buffered and verified by pure code — quote-substring asserts (every claim's quote must appear verbatim in the cited chunk), number asserts (every number/day/dollar in the answer must appear in the chunks or tool results), action-claim asserts (every claimed action must match an executed tool call). Any failure withholds the draft entirely and escalates. The drawer reports the evidence check, never a "confidence 0.82".

**Refunds are two-phase with confirmation:** `initiateRefund` proposes (eligibility + amount computed in code from the order row — delivered, within the 60-day window, integer cents, remaining balance), the user confirms, then it executes atomically (`execute_refund` RPC: row lock + balance check + insert + bump, idempotent on `(sessionId, turn_number, confirmationToken)`). Refunds over $500 route to escalation for human approval after confirmation. Confirmation uses an explicit `pendingAction` state machine persisted in `sessions.state`, not LangGraph `interrupt()` (no durable checkpointer exists yet — see Known limitations).

**Trust boundaries:** the browser is untrusted (cookie session only, no `?session=` bearer, zod on every body); the Realtime session is untrusted (zero functions declared); the model is untrusted for side effects (eligibility, amounts, escalation all in code); retrieved/user/tool text is data, never instructions.

**Model provider (env-swappable):** the chat client speaks the OpenAI chat-completions format with a configurable base URL + key + model ID (`MODEL_BASE_URL`, `MODEL_API_KEY`, `MODEL_ID`; `MODEL_API_KEY` falls back to `OPENAI_API_KEY`). Defaults point at api.openai.com / `gpt-4o-mini`. Swapping to another OpenAI-compatible provider is an env change, not a code change. No key → mock model fallback. Embeddings stay behind the `Embedder` interface with a mock implementation (deterministic hashed word counts); the OpenAI embedder lands with the key.

## What's built / what's stubbed

| Area | Status |
|---|---|
| Supabase schema (8 tables, RLS deny-all, `match_policies` RPC, `execute_refund` RPC) | ✅ Migrations written, **not yet applied** (no project exists) |
| Policy corpus (7 policies, 35 chunks) + ingestion + seed scripts | ✅ |
| RAG: shared `retrieve()`, chunking, mock embedder, local keyword search | ✅ |
| LangGraph graph (route/retrieve/gate/tools/draft/verify/escalate) | ✅ |
| Two-stage gate + deterministic verifier + escalation node | ✅ |
| Tools: `orderLookup`, `initiateRefund` (two-phase), `searchKnowledgeBase` | ✅ (DB-backed, zod-validated) |
| Chat API (SSE stream-replay), sessions, health, rate limits | ✅ |
| Voice transcript route (same graph, dedup on `(session_id, item_id)`) | ✅ |
| UI: chat shell, observability drawer, voice shell | ✅ |
| Unit tests (88), calibration eval, RLS negative tests | ✅ |
| **Voice mint (`/api/voice/session`)** | ✅ GA mint via POST `/v1/realtime/client_secrets`, model **pinned `gpt-realtime-2.1`** (verified live 2026-11-25; `gpt-4o-realtime-preview` does not exist on this key, beta `/v1/realtime/sessions` is retired) — WebRTC client in `lib/voice/realtime-client.ts`, SDP via POST `/v1/realtime/calls` |
| **Real embeddings + real chat model** | 🟡 Env-configured client ready; needs the OpenAI key (account exists, no credit yet) |
| **Supabase project + applied migrations + ingested corpus** | 🟡 Not created yet |
| **Threshold calibration** | 🟡 Provisional (0.30 / 0.40 / 0.55); `npm run eval` refuses to set them from mock similarities — re-run with real embeddings |
| **Session summarization** | 🟡 Not built — the graph receives the last 20 messages; summarization lands with the real model |
| **CI workflow** | 🟡 `.github/workflows/ci.yml` is written but NOT pushed — the repo token lacks `workflow` scope. Push it from a token/account with workflow scope, or add it via the GitHub web UI. |

## Demo script (the §5.4 path)

1. "I want to return the jacket from my last order and get my money back." → the agent asks for the order number.
2. "Order NW-88412." → lookup (delivered 12 days ago, $129.00) → "Just to confirm — refund $129.00 for order NW-88412? Reply yes to confirm, or no to cancel."
3. "Yes." → refund executes (RF-####) → "Done — refund RF-#### for $129.00 is on its way to your original payment method. Refunds are issued within 3 to 5 business days after inspection."
4. Try the edges: "Where is my order NW-88413?" (shipped), "What is your store address in Denver?" (escalates — unanswerable), "Let me talk to a human" (escalates), a refund for NW-88415 ($738 — escalates after confirmation), NW-88414 (outside the 60-day window — not eligible, no escalation).

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` / `build` / `start` | Next.js dev / production build / serve |
| `npm test` | Vitest unit tests (88) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run ingest` | Chunk + embed + upsert policies (transactional per-slug; needs Supabase + key) |
| `npm run seed` | Seed the 9 mock orders (upsert on `order_id`; needs Supabase) |
| `npm run eval` | Calibration eval over the 36 labeled questions — prints distributions, **refuses** to set thresholds from mock embeddings |
| `npm run test:rls` | Anon negative tests (denied on all 8 tables + RPC); skips gracefully without env |

## Environment variables

| Variable | Purpose |
|---|---|
| `MODEL_BASE_URL` / `MODEL_API_KEY` / `MODEL_ID` | Chat model provider (OpenAI-compatible). Defaults: `https://api.openai.com/v1` / — / `gpt-4o-mini` |
| `OPENAI_API_KEY` | Fallback for `MODEL_API_KEY`; also used for embeddings + Realtime minting |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | **Server-only.** All DB access goes through server routes with this key |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Present for completeness — the app does **not** use it (RLS denies anon everything) |
| `NEXT_PUBLIC_APP_URL` | Canonical demo URL |

## Database

Migrations live in `supabase/migrations/` (apply with `supabase db push` or the dashboard SQL editor; requires pgvector):

- `0001_init.sql` — 8 tables, RLS enabled with **no policies** (deny-all for anon), `match_policies` RPC returning similarity = 1 − distance, exact scan (no vector index at ~40 chunks).
- `0002_ingest_rpc.sql` — `ingest_policy_chunks()` (transactional delete-by-slug + reinsert).
- `0003_execute_refund.sql` — `execute_refund()` (row-locked balance check + insert + bump, idempotent).

## Known limitations (stated honestly)

- **No dedicated prompt-injection detection layer.** The boundary is structural (user/tool/retrieved content treated as data; capabilities enforced in code; zod validation; server-side eligibility).
- **Single-version policy corpus.** Re-ingest is transactional (no stale chunks), but there are no effective dates or cross-version precedence rules.
- **Calibration set is small (36 questions).** Thresholds are data-informed, not statistically rigorous. The eval reports the measured distributions so the basis is visible.
- **Voice latency.** The transport design adds graph round-trip time to every voice turn. The filler + trace events make it visible; it is not hidden.
- **No mid-turn resume.** A crashed turn restarts at the turn boundary; tool effects are not re-executed (idempotency), but in-flight generation is redone.
- **In-memory rate limiting + session locks.** Acceptable for a demo; production would use a shared store (Upstash / Postgres advisory locks).
- **The ownership cookie is the only session auth.** Appropriate for a public demo with synthetic data; a production system would add real user accounts.
- **Refund confirmation uses `pendingAction`, not LangGraph `interrupt()`.** Behavior is identical from the user's side; the pause lives in `sessions.state` instead of a checkpointer, so it survives across Vercel instances without a PostgresSaver.
- **`maxDuration` is 10s (Vercel Hobby)** on the chat + transcript routes until the plan is confirmed (Pro: 60s).
- **No summary call yet** — context is the last 20 messages; older turns are not summarized.

## Project layout

```
app/api/chat, voice/*, sessions, health   # Route handlers
app/chat                                  # Chat + voice + drawer layout
components/chat | voice | observability   # UI components
lib/agent   graph, state, model, evidence, verify, escalation, prompts, thresholds
lib/rag     retrieve, chunk, embeddings, local-search, text
lib/tools   schemas, execute (orderLookup, initiateRefund, searchKnowledgeBase)
lib/db      store interface, supabase-store, memory-store, mock-orders
lib         trace, session, session-lock, rate-limit, turn-runner, money
data/policies/*.md  data/mock-orders.json  data/eval-questions.json
scripts     ingest-policies, seed-orders, eval-retrieval, test-rls
supabase/migrations
```
