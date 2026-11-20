/**
 * GET /api/health — cached, minimal health check (architecture-v2.md §8.2).
 *
 * Body is booleans only: { ok, db, openai }. Cached ~30s (module-level)
 * so it never hammers the DB or leaks config errors. It must NOT call
 * OpenAI per hit — `openai` is an env check only (a key configured), not
 * a live API probe.
 *
 * `db: false` means demo mode (in-memory store + local RAG corpus) — the
 * app still runs, so `ok` stays true.
 */

import { NextResponse } from "next/server";
import { isModelConfigured } from "@/lib/agent/model";
import { getServiceClient, isSupabaseConfigured } from "@/lib/supabase/server";

const CACHE_MS = 30_000;

let cache: { at: number; body: { ok: boolean; db: boolean; openai: boolean } } | null =
  null;

export async function GET() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) {
    return NextResponse.json(cache.body);
  }

  let db = false;
  if (isSupabaseConfigured()) {
    try {
      // Cheap head query — proves the DB is reachable, reads no rows.
      const client = getServiceClient();
      const { error } = await client!
        .from("sessions")
        .select("id", { count: "exact", head: true })
        .limit(1);
      db = !error;
    } catch {
      db = false;
    }
  }

  const body = { ok: true, db, openai: isModelConfigured() };
  cache = { at: now, body };
  return NextResponse.json(body);
}
