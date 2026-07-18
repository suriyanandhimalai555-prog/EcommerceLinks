-- Welcome email is deferred until the signup flow actually completes:
-- immediately at registration when OTP login is off, or after the first
-- successful OTP verify when it is on. NULL = welcome email not yet sent.
ALTER TABLE members ADD COLUMN welcome_sent_at TIMESTAMPTZ;

-- Existing members already went through the old flow (welcome sent at
-- registration, or the setting was off) — mark them as handled so nobody
-- receives a stale welcome email on their next login.
UPDATE members SET welcome_sent_at = created_at;
