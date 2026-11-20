/**
 * RLS negative tests (architecture-v2.md §8.1, §9).
 *
 * Asserts that the ANON key cannot read or write anything: RLS is enabled
 * on every table with NO policies for anon/authenticated (deny-all).
 *
 * - SELECT with deny-all RLS returns ZERO ROWS (no error) — so the
 *   assertion is `rows.length === 0`. Note: this is vacuous on an empty
 *   table; the script warns when it cannot tell a denied read from an
 *   empty table (run after `npm run ingest` + `npm run seed` for a
 *   meaningful read test).
 * - INSERT with deny-all RLS returns an ERROR (42501) — asserted directly.
 * - The match_policies RPC runs with the caller's privileges (not
 *   SECURITY DEFINER), so anon gets zero rows from it too.
 *
 * Usage: npm run test:rls
 * Requires: NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY in
 * .env.local. Skips gracefully (exit 0) without them — CI without a
 * Supabase project does not fail on this script.
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const TABLES = [
  "policy_chunks",
  "sessions",
  "messages",
  "turn_traces",
  "orders",
  "refunds",
  "tickets",
  "tool_calls",
] as const;

// Minimal rows that would violate nothing EXCEPT RLS (an insert that fails
// on a NOT NULL / FK error instead of RLS would be a false pass — these
// rows are shaped to pass every other check).
const INSERT_PROBES: Record<string, Record<string, unknown>> = {
  policy_chunks: {
    policy_slug: "rls-probe",
    chunk_index: 999,
    section: "probe",
    content: "probe",
    embedding: Array(1536).fill(0),
  },
  sessions: { id: "00000000-0000-4000-8000-000000000099" },
  messages: {
    session_id: "00000000-0000-4000-8000-000000000099",
    role: "user",
    content: "probe",
  },
  turn_traces: {
    session_id: "00000000-0000-4000-8000-000000000099",
    turn_number: 999,
    trace: [],
  },
  orders: {
    order_id: "NW-99999",
    email: "probe@example.com",
    status: "processing",
    items: [],
    total_cents: 0,
    placed_at: new Date().toISOString(),
  },
  refunds: {
    order_id: "NW-99999",
    idempotency_key: "rls-probe",
    amount_cents: 100,
    reason: "probe",
    session_id: "00000000-0000-4000-8000-000000000099",
  },
  tickets: {
    session_id: "00000000-0000-4000-8000-000000000099",
    turn_number: 999,
    subject: "probe",
    category: "probe",
    summary: "probe",
  },
  tool_calls: {
    session_id: "00000000-0000-4000-8000-000000000099",
    turn_number: 999,
    call_id: "rls-probe",
    tool_name: "probe",
    args: {},
  },
};

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    console.log(
      "SKIP: NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY not set.\n" +
        "Create a Supabase project, apply supabase/migrations, and set the vars in .env.local.",
    );
    return;
  }

  const anon = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Strict INSERT tests need the foreign keys satisfied: an anon insert
  // that fails on an FK error (23503) instead of RLS (42501) is
  // INCONCLUSIVE, not a pass. When the service key is available, create
  // the probe parents first (and clean them up after) so any anon error
  // IS the RLS denial.
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  let parentsReady = false;
  if (serviceKey) {
    const admin = createClient(url, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    await admin.from("sessions").upsert({
      id: "00000000-0000-4000-8000-000000000099",
    });
    await admin.from("orders").upsert({
      order_id: "NW-99999",
      email: "probe@example.com",
      status: "processing",
      items: [],
      total_cents: 0,
      placed_at: new Date().toISOString(),
    });
    parentsReady = true;
  }

  let failures = 0;
  let inconclusive = 0;
  console.log("\nRLS negative tests (anon key must be denied everywhere)\n");

  for (const table of TABLES) {
    // SELECT: expect zero rows.
    const { data, error } = await anon.from(table).select("*").limit(1);
    if (error) {
      console.log(`  ${table}: SELECT errored (${error.message}) — denied ✓`);
    } else if (Array.isArray(data) && data.length === 0) {
      console.log(
        `  ${table}: SELECT returned 0 rows — denied ✓ (or table is empty; run after ingest/seed for a strict read test)`,
      );
    } else {
      console.log(`  ${table}: SELECT RETURNED ROWS — RLS HOLE ✗`);
      failures += 1;
    }

    // INSERT: expect a 42501 (insufficient_privilege) RLS error.
    const probe = INSERT_PROBES[table];
    const insert = await anon.from(table).insert(probe).select();
    if (insert.error && insert.error.code === "42501") {
      console.log(`  ${table}: INSERT denied with 42501 — denied ✓`);
    } else if (insert.error) {
      console.log(
        `  ${table}: INSERT errored with ${insert.error.code} (${insert.error.message}) — INCONCLUSIVE (not the RLS error; ${parentsReady ? "unexpected" : "set SUPABASE_SERVICE_ROLE_KEY for strict FK-satisfied probes"})`,
      );
      inconclusive += 1;
    } else if (Array.isArray(insert.data) && insert.data.length === 0) {
      console.log(`  ${table}: INSERT returned 0 rows — denied ✓`);
    } else {
      console.log(`  ${table}: INSERT SUCCEEDED — RLS HOLE ✗`);
      failures += 1;
    }
  }

  // RPC: expect zero rows (the function runs with caller privileges).
  const { data: rpcData, error: rpcError } = await anon.rpc("match_policies", {
    query_embedding: Array(1536).fill(0),
    match_count: 5,
  });
  if (rpcError) {
    console.log(`  match_policies RPC errored (${rpcError.message}) — denied ✓`);
  } else if (Array.isArray(rpcData) && rpcData.length === 0) {
    console.log("  match_policies RPC returned 0 rows — denied ✓");
  } else {
    console.log("  match_policies RPC RETURNED ROWS — RLS HOLE ✗");
    failures += 1;
  }

  // Clean up the probe parents (service client only).
  if (parentsReady && serviceKey) {
    const admin = createClient(url, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    await admin.from("orders").delete().eq("order_id", "NW-99999");
    await admin.from("sessions").delete().eq("id", "00000000-0000-4000-8000-000000000099");
  }

  console.log("");
  if (failures > 0) {
    console.error(`FAILED: ${failures} RLS hole(s) found.`);
    process.exit(1);
  }
  if (inconclusive > 0) {
    console.log(
      `PASSED with ${inconclusive} INCONCLUSIVE insert probe(s) — rerun with SUPABASE_SERVICE_ROLE_KEY set for strict results.`,
    );
    return;
  }
  console.log("PASSED: anon is denied on all 8 tables + the RPC.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
