CREATE TABLE rank_achievements (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  member_id           BIGINT NOT NULL REFERENCES members(id),
  rank_level          SMALLINT NOT NULL CHECK (rank_level BETWEEN 1 AND 12),
  achieved_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  verification_status TEXT NOT NULL DEFAULT 'pending'
                        CHECK (verification_status IN ('pending','approved','rejected')),
  fulfilled_at        TIMESTAMPTZ,
  fulfillment_notes   TEXT,
  UNIQUE (member_id, rank_level)
);
CREATE INDEX idx_rank_pending ON rank_achievements (verification_status)
  WHERE verification_status = 'pending';
