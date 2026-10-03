-- 046_campaign_coins.sql
-- AVG Coin Airdrop Campaign (2 Oct – 5 Nov 2026)
--
-- 1. Track each member's current package tier (ratchets up; never decreases).
-- 2. Upgrade orders carry their target tier so confirmOrder can set
--    package_value_paise correctly even when the paid delta < target value.
-- 3. Products can be campaign upgrade variants (active=FALSE, hidden from shop).
-- 4. Coin grant table — one row per confirming order, idempotent via UNIQUE(order_id).

ALTER TABLE members ADD COLUMN package_value_paise BIGINT NOT NULL DEFAULT 0;

ALTER TABLE orders ADD COLUMN upgrade_to_value_paise BIGINT;

ALTER TABLE products ADD COLUMN upgrade_target_paise BIGINT;

-- Two inactive upgrade products so upgrade orders have a valid product_id FK.
-- These are NOT shown in the member shop (active = FALSE).
INSERT INTO products (name, description, base_price, active, upgrade_target_paise)
VALUES
  (
    'Campaign Upgrade — ₹30,000 Package',
    'Additional ₹20,000 payment to upgrade an existing ₹10,000 membership to the ₹30,000 campaign package.',
    20000.00, FALSE, 3000000
  ),
  (
    'Campaign Upgrade — ₹50,000 Package',
    'Additional ₹40,000 payment to upgrade an existing ₹10,000 membership to the ₹50,000 campaign package.',
    40000.00, FALSE, 5000000
  );

-- AVG Coin grants: one per confirming order, idempotent
CREATE TABLE avg_coin_grants (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  member_id           BIGINT NOT NULL REFERENCES members(id),
  order_id            BIGINT NOT NULL REFERENCES orders(id),
  coins               INT    NOT NULL CHECK (coins > 0),
  package_value_paise BIGINT NOT NULL,
  granted_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (order_id)
);

CREATE INDEX idx_avg_coin_grants_member ON avg_coin_grants (member_id);
