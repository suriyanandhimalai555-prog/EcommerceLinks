-- Promote the root member (the single member with no parent) to admin role.
-- The role column was added in 010_roles.sql with DEFAULT 'member'; this
-- one-time UPDATE makes the seeded root reachable via /admin/* routes.
UPDATE members SET role = 'admin' WHERE parent_id IS NULL;
