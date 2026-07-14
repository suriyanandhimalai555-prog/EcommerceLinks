-- Persist KYC and bank detail fields entered by members.
-- Previously PUT /me/kyc and PUT /me/bank only flipped a status flag;
-- the entered values were never stored. These nullable columns allow
-- pre-filling the profile forms on return.
ALTER TABLE members
  ADD COLUMN IF NOT EXISTS pan                 TEXT,
  ADD COLUMN IF NOT EXISTS aadhaar_last4       TEXT,
  ADD COLUMN IF NOT EXISTS bank_account_name   TEXT,
  ADD COLUMN IF NOT EXISTS bank_account_number TEXT,
  ADD COLUMN IF NOT EXISTS bank_ifsc           TEXT;
