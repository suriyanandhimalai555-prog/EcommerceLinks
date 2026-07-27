-- Extend the dead withdrawals table (migration 008) with the columns needed
-- for the new member-initiated withdrawal flow.

ALTER TABLE withdrawals
  ADD COLUMN tds            NUMERIC(14,2),
  ADD COLUMN net            NUMERIC(14,2),
  ADD COLUMN bank_ref       TEXT,
  ADD COLUMN processed_by   BIGINT REFERENCES members(id),
  ADD COLUMN notes          TEXT;
