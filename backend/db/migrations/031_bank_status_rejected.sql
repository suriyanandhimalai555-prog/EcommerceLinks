-- Expand bank_status to include 'rejected', matching the three-state KYC model.
-- The auto-generated constraint name from migration 001 is members_bank_status_check.
ALTER TABLE members DROP CONSTRAINT IF EXISTS members_bank_status_check;
ALTER TABLE members ADD CONSTRAINT members_bank_status_check
  CHECK (bank_status IN ('pending', 'verified', 'rejected'));
