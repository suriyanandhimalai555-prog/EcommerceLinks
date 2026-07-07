CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE members (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  member_code      TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  phone            TEXT NOT NULL UNIQUE,
  email            TEXT UNIQUE,
  password_hash    TEXT NOT NULL,
  kyc_status       TEXT NOT NULL DEFAULT 'pending'
                     CHECK (kyc_status IN ('pending','verified','rejected')),
  bank_status      TEXT NOT NULL DEFAULT 'pending'
                     CHECK (bank_status IN ('pending','verified')),
  sponsor_id       BIGINT REFERENCES members(id),
  parent_id        BIGINT REFERENCES members(id),
  position         CHAR(1) CHECK (position IN ('L','R')),
  placement_path   BIGINT[] NOT NULL DEFAULT '{}',
  placement_sides  TEXT[]   NOT NULL DEFAULT '{}',
  is_active        BOOLEAN NOT NULL DEFAULT FALSE,
  activated_at     TIMESTAMPTZ,
  is_qualified     BOOLEAN NOT NULL DEFAULT FALSE,
  qualified_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_placement_slot UNIQUE (parent_id, position),
  CONSTRAINT chk_path_sides_len
    CHECK (cardinality(placement_path) = cardinality(placement_sides)),
  CONSTRAINT chk_root_or_placed CHECK (
    (parent_id IS NULL AND position IS NULL)
    OR (parent_id IS NOT NULL AND position IS NOT NULL))
);

CREATE UNIQUE INDEX uq_single_root ON members ((1)) WHERE parent_id IS NULL;
CREATE INDEX idx_members_sponsor ON members (sponsor_id);
CREATE INDEX idx_members_parent  ON members (parent_id);
CREATE INDEX idx_members_path    ON members USING GIN (placement_path);
CREATE INDEX idx_members_active_sponsor ON members (sponsor_id) WHERE is_active;
