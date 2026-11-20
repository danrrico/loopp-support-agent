-- Loopp Support Agent — atomic refund execution (architecture-v2.md §5.3, §5.5)
--
-- `execute_refund` runs the whole refund in one transaction, with the order
-- row locked (SELECT ... FOR UPDATE):
--   1. Idempotency first: a retry with the same (order_id, idempotency_key)
--      returns the stored refund instead of executing twice.
--   2. Balance check: amount must be > 0 and <= total_cents - refunded_cents.
--   3. Insert the refund row + bump orders.refunded_cents atomically.
--
-- Returns one row: the refund on success, or error_code ORDER_NOT_FOUND /
-- OVER_BALANCE on a business failure. Callers must NOT retry on a business
-- failure — only on a system failure (RPC error / exception).
-- The CHECK (refunded_cents <= total_cents) on orders is the backstop.

CREATE OR REPLACE FUNCTION execute_refund(
  p_order_id text,
  p_idempotency_key text,
  p_amount_cents integer,
  p_reason text,
  p_session_id uuid
)
RETURNS TABLE (
  refund_id uuid,
  out_order_id text,
  out_amount_cents integer,
  out_status text,
  error_code text
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_total integer;
  v_refunded integer;
  v_refund_id uuid;
BEGIN
  -- Idempotency: a retry with the same key returns the stored outcome.
  SELECT r.id INTO v_refund_id
  FROM refunds r
  WHERE r.order_id = p_order_id AND r.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN QUERY
      SELECT r.id, r.order_id, r.amount_cents, r.status, NULL::text
      FROM refunds r WHERE r.id = v_refund_id;
    RETURN;
  END IF;

  -- Lock the order row: the balance check + update are atomic.
  SELECT o.total_cents, o.refunded_cents INTO v_total, v_refunded
  FROM orders o WHERE o.order_id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY
      SELECT NULL::uuid, p_order_id, p_amount_cents, 'failed'::text,
             'ORDER_NOT_FOUND'::text;
    RETURN;
  END IF;

  IF p_amount_cents <= 0 OR p_amount_cents > (v_total - v_refunded) THEN
    RETURN QUERY
      SELECT NULL::uuid, p_order_id, p_amount_cents, 'failed'::text,
             'OVER_BALANCE'::text;
    RETURN;
  END IF;

  INSERT INTO refunds (order_id, idempotency_key, amount_cents, reason, session_id)
  VALUES (p_order_id, p_idempotency_key, p_amount_cents, p_reason, p_session_id)
  RETURNING id INTO v_refund_id;

  UPDATE orders SET refunded_cents = refunded_cents + p_amount_cents
  WHERE order_id = p_order_id;

  RETURN QUERY
    SELECT r.id, r.order_id, r.amount_cents, r.status, NULL::text
    FROM refunds r WHERE r.id = v_refund_id;
END;
$$;
