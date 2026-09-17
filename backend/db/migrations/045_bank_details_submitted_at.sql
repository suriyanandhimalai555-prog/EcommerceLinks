-- Record when a member last submitted their own bank details.
-- Nullable with no default — existing rows stay NULL (no historical data to backfill).
-- Set to now() by PUT /me/bank on every member submission (not by management corrections).
ALTER TABLE members
  ADD COLUMN IF NOT EXISTS bank_details_submitted_at TIMESTAMPTZ;
