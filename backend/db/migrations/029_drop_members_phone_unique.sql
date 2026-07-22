-- Members may share a mobile number (families/groups register under one phone).
-- Login is email-only (email stays UNIQUE), so phone is not an identity key.
-- Phone stays NOT NULL — DROP CONSTRAINT leaves the NOT NULL attribute intact.
ALTER TABLE members DROP CONSTRAINT IF EXISTS members_phone_key;
