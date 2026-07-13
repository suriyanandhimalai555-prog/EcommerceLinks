-- Member codes were generated with the prefix "AGV"; the brand is AVG
-- (Agila Vetri Groups). lib/ids.ts now emits AVG…; rewrite existing codes.
-- member_code has no foreign keys (all relations use ids) — referral links and
-- sponsor lookups resolve the current code at request time.
UPDATE members
SET member_code = 'AVG' || substr(member_code, 4)
WHERE member_code LIKE 'AGV%';
