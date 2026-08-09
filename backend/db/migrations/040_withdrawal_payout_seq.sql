-- Versions the payout ledger idempotency key so a paid→pending revert can be
-- re-approved without colliding with the prior wdpay txn. Mirrors 032's release_seq.
-- Each approve posts wdpay:<id>:<payout_seq>; each revert posts wdrevert:<id>:<payout_seq>
-- then bumps payout_seq, so the next approve gets a fresh, collision-free key.
ALTER TABLE withdrawals ADD COLUMN payout_seq INT NOT NULL DEFAULT 0;
