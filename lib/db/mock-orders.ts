/**
 * Shared mock-order loader (architecture-v2.md §10.2).
 *
 * `data/mock-orders.json` stores `daysAgo` instead of absolute dates so the
 * 60-day return-window eligibility stays stable over time: placed_at is
 * computed at load/seed time as now − daysAgo. Both the seed script and
 * the in-memory demo store use this loader — one source of truth.
 */

import fs from "node:fs";
import path from "node:path";

export interface MockOrderItem {
  name: string;
  qty: number;
  price_cents: number;
}

export interface MockOrder {
  order_id: string;
  email: string;
  status: string;
  items: MockOrderItem[];
  total_cents: number;
  refunded_cents: number;
  placed_at: string; // ISO timestamp, computed from daysAgo
  tracking_number?: string;
  carrier?: string;
  estimated_delivery?: string;
}

interface RawMockOrder {
  order_id: string;
  email: string;
  status: string;
  items: MockOrderItem[];
  total_cents: number;
  refunded_cents: number;
  daysAgo: number;
  tracking_number?: string;
  carrier?: string;
  estimated_delivery?: string;
}

export function loadMockOrders(): MockOrder[] {
  const file = path.join(process.cwd(), "data", "mock-orders.json");
  const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as {
    orders: RawMockOrder[];
  };
  const now = Date.now();
  return parsed.orders.map((o) => ({
    order_id: o.order_id,
    email: o.email,
    status: o.status,
    items: o.items,
    total_cents: o.total_cents,
    refunded_cents: o.refunded_cents,
    placed_at: new Date(now - o.daysAgo * 24 * 60 * 60 * 1000).toISOString(),
    tracking_number: o.tracking_number,
    carrier: o.carrier,
    estimated_delivery: o.estimated_delivery,
  }));
}
