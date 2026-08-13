-- Migration 042: add a dedicated 'payout' role for withdrawal-marking staff.
--
-- The 'payout' account is an off-tree master account (parent_id IS NULL) that
-- can only mark withdrawals (paid / rejected / revert). It has no earnings and
-- therefore can never approve its own withdrawal — separation of duties is
-- structural.
--
-- Changes:
--   1. Widen chk_member_role to include 'payout'.
--   2. Widen uq_single_root to exclude 'payout' (like 'management') so the
--      payout account's NULL parent_id does not collide with the tree root.

ALTER TABLE members DROP CONSTRAINT chk_member_role;
ALTER TABLE members ADD CONSTRAINT chk_member_role
  CHECK (role IN ('member', 'admin', 'management', 'payout'));

DROP INDEX uq_single_root;
CREATE UNIQUE INDEX uq_single_root ON members ((1))
  WHERE parent_id IS NULL AND role NOT IN ('management', 'payout');
