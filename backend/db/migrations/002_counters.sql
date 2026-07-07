CREATE TABLE member_counters (
  member_id        BIGINT PRIMARY KEY REFERENCES members(id),
  left_active      BIGINT NOT NULL DEFAULT 0,
  right_active     BIGINT NOT NULL DEFAULT 0,
  pairs_matched    BIGINT NOT NULL DEFAULT 0,
  left_qualified   BIGINT NOT NULL DEFAULT 0,
  right_qualified  BIGINT NOT NULL DEFAULT 0,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_pairs_le_min CHECK (pairs_matched <= LEAST(left_active, right_active))
) WITH (fillfactor = 70);

CREATE TABLE leg_activations (
  ancestor_id  BIGINT NOT NULL REFERENCES members(id),
  side         CHAR(1) NOT NULL CHECK (side IN ('L','R')),
  seq          BIGINT NOT NULL,
  member_id    BIGINT NOT NULL REFERENCES members(id),
  activated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (ancestor_id, side, seq)
);

CREATE TABLE leg_rank_counters (
  member_id   BIGINT NOT NULL REFERENCES members(id),
  rank_level  SMALLINT NOT NULL CHECK (rank_level BETWEEN 4 AND 11),
  left_count  INT NOT NULL DEFAULT 0,
  right_count INT NOT NULL DEFAULT 0,
  PRIMARY KEY (member_id, rank_level)
);
