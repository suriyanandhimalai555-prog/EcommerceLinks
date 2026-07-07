CREATE TABLE cutoffs (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  window_start TIMESTAMPTZ NOT NULL,
  window_end   TIMESTAMPTZ NOT NULL,
  payout_date  DATE NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open','closed','paid')),
  UNIQUE (window_start)
);
CREATE UNIQUE INDEX uq_one_open_cutoff ON cutoffs ((1)) WHERE status = 'open';

CREATE TABLE cutoff_earnings (
  member_id BIGINT NOT NULL REFERENCES members(id),
  cutoff_id BIGINT NOT NULL REFERENCES cutoffs(id),
  earned    NUMERIC(14,2) NOT NULL DEFAULT 0,
  deferred  NUMERIC(14,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (member_id, cutoff_id),
  CONSTRAINT chk_cap CHECK (earned <= 100000.00)
);
