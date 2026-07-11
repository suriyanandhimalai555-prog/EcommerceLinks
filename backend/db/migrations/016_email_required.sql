-- Email becomes the login identifier and is mandatory at registration.
-- Backfill any legacy rows (pre-email dummy data) with a unique placeholder
-- derived from member_code so the NOT NULL constraint applies cleanly.
UPDATE members SET email = lower(member_code) || '@placeholder.local' WHERE email IS NULL;

ALTER TABLE members ALTER COLUMN email SET NOT NULL;
