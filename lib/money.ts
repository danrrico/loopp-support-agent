/**
 * Money + display-ID helpers (integer cents everywhere).
 *
 * Amounts are computed in code, never taken from model arguments. Display
 * strings ("$129.00", "RF-2291") are produced here so the draft and the
 * verifier agree on the numbers: tool results carry the display strings,
 * and the number assert allows any number that appears in a tool result.
 */

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Human-friendly refund display ID, derived deterministically from the
 * refund row's UUID so retries return the same display ID. Raw UUIDs are
 * never shown to the user (their digit fragments would trip the number
 * assert and are unreadable on the phone).
 */
export function refundDisplayId(refundUuid: string): string {
  let hash = 0;
  for (let i = 0; i < refundUuid.length; i++) {
    hash = (Math.imul(hash, 31) + refundUuid.charCodeAt(i)) >>> 0;
  }
  return `RF-${String(1000 + (hash % 9000))}`;
}
