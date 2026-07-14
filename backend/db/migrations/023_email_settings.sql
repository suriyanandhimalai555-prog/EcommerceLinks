-- Migration 023: email feature flag defaults
-- Seeds two opt-in toggles into system_settings.
-- Both default to false (off) — management must explicitly enable.

INSERT INTO system_settings (key, value)
VALUES ('welcome_email_enabled', 'false'::jsonb);

INSERT INTO system_settings (key, value)
VALUES ('login_otp_enabled', 'false'::jsonb);
