-- 038_multi_pair_carry_forward.sql
-- Income model v2: carry-forward pair matching.
--
-- Before this migration, uq_pairs_one_per_member physically prevents any member
-- from earning more than one pair (created in 020 for the "2 Direct" model).
-- Dropping it is the hard blocker; nothing else in the v2 income spec can work
-- while that index exists.
--
-- pairs_matched in member_counters was deprecated and frozen at 0 by migration 020.
-- This migration revives it as the live pair count: pairs_matched = LEAST(left_active, right_active).
-- The CHECK constraint chk_pairs_le_min (pairs_matched <= LEAST(left_active, right_active))
-- already exists and becomes a live money guard again.
--
-- ROLLBACK NOTE: DROP INDEX is not trivially reversible once multi-pair rows exist.
-- Rollback = restore-from-backup. Take a backup before applying to production.

-- Hard blocker: remove the one-pair-per-member cap.
DROP INDEX uq_pairs_one_per_member;

-- Add a covering index for contiguity checks and the T6 backfill lookups.
-- (pairs already has UNIQUE (member_id, sequence_no) from 005, which handles uniqueness;
-- this index covers the member_id-only access pattern for the backfill.)
CREATE INDEX idx_pairs_member_seq ON pairs (member_id, sequence_no);

-- pairs_matched is now the live count of pairs matched at this node.
COMMENT ON COLUMN member_counters.pairs_matched IS
  'Live count of pairs matched at this member node under the carry-forward model. Equal to LEAST(left_active, right_active). Updated by workers/counterPair.ts inside the same transaction as the counter increment.';
