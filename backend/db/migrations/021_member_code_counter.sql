-- Gapless member code counter. A single-row table whose next_val is
-- incremented inside the same transaction that creates the member.
-- Because it lives inside the txn, a rollback also rolls back the
-- counter increment — no gaps ever appear in member codes.
--
-- The singleton constraint (id = 1) prevents accidental extra rows.

CREATE TABLE member_code_counter (
  id        INT    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  next_val  BIGINT NOT NULL DEFAULT 1
);

-- Seed with the next available number based on existing member codes.
-- Parses "AVG100003" → 3, takes MAX + 1. Falls back to 1 for empty DBs.
INSERT INTO member_code_counter (id, next_val)
SELECT 1, COALESCE(
  MAX(CAST(SUBSTRING(member_code FROM 4) AS BIGINT) - 100000),
  0
) + 1
FROM members
WHERE member_code LIKE 'AVG1%';
