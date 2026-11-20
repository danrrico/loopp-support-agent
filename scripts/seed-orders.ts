/**
 * Seed the orders table from data/mock-orders.json (architecture-v2.md §10).
 *
 * placed_at is derived from each order's `daysAgo` at seed time, so refund
 * eligibility (60-day window) stays stable no matter when the seed runs.
 * Upsert on order_id — re-running the seed is idempotent.
 *
 * Usage: npm run seed
 * Requires: Supabase project with migrations applied + env vars in .env.local.
 */

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

interface SeedOrder {
  order_id: string;
  email: string;
  status: string;
  items: Array<{ name: string; qty: number; price_cents: number }>;
  total_cents: number;
  refunded_cents: number;
  daysAgo: number;
  tracking_number: string | null;
  carrier: string | null;
  estimated_delivery: string | null;
}

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    console.error(
      "Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. " +
        "Create a Supabase project, apply supabase/migrations, and set the " +
        "vars in .env.local (see setup-v2.md §4–5).",
    );
    process.exit(1);
  }
  const supabase = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const raw = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "data", "mock-orders.json"), "utf-8"),
  ) as { orders: SeedOrder[] };

  const rows = raw.orders.map((o) => ({
    order_id: o.order_id,
    email: o.email,
    status: o.status,
    items: o.items,
    total_cents: o.total_cents,
    refunded_cents: o.refunded_cents,
    placed_at: new Date(Date.now() - o.daysAgo * 24 * 60 * 60 * 1000).toISOString(),
    tracking_number: o.tracking_number,
    carrier: o.carrier,
    estimated_delivery: o.estimated_delivery,
  }));

  const { error } = await supabase
    .from("orders")
    .upsert(rows, { onConflict: "order_id" });
  if (error) {
    console.error(`Seed failed: ${error.message}`);
    process.exit(1);
  }
  console.log(`✓ Seeded ${rows.length} orders.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
