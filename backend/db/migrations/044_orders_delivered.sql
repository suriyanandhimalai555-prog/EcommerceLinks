-- Migration 044: track physical delivery of confirmed orders.
--
-- "Delivered" is NOT a new status value — the status column stays 'confirmed'.
-- This avoids re-firing MemberActivated (orderService.ts:57-62) for repeat
-- buyers and keeps all existing confirmed-status guards correct.
-- Instead we use two nullable columns:
--   delivered_at   — timestamp when management marked delivery complete
--   delivered_by   — FK to the management member who clicked Mark Delivered

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS delivered_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delivered_by  BIGINT REFERENCES members(id);
