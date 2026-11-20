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
import { createClient } from "@supabase/supabase-js";
import { loadMockOrders } from "@/lib/db/mock-orders";

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

  const orders = loadMockOrders();
  const rows = orders.map((o) => ({
    order_id: o.order_id,
    email: o.email,
    status: o.status,
    items: o.items,
    total_cents: o.total_cents,
    refunded_cents: o.refunded_cents,
    placed_at: o.placed_at,
    tracking_number: o.tracking_number ?? null,
    carrier: o.carrier ?? null,
    estimated_delivery: o.estimated_delivery ?? null,
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
