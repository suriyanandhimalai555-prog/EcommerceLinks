CREATE TABLE pairs (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  member_id       BIGINT NOT NULL REFERENCES members(id),
  sequence_no     BIGINT NOT NULL,
  left_member_id  BIGINT NOT NULL REFERENCES members(id),
  right_member_id BIGINT NOT NULL REFERENCES members(id),
  bonus_amount    NUMERIC(14,2) NOT NULL DEFAULT 1000.00,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (member_id, sequence_no)
);
CREATE INDEX idx_pairs_member_time ON pairs (member_id, created_at);
