-- 020: Per-beneficiary pair-bonus accruals for the "2 Direct – Pair Matching" plan.
--
-- New income model: a pair completes at member P when BOTH of P's direct
-- referrals are active. Each completed pair accrues one bonus row for P and
-- one for every ancestor on P's placement_path. Accruals stay 'pending' until
-- the beneficiary is qualified (3-gen gate), then release to the ledger.
--
-- uq_pairs_one_per_member assumes at most one pairs row per member (the
-- 2-referral cap). Legacy min(L,R) multi-pair rows would violate it; there is
-- no production deployment, so dev databases must be reset/reseeded.

CREATE TABLE pair_accruals (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pair_id        BIGINT NOT NULL REFERENCES pairs(id),
  beneficiary_id BIGINT NOT NULL REFERENCES members(id),
  amount         NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','released')),
  accrued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at    TIMESTAMPTZ,
  CONSTRAINT chk_released_at CHECK ((status = 'released') = (released_at IS NOT NULL)),
  UNIQUE (pair_id, beneficiary_id)
);

CREATE INDEX idx_accruals_beneficiary ON pair_accruals (beneficiary_id, status);
CREATE INDEX idx_accruals_released_time ON pair_accruals (beneficiary_id, released_at)
  WHERE status = 'released';

CREATE UNIQUE INDEX uq_pairs_one_per_member ON pairs (member_id);

COMMENT ON COLUMN member_counters.pairs_matched IS
  'DEPRECATED since 020: frozen at 0. Income now flows via pair_accruals. Drop in a later release.';
