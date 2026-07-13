-- Management role: dedicated off-tree staff accounts that hold master control,
-- separated from the tree-root business account (which is demoted to 'member'
-- by scripts/seedManagement.ts once a management account exists).

-- Extend the role enum. 010_roles.sql declared the check inline on the column,
-- so it carries the auto-generated name members_role_check.
ALTER TABLE members DROP CONSTRAINT IF EXISTS members_role_check;
ALTER TABLE members ADD CONSTRAINT chk_member_role
  CHECK (role IN ('member','admin','management'));

-- Rescope (NOT weaken) the single-root invariant: there is still exactly ONE
-- binary-tree root. Management accounts also sit at parent_id NULL but are
-- off-tree (empty placement_path, never a placement target) and are excluded.
-- The index still rejects a management row being demoted to 'member'.
DROP INDEX uq_single_root;
CREATE UNIQUE INDEX uq_single_root ON members ((1))
  WHERE parent_id IS NULL AND role <> 'management';

-- Admin suspend switch. Deliberately NOT is_active: is_active drives
-- counters/qualification through the event pipeline; blocked only gates login.
ALTER TABLE members ADD COLUMN blocked BOOLEAN NOT NULL DEFAULT FALSE;
