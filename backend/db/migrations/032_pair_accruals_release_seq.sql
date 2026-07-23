-- Release generations for pair_accruals (qualification-revert support).
-- A clawed-back accrual goes back to 'pending' with release_seq bumped; the
-- ledger idempotency key for a release includes the sequence when > 0
-- (workers/ledger.ts releaseAccrual), so the original pairbonus:{pair}:{ben}
-- txn does not swallow the re-credit when the member re-qualifies.
ALTER TABLE pair_accruals ADD COLUMN release_seq INT NOT NULL DEFAULT 0;
