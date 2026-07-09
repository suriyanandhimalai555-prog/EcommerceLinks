-- G-9: refresh token revocation table.
-- Stores every issued refresh token jti so it can be validated on /auth/refresh
-- and revoked on /auth/logout. Rotation on refresh invalidates the prior jti.
CREATE TABLE IF NOT EXISTS refresh_tokens (
  jti         UUID        PRIMARY KEY,
  member_id   BIGINT      NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_member ON refresh_tokens (member_id);
