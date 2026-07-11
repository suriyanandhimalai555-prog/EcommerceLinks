-- Phase 2: Admin management operations
-- (1) Add 'adjustment' to the accounts.kind domain
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_kind_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_kind_check
  CHECK (kind IN ('wallet','deferred_bonus','bonus_expense','payout_clearing','tds_payable','bank','adjustment'));

-- (2) Insert the system adjustment account
INSERT INTO accounts (owner_type, owner_id, kind)
VALUES ('system', NULL, 'adjustment')
ON CONFLICT DO NOTHING;

-- (3) Admin audit log (BR-12)
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id           BIGSERIAL PRIMARY KEY,
  actor_id     BIGINT NOT NULL REFERENCES members(id),
  action       VARCHAR(64) NOT NULL,
  target_type  VARCHAR(32) NOT NULL,
  target_id    BIGINT,
  before_state JSONB,
  after_state  JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_actor    ON admin_audit_log (actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_target   ON admin_audit_log (target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created  ON admin_audit_log (created_at DESC);
