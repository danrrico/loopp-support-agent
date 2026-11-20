/**
 * Server-only Supabase client (architecture-v2.md §8.1).
 *
 * - Uses the SERVICE-ROLE key, which bypasses RLS. It lives in Vercel
 *   server-only env vars (no NEXT_PUBLIC_ prefix) and local .env.local.
 * - The browser never constructs a Supabase client and never holds a DB
 *   credential. RLS denies anon everything, so the anon key grants nothing.
 * - When the env vars are missing (no Supabase project yet), this module
 *   returns null instead of throwing — callers fall back to the in-memory
 *   demo store (lib/db/demo-store.ts) and the local RAG corpus
 *   (lib/rag/retrieve.ts). The app stays runnable with zero config.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cachedClient: SupabaseClient | null | undefined;
let warned = false;

export function isSupabaseConfigured(): boolean {
  return (
    Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
    Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY)
  );
}

/**
 * The service-role client, or null when Supabase is not configured.
 * Safe to call at import time and in any server context; never throws.
 */
export function getServiceClient(): SupabaseClient | null {
  if (cachedClient !== undefined) return cachedClient;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    if (!warned) {
      warned = true;
      console.warn(
        "[supabase] NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — " +
          "running in demo mode (in-memory store + local RAG corpus). " +
          "Create a Supabase project and set the env vars to persist state.",
      );
    }
    cachedClient = null;
    return null;
  }
  cachedClient = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return cachedClient;
}
