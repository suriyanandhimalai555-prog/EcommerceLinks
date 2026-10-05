import { describe, it, expect } from 'vitest'
import { campaignExtraUnits, unitsForPackageValuePaise } from '../../src/lib/campaign.js'

/**
 * Unit tests for campaign tier lookups and the total-unit pair-matching formula.
 * No DB connection needed — pure function tests.
 *
 * The six mandatory test cases for the total-unit (Phase B) formula:
 *   1. Symmetric ₹50k vs ₹50k → 5 pairs total
 *   2. Asymmetric 1×₹50k vs 5×₹10k → 5 pairs total  (the deciding scenario)
 *   3. ₹10k-only legs → campaign adds 0 (live base covers it)
 *   4. Shrink scenario → campaign_pairs_matched never decreases (GREATEST clamp)
 *   5. Idempotency: replaying same delta converges to same target, no double-mint
 *   6. Backfill landmine: left_members=0 causes over-pay vs correct backfill
 */

// ─── campaignExtraUnits (unchanged; kept for regression coverage) ─────────────

describe('campaignExtraUnits — tier lookup (NOT arithmetic)', () => {
  const P10K = 1_000_000n
  const P25K = 2_500_000n  // off-tier seed product
  const P30K = 3_000_000n
  const P50K = 5_000_000n

  it('₹0 → 0 extra units', () => expect(campaignExtraUnits(0n)).toBe(0n))

  it('₹10,000 → 0 extra units (base tier; live engine pays the 1 headcount unit)', () => {
    expect(campaignExtraUnits(P10K)).toBe(0n)
  })

  it('₹25,000 → 0 extra units (off-tier seed product must not produce units)', () => {
    // arithmetic (value/10000 − 1) would yield 1.5 → 1 in bigint; explicit lookup → 0
    expect(campaignExtraUnits(P25K)).toBe(0n)
  })

  it('₹30,000 → 2 extra units', () => expect(campaignExtraUnits(P30K)).toBe(2n))
  it('₹50,000 → 4 extra units', () => expect(campaignExtraUnits(P50K)).toBe(4n))

  it('values above ₹50k → 4 (same highest tier)', () => {
    expect(campaignExtraUnits(6_000_000n)).toBe(4n)
  })
})

describe('campaignExtraUnits — upgrade deltas', () => {
  it('₹10k→₹50k = delta 4 extra units', () => {
    expect(campaignExtraUnits(5_000_000n) - campaignExtraUnits(1_000_000n)).toBe(4n)
  })
  it('₹10k→₹30k = delta 2 extra units', () => {
    expect(campaignExtraUnits(3_000_000n) - campaignExtraUnits(1_000_000n)).toBe(2n)
  })
  it('₹30k→₹50k = delta 2 extra units', () => {
    expect(campaignExtraUnits(5_000_000n) - campaignExtraUnits(3_000_000n)).toBe(2n)
  })
  it('₹10k→₹10k (re-confirm, no tier change) = delta 0', () => {
    expect(campaignExtraUnits(1_000_000n) - campaignExtraUnits(1_000_000n)).toBe(0n)
  })
})

// ─── unitsForPackageValuePaise (new — total units including base) ─────────────

describe('unitsForPackageValuePaise — total tier units (including base)', () => {
  const P0   = 0n
  const P10K = 1_000_000n
  const P25K = 2_500_000n  // off-tier seed product
  const P30K = 3_000_000n
  const P50K = 5_000_000n

  it('₹0 (inactive) → 0 units', () => expect(unitsForPackageValuePaise(P0)).toBe(0n))

  it('₹10,000 → 1 unit (base tier)', () => {
    expect(unitsForPackageValuePaise(P10K)).toBe(1n)
  })

  it('₹25,000 (off-tier seed) → 0 units (explicit lookup, NOT arithmetic)', () => {
    // arithmetic (value/10000) would yield 2.5 → 2; explicit lookup → 0
    expect(unitsForPackageValuePaise(P25K)).toBe(0n)
  })

  it('₹30,000 → 3 units', () => expect(unitsForPackageValuePaise(P30K)).toBe(3n))
  it('₹50,000 → 5 units', () => expect(unitsForPackageValuePaise(P50K)).toBe(5n))

  it('values above ₹50k → 5 (same highest tier)', () => {
    expect(unitsForPackageValuePaise(6_000_000n)).toBe(5n)
  })
})

