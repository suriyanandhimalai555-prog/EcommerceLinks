-- 048_campaign_total_units.sql
-- Phase B upgrade: switch campaign pair-matching to true unit-weighted matching.
--
-- §4 of the campaign offer: ₹10k = 1 unit, ₹30k = 3 units, ₹50k = 5 units.
-- A node earns campaign pairs = T − B where:
--   T = LEAST(left_units,   right_units)   — the §4 total-unit match
--   B = LEAST(left_members, right_members) — what the live engine already paid
-- This avoids double-counting the 1-unit base the live engine pays per head.
--
-- The live engine (member_counters, pairs, counterPair.ts) is completely untouched.
-- This migration only extends campaign_member_counters.
--
-- Backfill note: campaign_member_counters is SPARSE — campaignCounter.ts only inserts
-- a row when a ≥₹30k fan-up arrived.  member_counters has a row for every member.
-- The backfill is therefore an upsert driven FROM member_counters so ancestors with
-- no prior campaign activity are not missed (a plain UPDATE would silently skip them,
-- leaving left_members=0/right_members=0 and causing B=0 → over-pay on first event).
--
-- Forward-only: campaign_pairs_matched is not retro-corrected.  Under-matched nodes
-- will top up on their next in-window CampaignUnitsAdded event (GREATEST clamp).

-- Step 1: Add the new columns (DEFAULT 0 so existing rows are immediately valid).
ALTER TABLE campaign_member_counters
  ADD COLUMN left_members  BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN right_members BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN left_units    BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN right_units   BIGINT NOT NULL DEFAULT 0;

-- Step 2: Backfill.  Drive from member_counters; join to existing campaign rows for
-- the already-recorded extra_units.  ON CONFLICT DO UPDATE so existing campaign rows
-- get their members+units columns populated and new rows are inserted for the rest.
-- campaign_pairs_matched is intentionally excluded from the UPDATE clause — we only
-- set it in the INSERT to preserve any already-matched pairs (forward-only).
INSERT INTO campaign_member_counters
  (member_id, left_members, right_members, left_units, right_units, campaign_pairs_matched)
SELECT
  mc.member_id,
  mc.left_active,
  mc.right_active,
  mc.left_active  + COALESCE(cmc.left_extra_units,  0),
  mc.right_active + COALESCE(cmc.right_extra_units, 0),
  COALESCE(cmc.campaign_pairs_matched, 0)
FROM member_counters mc
LEFT JOIN campaign_member_counters cmc USING (member_id)
ON CONFLICT (member_id) DO UPDATE SET
  left_members  = EXCLUDED.left_members,
  right_members = EXCLUDED.right_members,
  left_units    = EXCLUDED.left_units,
  right_units   = EXCLUDED.right_units;
-- campaign_pairs_matched intentionally NOT updated here — forward-only correction.

-- Step 3: Replace the old CHECK constraint (which only knew about extra units) with one
-- that reflects the new total-unit semantics.  This is a re-definition, not a weakening:
-- it still bounds campaign_pairs_matched by the actual match (LEAST(left_units, right_units) >=
-- LEAST(left_extra_units, right_extra_units) >= old campaign_pairs_matched), so no existing
-- row violates the new constraint.
ALTER TABLE campaign_member_counters
  DROP CONSTRAINT chk_campaign_pairs_le_min,
  ADD CONSTRAINT chk_campaign_pairs_le_units
    CHECK (campaign_pairs_matched >= 0
       AND campaign_pairs_matched <= LEAST(left_units, right_units));
