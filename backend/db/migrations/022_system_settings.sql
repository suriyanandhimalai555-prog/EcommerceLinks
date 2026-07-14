-- 022: system-wide runtime settings
-- Key/value store for management-controlled feature flags. First flag: kyc_optional
-- (default false = KYC stays mandatory, preserving current behavior).

CREATE TABLE system_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES members(id)
);

-- Seed the KYC-optional flag as OFF (mandatory). Management can flip it at runtime
-- via PATCH /admin/settings without a redeploy.
INSERT INTO system_settings (key, value) VALUES ('kyc_optional', 'false'::jsonb);
