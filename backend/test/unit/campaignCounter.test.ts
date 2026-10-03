import { describe, it, expect } from 'vitest'
import { campaignExtraUnits } from '../../src/lib/campaign.js'

/**
 * Unit tests for the campaign extra-unit tier lookup and matching math.
 * These cover the core invariants that the campaignCounter worker relies on.
 * No DB connection needed — pure function tests.
 */

describe('campaignExtraUnits — tier lookup (NOT arithmetic)', () => {
  // Paise values for the canonical tiers:
  const P10K = 1_000_000n   // ₹10,000
  const P25K = 2_500_000n   // ₹25,000 (off-tier seed product)
  const P30K = 3_000_000n   // ₹30,000
  const P50K = 5_000_000n   // ₹50,000

  it('₹0 → 0 extra units (no package)', () => {
    expect(campaignExtraUnits(0n)).toBe(0n)
  })

  it('₹10,000 → 0 extra units (base tier; live engine pays the 1 headcount unit)', () => {
    expect(campaignExtraUnits(P10K)).toBe(0n)
  })

  it('₹25,000 → 0 extra units (off-tier seed product must not produce units)', () => {
    // Critical: arithmetic (value/10000 − 1) would yield 1.5 units (floored to 1 in bigint).
    // The explicit tier lookup correctly returns 0 for off-tier packages.
    expect(campaignExtraUnits(P25K)).toBe(0n)
  })

  it('₹30,000 → 2 extra units', () => {
    expect(campaignExtraUnits(P30K)).toBe(2n)
  })

  it('₹50,000 → 4 extra units', () => {
    expect(campaignExtraUnits(P50K)).toBe(4n)
  })

  it('values above ₹50k also return 4 (same highest tier)', () => {
    expect(campaignExtraUnits(6_000_000n)).toBe(4n)
  })
})

describe('campaignExtraUnits — upgrade deltas', () => {
  it('₹10k→₹50k upgrade = delta 4 extra units', () => {
    const delta = campaignExtraUnits(5_000_000n) - campaignExtraUnits(1_000_000n)
    expect(delta).toBe(4n)
  })

  it('₹10k→₹30k upgrade = delta 2 extra units', () => {
    const delta = campaignExtraUnits(3_000_000n) - campaignExtraUnits(1_000_000n)
    expect(delta).toBe(2n)
  })

  it('₹30k→₹50k upgrade = delta 2 extra units', () => {
    const delta = campaignExtraUnits(5_000_000n) - campaignExtraUnits(3_000_000n)
    expect(delta).toBe(2n)
  })

  it('₹10k→₹10k (re-confirm, no tier change) = delta 0', () => {
    const delta = campaignExtraUnits(1_000_000n) - campaignExtraUnits(1_000_000n)
    expect(delta).toBe(0n)
  })
})

describe('campaign pair matching — LEAST(left_extra, right_extra)', () => {
  // Mirrors the set-to-target formula in campaignCounter.ts:
  //   target = leftUnits < rightUnits ? leftUnits : rightUnits
  function campaignTarget(l: bigint, r: bigint): bigint {
    return l < r ? l : r
  }

  it('symmetric: LEAST(4,4)=4 campaign pairs', () => {
    expect(campaignTarget(4n, 4n)).toBe(4n)
  })

  it('symmetric: LEAST(2,2)=2 campaign pairs', () => {
    expect(campaignTarget(2n, 2n)).toBe(2n)
  })

  it('asymmetric: LEFT 4 extra (one ₹50k), RIGHT 0 extra (five ₹10k) → 0 campaign pairs', () => {
    // Signed-off limitation: the live engine pays LEAST(1 head, 5 heads)=1 pair;
    // the campaign engine pays LEAST(4 extra, 0 extra)=0 pairs.
    // Total = 1 pair, not 5. This is the accepted trade-off for keeping the
    // live engine byte-for-byte untouched.
    expect(campaignTarget(4n, 0n)).toBe(0n)
  })

  it('mixed: LEFT two ₹30k (4 extra), RIGHT one ₹50k (4 extra) → 4 campaign pairs', () => {
    expect(campaignTarget(4n, 4n)).toBe(4n)
  })

  it('mixed: LEFT one ₹30k (2 extra), RIGHT one ₹50k (4 extra) → 2 campaign pairs', () => {
    expect(campaignTarget(2n, 4n)).toBe(2n)
  })

  it('set-to-target is idempotent: replaying same units gives the same target', () => {
    // Simulate: event applied → pairs_matched = 2.
    // Same event re-delivered: units identical → target 2 → no new pairs minted.
    let pairsMatched = 0n

    function update(leftUnits: bigint, rightUnits: bigint): bigint {
      const target = campaignTarget(leftUnits, rightUnits)
      pairsMatched = target  // set-to-target, not +=
      return target
    }

    // First delivery: left 0→2, right 0→2
    update(2n, 2n)
    expect(pairsMatched).toBe(2n)

    // Re-delivery: same units applied, same target — idempotent
    update(2n, 2n)
    expect(pairsMatched).toBe(2n)

    // Delta upgrade adds 2 more to left: left 4, right 2 → target 2 (unchanged)
    update(4n, 2n)
    expect(pairsMatched).toBe(2n)

    // Now right also gets 2 more: left 4, right 4 → target 4 → 2 new pairs
    update(4n, 4n)
    expect(pairsMatched).toBe(4n)
  })

  it('set-to-target: new pairs minted = target − prior_matched', () => {
    // Verify the k-loop range: for k in (priorMatched, target]
    const priorMatched = 3n
    const target = 7n
    const newPairs = target - priorMatched  // 4 new pairs (k=4,5,6,7)
    expect(newPairs).toBe(4n)
  })
})
