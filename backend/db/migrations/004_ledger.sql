CREATE TABLE accounts (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('member','system')),
  owner_id   BIGINT,
  kind       TEXT NOT NULL CHECK (kind IN
    ('wallet','deferred_bonus','bonus_expense','payout_clearing',
     'tds_payable','bank')),
  UNIQUE (owner_type, owner_id, kind)
);
INSERT INTO accounts (owner_type, owner_id, kind) VALUES
  ('system', NULL, 'bonus_expense'),
  ('system', NULL, 'payout_clearing'),
  ('system', NULL, 'tds_payable'),
  ('system', NULL, 'bank');

CREATE TABLE ledger_txns (
  txn_id          UUID PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  reference_type  TEXT NOT NULL,
  reference_id    BIGINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entries (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  txn_id      UUID NOT NULL REFERENCES ledger_txns(txn_id),
  account_id  BIGINT NOT NULL REFERENCES accounts(id),
  direction   CHAR(1) NOT NULL CHECK (direction IN ('D','C')),
  amount      NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ledger_account ON ledger_entries (account_id, created_at);
CREATE INDEX idx_ledger_txn ON ledger_entries (txn_id);

CREATE TABLE wallet_balances (
  account_id BIGINT PRIMARY KEY REFERENCES accounts(id),
  balance    NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
