-- Add server-side notifications seen timestamp to members.
-- Null means the member has never opened the Notifications page.
-- A non-null value means every notification with at <= this timestamp is "read".
ALTER TABLE members ADD COLUMN notifications_seen_at TIMESTAMPTZ;
