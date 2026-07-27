-- Add 'withdrawable' as a valid account kind and create one per existing member.
-- Never edit 004_ledger.sql — extend the CHECK in a new migration.

ALTER TABLE accounts
  DROP CONSTRAINT IF EXISTS accounts_kind_check;

ALTER TABLE accounts
  ADD CONSTRAINT accounts_kind_check
    CHECK (kind IN ('wallet','deferred_bonus','bonus_expense','payout_clearing','tds_payable','bank','adjustment','withdrawable'));

-- Backfill: one withdrawable account + zero wallet_balances row per existing member.
-- Uses a CTE so we can INSERT into two tables atomically.
WITH inserted AS (
  INSERT INTO accounts (owner_type, owner_id, kind)
  SELECT 'member', m.id, 'withdrawable'
  FROM members m
  WHERE NOT EXISTS (
    SELECT 1 FROM accounts a
    WHERE a.owner_id = m.id AND a.kind = 'withdrawable'
  )
  RETURNING id
)
INSERT INTO wallet_balances (account_id, balance)
SELECT id, 0 FROM inserted;
