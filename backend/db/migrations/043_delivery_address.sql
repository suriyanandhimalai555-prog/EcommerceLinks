-- 043_delivery_address.sql
-- Adds a delivery address to members (set-once default) and a snapshot on
-- each order (copied at confirm time). Fully additive — all columns nullable;
-- "mandatory" is enforced at the application layer, not the DB.

-- Member default address (set once by the member; editable only by management).
ALTER TABLE members
  ADD COLUMN IF NOT EXISTS addr_recipient_name TEXT,
  ADD COLUMN IF NOT EXISTS addr_phone          TEXT,
  ADD COLUMN IF NOT EXISTS addr_line1          TEXT,
  ADD COLUMN IF NOT EXISTS addr_line2          TEXT,
  ADD COLUMN IF NOT EXISTS addr_city           TEXT,
  ADD COLUMN IF NOT EXISTS addr_state          TEXT,
  ADD COLUMN IF NOT EXISTS addr_pincode        TEXT;

-- Per-order shipping snapshot (copied from the member's default at confirm time).
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS ship_recipient_name TEXT,
  ADD COLUMN IF NOT EXISTS ship_phone          TEXT,
  ADD COLUMN IF NOT EXISTS ship_line1          TEXT,
  ADD COLUMN IF NOT EXISTS ship_line2          TEXT,
  ADD COLUMN IF NOT EXISTS ship_city           TEXT,
  ADD COLUMN IF NOT EXISTS ship_state          TEXT,
  ADD COLUMN IF NOT EXISTS ship_pincode        TEXT;

-- Feature flag: when true, orders can be placed without a delivery address.
-- Default false = address is mandatory (mirrors kyc_optional pattern).
INSERT INTO system_settings (key, value)
VALUES ('address_optional', 'false'::jsonb)
ON CONFLICT (key) DO NOTHING;
