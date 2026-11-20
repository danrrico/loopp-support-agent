-- Loopp Support Agent — initial schema (architecture-v2.md §10.2)
--
-- RLS is ENABLED on every table with NO policies for anon/authenticated,
-- which means deny-all by default. All database access goes through server
-- routes using the service-role client. The browser never touches the DB.
-- This closes the RAG-poisoning hole (anyone inserting fake policy chunks)
-- and the cross-session read hole.
--
-- Apply with the Supabase CLI (`supabase db push`) or the dashboard SQL
-- editor. Requires a Supabase project with pgvector available.

CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- policy_chunks — RAG corpus. chunk_index is a REAL integer column (not
-- metadata). No vector index: exact scan at ~40 chunks (IVFFlat hurts
-- recall at this size — architecture-v2.md §2.2).
-- ---------------------------------------------------------------------------
CREATE TABLE policy_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_slug text NOT NULL,
  chunk_index integer NOT NULL,
  section text NOT NULL,
  content text NOT NULL,
  embedding vector(1536) NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,   -- { policy_title, section_heading }
  corpus_version text NOT NULL DEFAULT 'v1',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (policy_slug, chunk_index)
);

-- ---------------------------------------------------------------------------
-- sessions — one row per conversation. state holds the AgentState snapshot
-- (incl. structured pendingAction); summary is prose only. version is the
-- optimistic-concurrency counter for per-session turn serialization.
-- ---------------------------------------------------------------------------
CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'active',          -- active | escalated | closed
  state jsonb NOT NULL DEFAULT '{}'::jsonb,        -- AgentState snapshot incl. pendingAction
  summary text NOT NULL DEFAULT '',                -- session_summary (prose only)
  escalated boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 0               -- optimistic concurrency
);

-- ---------------------------------------------------------------------------
-- messages — persisted text + voice turns. possibly_truncated marks voice
-- turns interrupted mid-playback (no false precise cut point is claimed).
-- ---------------------------------------------------------------------------
CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role text NOT NULL,                              -- user | assistant
  content text NOT NULL,
  modality text NOT NULL DEFAULT 'text',           -- text | voice
  possibly_truncated boolean NOT NULL DEFAULT false,
  interruption_meta jsonb,                         -- { interrupted_at_ms, response_id, item_id }
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX messages_session_id_idx ON messages (session_id, created_at);

-- ---------------------------------------------------------------------------
-- turn_traces — structured per-turn trace history for the observability
-- drawer. partial = true when the stream was aborted mid-turn.
-- ---------------------------------------------------------------------------
CREATE TABLE turn_traces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_number integer NOT NULL,
  trace jsonb NOT NULL,
  partial boolean NOT NULL DEFAULT false,          -- true if the stream was aborted
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, turn_number)
);

-- ---------------------------------------------------------------------------
-- orders — seeded mock orders (read-only fixtures). Money is integer cents.
-- ---------------------------------------------------------------------------
CREATE TABLE orders (          -- seeded mock orders (read-only fixtures)
  order_id text PRIMARY KEY,   -- e.g. 'NW-88412'
  email text NOT NULL,
  status text NOT NULL,        -- processing | shipped | delivered | cancelled | backordered
  items jsonb NOT NULL,        -- [{ name, qty, price_cents }]
  total_cents integer NOT NULL CHECK (total_cents >= 0),
  refunded_cents integer NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0),
  placed_at timestamptz NOT NULL,
  tracking_number text,
  carrier text,
  estimated_delivery date,
  CHECK (refunded_cents <= total_cents)
);

CREATE INDEX orders_email_idx ON orders (email);

-- ---------------------------------------------------------------------------
-- refunds — one row per executed refund. UNIQUE (order_id, idempotency_key)
-- makes retries unable to double-execute (idempotency key derives from
-- sessionId + turn_number + confirmationToken).
-- ---------------------------------------------------------------------------
CREATE TABLE refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id text NOT NULL REFERENCES orders(order_id),
  idempotency_key text NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'initiated',
  session_id uuid NOT NULL REFERENCES sessions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, idempotency_key)
);

-- ---------------------------------------------------------------------------
-- tickets — escalation tickets, created ONLY by escalate_node (never by the
-- model). UNIQUE (session_id, turn_number): retries and reconnects cannot
-- duplicate a ticket.
-- ---------------------------------------------------------------------------
CREATE TABLE tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions(id),
  turn_number integer NOT NULL,
  subject text NOT NULL,
  category text NOT NULL,
  priority text NOT NULL DEFAULT 'medium',        -- low | medium | high
  summary text NOT NULL,                          -- sanitized handoff summary
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, turn_number)                -- one ticket per turn, retries cannot duplicate
);

-- ---------------------------------------------------------------------------
-- tool_calls — write-ahead record of every tool execution. UNIQUE
-- (session_id, call_id) dedupes retried turns. error_code distinguishes
-- business outcomes (ORDER_NOT_FOUND, REFUND_NOT_ELIGIBLE) from system
-- failures (DB error, timeout, validation failure).
-- ---------------------------------------------------------------------------
CREATE TABLE tool_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions(id),
  turn_number integer NOT NULL,
  call_id text NOT NULL,                          -- Realtime call_id (voice) or server UUID (text)
  tool_name text NOT NULL,
  args jsonb NOT NULL,
  result jsonb,
  error_code text,                                -- NULL on success; business vs system distinguished
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, call_id)
);

-- ---------------------------------------------------------------------------
-- RLS: enabled on EVERY table, NO policies — deny-all for anon and
-- authenticated. The service-role client (server routes only) bypasses RLS.
-- ---------------------------------------------------------------------------
ALTER TABLE policy_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE turn_traces ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_calls ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- match_policies — the ONLY retrieval entry point. pgvector `<=>` is cosine
-- DISTANCE; this RPC returns similarity = 1 - distance explicitly, ordered
-- nearest-first, exact scan (no vector index). No caller converts distance
-- to similarity.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION match_policies(
  query_embedding vector(1536),
  match_count int
) RETURNS TABLE (
  id uuid, policy_slug text, section text, content text, similarity float
) AS $$
  SELECT id, policy_slug, section, content,
         1 - (embedding <=> query_embedding) AS similarity
  FROM policy_chunks
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$ LANGUAGE sql STABLE;
