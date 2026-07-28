-- Weekly-cap overage is now FORFEITED, not deferred. The part of a bonus that
-- exceeds a member's ₹1 lakh per-cutoff cap no longer credits their
-- deferred_bonus account (to be swept into a later week); instead it is credited
-- to a single system 'bonus_forfeited' account so the money never reaches the
-- member but stays auditable. See workers/ledger.ts (creditBonusWithCap).
--
-- Never edit 004_ledger.sql — extend the CHECK in a new migration (cf. 034).
-- The legacy deferred_bonus path (sweepDeferred / DeferredSweepRequested) is left
-- intact so any pre-existing deferred balances still drain out; no new deferred
-- credits are created, so it self-deactivates.

ALTER TABLE accounts
  DROP CONSTRAINT IF EXISTS accounts_kind_check;

ALTER TABLE accounts
  ADD CONSTRAINT accounts_kind_check
    CHECK (kind IN ('wallet','deferred_bonus','bonus_expense','payout_clearing',
                    'tds_payable','bank','adjustment','withdrawable','bonus_forfeited'));

-- One singleton system account that accumulates all forfeited overage.
INSERT INTO accounts (owner_type, owner_id, kind)
SELECT 'system', NULL, 'bonus_forfeited'
WHERE NOT EXISTS (
  SELECT 1 FROM accounts WHERE owner_type='system' AND kind='bonus_forfeited'
);
