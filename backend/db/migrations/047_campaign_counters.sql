-- Phase B: parallel campaign unit-matching tables.
-- Live engine tables (member_counters, leg_activations, pairs, pair_accruals) are
-- completely untouched. This is an isolated, additive campaign layer.
--
-- Extra units per confirmed package tier (lookup, NOT arithmetic):
--   ₹10,000 → 0  (live engine already pays the base 1-unit headcount match)
--   ₹30,000 → 2
--   ₹50,000 → 4
--
-- Campaign pairs are minted by campaignCounter.ts using the same set-to-target
-- algorithm as the live counterPair.ts:
--   campaign_pairs_matched = LEAST(left_extra_units, right_extra_units)
-- The CHECK constraint enforces this invariant at the DB level.

-- Per-ancestor campaign unit counters (mirrors member_counters, not leg_activations —
-- extra units are anonymous; no per-unit identity is needed for pair attribution).
CREATE TABLE campaign_member_counters (
  member_id            BIGINT PRIMARY KEY REFERENCES members(id),
  left_extra_units     BIGINT NOT NULL DEFAULT 0,
  right_extra_units    BIGINT NOT NULL DEFAULT 0,
  campaign_pairs_matched BIGINT NOT NULL DEFAULT 0,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_campaign_pairs_le_min
    CHECK (campaign_pairs_matched <= LEAST(left_extra_units, right_extra_units))
);

-- One row per campaign pair minted for an ancestor node (mirrors live `pairs`).
-- bonus_amount is NUMERIC(14,2) rupees (convention: DB stores rupees, backend uses paise).
CREATE TABLE campaign_pairs (
  id           BIGSERIAL PRIMARY KEY,
  member_id    BIGINT        NOT NULL REFERENCES members(id),
  sequence_no  BIGINT        NOT NULL,
  bonus_amount NUMERIC(14,2) NOT NULL DEFAULT 1000.00,
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT uq_campaign_pairs_member_seq UNIQUE (member_id, sequence_no)
);

-- Pending/released bonus per campaign pair × beneficiary (mirrors live `pair_accruals`).
-- No release_seq column: package_value_paise only ever ratchets UP (GREATEST), so
-- campaign eligibility can never be revoked — no re-release/clawback path needed.
-- amount is NUMERIC(14,2) rupees (same convention as pair_accruals.amount).
CREATE TABLE campaign_pair_accruals (
  campaign_pair_id  BIGINT        NOT NULL REFERENCES campaign_pairs(id),
  beneficiary_id    BIGINT        NOT NULL REFERENCES members(id),
  amount            NUMERIC(14,2) NOT NULL,
  status            TEXT          NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'released')),
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  released_at       TIMESTAMPTZ,
  PRIMARY KEY (campaign_pair_id, beneficiary_id)
);
