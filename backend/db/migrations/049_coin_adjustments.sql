-- 049_coin_adjustments.sql
-- Manual AVG-Coin adjustments for management accounts.
--
-- avg_coin_grants (migration 046) is tied to confirmed orders and cannot
-- represent manual corrections (order_id NOT NULL + UNIQUE + coins > 0).
-- Rather than weakening those constraints, manual add/deduct operations are
-- recorded here as a separate signed ledger.
--
-- Member coin total = SUM(avg_coin_grants.coins) + SUM(coin_adjustments.delta)
-- The 0-floor invariant (total may never go negative) is enforced in the
-- service layer under a row lock (adjustMemberCoins in coinService.ts).

CREATE TABLE coin_adjustments (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  member_id  BIGINT NOT NULL REFERENCES members(id),
  delta      INT    NOT NULL CHECK (delta <> 0),  -- positive = add, negative = deduct
  reason     TEXT   NOT NULL,
  actor_id   BIGINT NOT NULL REFERENCES members(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_coin_adjustments_member ON coin_adjustments (member_id);
