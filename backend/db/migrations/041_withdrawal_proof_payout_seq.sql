-- Tag each payment proof with the payout attempt (withdrawals.payout_seq) it was
-- uploaded under, so read paths can show only the current attempt's proof after a
-- paid→pending revert + re-approve. Old proofs are retained (no S3 delete), just hidden.
ALTER TABLE withdrawal_payment_proofs ADD COLUMN payout_seq INT NOT NULL DEFAULT 0;
