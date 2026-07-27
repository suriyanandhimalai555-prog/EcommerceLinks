-- Add register_otp_enabled feature flag.
-- When true, POST /auth/register sends a 6-digit OTP to the provided email
-- and the account is only created after the code is verified via
-- POST /auth/register/verify-otp. Defaults false so existing scripts and
-- integration tests continue working unchanged.
INSERT INTO system_settings (key, value)
VALUES ('register_otp_enabled', 'false'::jsonb)
ON CONFLICT DO NOTHING;
