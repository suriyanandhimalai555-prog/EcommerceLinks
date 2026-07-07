CREATE TABLE payout_batches (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scheduled_for DATE NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'building'
                  CHECK (status IN ('building','sent','reconciled')),
  bank_file_ref TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE payout_items (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id       BIGINT NOT NULL REFERENCES payout_batches(id),
  member_id      BIGINT NOT NULL REFERENCES members(id),
  gross          NUMERIC(14,2) NOT NULL,
  tds            NUMERIC(14,2) NOT NULL,
  net            NUMERIC(14,2) NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','sent','settled','failed')),
  bank_ref       TEXT,
  failure_reason TEXT,
  UNIQUE (batch_id, member_id)
);

CREATE TABLE withdrawals (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  member_id    BIGINT NOT NULL REFERENCES members(id),
  amount       NUMERIC(14,2) NOT NULL CHECK (amount >= 500),
  status       TEXT NOT NULL DEFAULT 'requested'
                 CHECK (status IN ('requested','approved','rejected','paid')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);