// ─── Total-unit pair-matching formula: T−B (the six mandatory cases) ─────────

/**
 * Mirrors the formula in campaignCounter.ts applyCampaignUnits:
 *   T = LEAST(leftUnits, rightUnits)
 *   B = LEAST(leftMembers, rightMembers)
 *   surplus = max(T − B, 0)
 *   target  = GREATEST(priorMatched, surplus)   ← monotonic clamp
 *
 * Live pairs = B.  Campaign pairs = target.  Total = B + target.
 */
function computeTarget(
  leftUnits:   bigint, rightUnits:   bigint,
  leftMembers: bigint, rightMembers: bigint,
  priorMatched = 0n,
): bigint {
  const T = leftUnits   < rightUnits   ? leftUnits   : rightUnits
  const B = leftMembers < rightMembers ? leftMembers : rightMembers
  const surplus = T > B ? T - B : 0n
  return surplus > priorMatched ? surplus : priorMatched
}

describe('campaign pair matching — total-unit formula T−B (mandatory test cases)', () => {

  // ── Test 1: Symmetric ₹50k vs ₹50k ────────────────────────────────────────
  it('1. Symmetric ₹50k vs ₹50k → 4 campaign pairs, 5 total', () => {
    // Left: 1×₹50k  → units=5, members=1
    // Right: 1×₹50k → units=5, members=1
    // T=5, B=1, campaign=4  →  total = live(B=1) + campaign(4) = 5 ✓
    const campaign = computeTarget(5n, 5n, 1n, 1n)
    expect(campaign).toBe(4n)
    expect(1n + campaign).toBe(5n)  // live base B=1 + campaign top-up = 5
  })

  // ── Test 2: Asymmetric 1×₹50k vs 5×₹10k (the deciding scenario) ──────────
  it('2. Asymmetric 1×₹50k left vs 5×₹10k right → 4 campaign pairs, 5 total', () => {
    // Left: 1×₹50k  → units=5, members=1
    // Right: 5×₹10k → units=5, members=5
    // T=LEAST(5,5)=5, B=LEAST(1,5)=1, campaign=4  →  total = 1 + 4 = 5 ✓
    const campaign = computeTarget(5n, 5n, 1n, 5n)
    expect(campaign).toBe(4n)
    expect(1n + campaign).toBe(5n)
  })

  // ── Test 3: ₹10k-only legs — campaign adds 0 ──────────────────────────────
  it('3. ₹10k-only legs → 0 campaign pairs (live base covers everything)', () => {
    // Left: 3×₹10k → units=3, members=3
    // Right: 3×₹10k → units=3, members=3
    // T=3, B=3, surplus=0 → campaign=0  →  total = 3 + 0 = 3 ✓
    const campaign = computeTarget(3n, 3n, 3n, 3n)
    expect(campaign).toBe(0n)
  })

  // ── Test 4: Shrink scenario — GREATEST clamp prevents clawback ────────────
  it('4. Shrink scenario — campaign_pairs_matched never decreases', () => {
    // Initial: left 2×₹50k (units=10, members=2), right 5×₹10k (units=5, members=5)
    // T=LEAST(10,5)=5, B=LEAST(2,5)=2, surplus=3 → priorMatched=3
    const prior = computeTarget(10n, 5n, 2n, 5n)
    expect(prior).toBe(3n)

    // Right gains one more ₹10k (units=6, members=6):
    // T=LEAST(10,6)=6, B=LEAST(2,6)=2, surplus=4 → GREATEST(3,4)=4
    const afterRightGrow = computeTarget(10n, 6n, 2n, 6n, prior)
    expect(afterRightGrow).toBe(4n)

    // Left gains one ₹10k (units=11, members=3):
    // T=LEAST(11,6)=6, B=LEAST(3,6)=3, surplus=3 → GREATEST(4,3)=4 (NO clawback)
    const afterLeftGrow = computeTarget(11n, 6n, 3n, 6n, afterRightGrow)
    expect(afterLeftGrow).toBe(4n)  // clamped; did NOT decrease to 3
  })

  // ── Test 5: Idempotency — re-delivering the same event is a no-op ─────────
  it('5. Idempotency — replaying same CampaignUnitsAdded gives same target, no new pairs', () => {
    // First delivery: left 1×₹50k, right 1×₹50k
    const first = computeTarget(5n, 5n, 1n, 1n)
    expect(first).toBe(4n)

    // Re-delivery: same unit/member counts, priorMatched=4 → GREATEST(4,4)=4 → no new pairs
    const redelivery = computeTarget(5n, 5n, 1n, 1n, first)
    expect(redelivery).toBe(4n)  // unchanged → 0 new pairs minted ✓

    // Subsequent new upgrade on right (₹10k→₹30k: +2 units):
    const afterUpgrade = computeTarget(5n, 7n, 1n, 1n, redelivery)
    // T=LEAST(5,7)=5, B=1, surplus=4 → GREATEST(4,4)=4 → still no new pairs
    expect(afterUpgrade).toBe(4n)

    // Right gets second member at ₹10k: units=8, members=2
    const afterSecondMember = computeTarget(5n, 8n, 1n, 2n, afterUpgrade)
    // T=LEAST(5,8)=5, B=LEAST(1,2)=1, surplus=4 → 4 (still same)
    expect(afterSecondMember).toBe(4n)
  })

  // ── Test 6: Backfill landmine — members=0 causes over-pay ─────────────────
  it('6. Backfill landmine: left_members=0 causes over-pay vs correct backfill', () => {
    // Scenario: a node has 5 live left-leg members and 3 live right-leg members
    // (all at ₹10k = 1 unit each).  The live engine already pays B=LEAST(5,3)=3.
    //
    // Correct backfill (migration 048): left_members=5, right_members=3,
    //   left_units=5, right_units=3.
    // A ₹50k upgrade arrives on the left (unit_delta=4, member_delta=0):
    //   left_units → 5+4 = 9, right_units stays 3
    //   T=LEAST(9,3)=3, B=LEAST(5,3)=3, surplus=0 → campaign=0 ✓
    const correctResult = computeTarget(9n, 3n, 5n, 3n)
    expect(correctResult).toBe(0n)  // no campaign pairs; live already pays 3 ✓

    // WRONG backfill (plain UPDATE skipped this sparse row → members=0):
    //   left_members=0, right_members=0  — as if no one was in the tree before
    // Same upgrade arrives: left_units=0+4=4? No — the units were also not backfilled.
    // More dangerous partial case: right_members correctly backfilled (if right had prior
    // campaign row), left_members=0 (left had no prior campaign row, plain UPDATE skipped).
    // Even simpler: both=0 but units were backfilled somehow (illustrates the hazard):
    const wrongResult = computeTarget(9n, 3n, 0n, 3n)
    // T=LEAST(9,3)=3, B=LEAST(0,3)=0, surplus=3 → over-pays 3 pairs the live engine paid!
    expect(wrongResult).toBe(3n)

    // The 3 phantom pairs = ₹3,000 over-paid (the live engine already paid these 3).
    expect(wrongResult - correctResult).toBe(3n)
  })
})

// ─── createUpgradeOrder — dynamic delta pricing (unchanged) ──────────────────

describe('createUpgradeOrder — dynamic delta pricing', () => {
  function computeDelta(targetPaise: bigint, currentPaise: bigint): bigint {
    return targetPaise > currentPaise ? targetPaise - currentPaise : 0n
  }

  it('₹10k → ₹30k: delta = ₹20,000 (2,000,000 paise)', () => {
    expect(computeDelta(3_000_000n, 1_000_000n)).toBe(2_000_000n)
  })
  it('₹10k → ₹50k: delta = ₹40,000 (4,000,000 paise)', () => {
    expect(computeDelta(5_000_000n, 1_000_000n)).toBe(4_000_000n)
  })
  it('₹30k → ₹50k: delta = ₹20,000 (2,000,000 paise)', () => {
    // Key: must NOT record ₹40k here (the old fixed base_price bug).
    expect(computeDelta(5_000_000n, 3_000_000n)).toBe(2_000_000n)
  })
  it('same-tier target clamps to 0', () => {
    expect(computeDelta(3_000_000n, 3_000_000n)).toBe(0n)
    expect(computeDelta(1_000_000n, 3_000_000n)).toBe(0n)
  })
})
