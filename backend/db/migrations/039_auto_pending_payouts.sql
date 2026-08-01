-- Add 'pending' status for auto-generated weekly payouts and attach a source
-- cutoff so each cutoff-close produces at most one pending row per member.
-- Also creates the withdrawal_payment_proofs table for management to attach
-- a sent-money screenshot to each approved payout.

-- 1. Widen the status CHECK to include 'pending'.
--    We cannot DROP and re-add a named constraint inline in one ALTER, so we
--    drop the old check (unnamed in migration 008) by recreating the column
--    constraint via a new CHECK CONSTRAINT instead.
ALTER TABLE withdrawals
  DROP CONSTRAINT IF EXISTS withdrawals_status_check;

ALTER TABLE withdrawals
  ADD CONSTRAINT withdrawals_status_check
    CHECK (status IN ('pending','requested','approved','rejected','paid'));

-- 2. Source-cutoff linkage — nullable; legacy manual rows have no cutoff.
ALTER TABLE withdrawals
  ADD COLUMN IF NOT EXISTS source_cutoff_id BIGINT REFERENCES cutoffs(id);

-- 3. Partial unique index: exactly one pending row per (member, cutoff).
CREATE UNIQUE INDEX IF NOT EXISTS uq_withdrawal_source_cutoff
  ON withdrawals (member_id, source_cutoff_id)
  WHERE source_cutoff_id IS NOT NULL;

-- 4. Proof table — management uploads a screenshot of the bank transfer.
CREATE TABLE IF NOT EXISTS withdrawal_payment_proofs (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  withdrawal_id BIGINT NOT NULL REFERENCES withdrawals(id) ON DELETE CASCADE,
  s3_key        TEXT   NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
