import { describe, it, expect } from 'vitest'
import {
  planWeeklyPayouts,
  type WeeklyEarning,
} from '../../scripts/reconstructWeeklyPayouts.js'

const MIN = 50_000n  // ₹500 in paise (matches CFG.MIN_PAYOUT_PAISE)

describe('planWeeklyPayouts — carry-forward accumulation', () => {
  it('single week above threshold: immediate payout in that cutoff', () => {
    const weeks: WeeklyEarning[] = [
      { cutoffId: 1n, netEarnedPaise: 100_000n }, // ₹1,000
    ]
    const { payouts, finalWithdrawable } = planWeeklyPayouts(weeks, MIN)
    expect(payouts).toHaveLength(1)
    expect(payouts[0].cutoffId).toBe(1n)
    expect(payouts[0].amountPaise).toBe(100_000n)
    expect(finalWithdrawable).toBe(0n)
  })

  it('single week below threshold: no payout, amount carries forward', () => {
    const weeks: WeeklyEarning[] = [
      { cutoffId: 1n, netEarnedPaise: 30_000n }, // ₹300 — below ₹500
    ]
    const { payouts, finalWithdrawable } = planWeeklyPayouts(weeks, MIN)
    expect(payouts).toHaveLength(0)
    expect(finalWithdrawable).toBe(30_000n)
  })

  it('two sub-threshold weeks accumulate and pay out in week 2', () => {
    const weeks: WeeklyEarning[] = [
      { cutoffId: 1n, netEarnedPaise: 30_000n }, // ₹300
      { cutoffId: 2n, netEarnedPaise: 30_000n }, // ₹300 — cumulative ₹600
    ]
    const { payouts, finalWithdrawable } = planWeeklyPayouts(weeks, MIN)
    expect(payouts).toHaveLength(1)
    expect(payouts[0].cutoffId).toBe(2n)          // payout fires in cutoff 2
    expect(payouts[0].amountPaise).toBe(60_000n)  // full accumulated ₹600
    expect(finalWithdrawable).toBe(0n)
  })

  it('three sub-threshold weeks: payout fires when crossing threshold', () => {
    const weeks: WeeklyEarning[] = [
      { cutoffId: 1n, netEarnedPaise: 20_000n }, // ₹200
      { cutoffId: 2n, netEarnedPaise: 20_000n }, // ₹400 — still below
      { cutoffId: 3n, netEarnedPaise: 20_000n }, // ₹600 — crosses ₹500
    ]
    const { payouts, finalWithdrawable } = planWeeklyPayouts(weeks, MIN)
    expect(payouts).toHaveLength(1)
    expect(payouts[0].cutoffId).toBe(3n)
    expect(payouts[0].amountPaise).toBe(60_000n)
    expect(finalWithdrawable).toBe(0n)
  })

  it('after a payout, remaining carry-forward accumulates independently', () => {
    const weeks: WeeklyEarning[] = [
      { cutoffId: 1n, netEarnedPaise: 100_000n }, // ₹1,000 → payout cutoff 1
      { cutoffId: 2n, netEarnedPaise: 20_000n },  // ₹200 — carry-forward
      { cutoffId: 3n, netEarnedPaise: 20_000n },  // ₹400 — still below
      { cutoffId: 4n, netEarnedPaise: 40_000n },  // ₹440... wait no: 20+20+40=80k ≥ 50k → payout cutoff 4? no: 20+40=60k ≥ 50k
    ]
    // cutoff 1: 100k ≥ 50k → payout 100k
    // cutoff 2: 20k < 50k → carry
    // cutoff 3: 20k+20k=40k < 50k → carry
    // cutoff 4: 40k+40k=80k ≥ 50k → payout 80k
    const { payouts, finalWithdrawable } = planWeeklyPayouts(weeks, MIN)
    expect(payouts).toHaveLength(2)
    expect(payouts[0]).toEqual({ cutoffId: 1n, amountPaise: 100_000n })
    expect(payouts[1]).toEqual({ cutoffId: 4n, amountPaise: 80_000n })
    expect(finalWithdrawable).toBe(0n)
  })

  it('initial withdrawable (pre-existing balance) is included in first payout', () => {
    const weeks: WeeklyEarning[] = [
      { cutoffId: 1n, netEarnedPaise: 20_000n }, // ₹200 + ₹400 existing = ₹600
    ]
    const { payouts, finalWithdrawable } = planWeeklyPayouts(weeks, MIN, 40_000n)
    expect(payouts).toHaveLength(1)
    expect(payouts[0].cutoffId).toBe(1n)
    expect(payouts[0].amountPaise).toBe(60_000n) // ₹400 initial + ₹200 earned
    expect(finalWithdrawable).toBe(0n)
  })

  it('initial withdrawable alone above threshold: fires in first week with any earnings', () => {
    // Initial ₹600 already above threshold — but the payout only fires when
    // earnings are added (because the DB sweep triggers per-week; the function
    // models this as: earnings are added, then threshold is checked)
    const weeks: WeeklyEarning[] = [
      { cutoffId: 1n, netEarnedPaise: 0n },        // no new earnings
      { cutoffId: 2n, netEarnedPaise: 10_000n },   // ₹100 → total ₹700 ≥ ₹500
    ]
    const { payouts } = planWeeklyPayouts(weeks, MIN, 60_000n)
    // cutoff 1: 60k+0k=60k ≥ 50k → payout 60k
    // cutoff 2: 10k ≥ 50k? no → carry
    expect(payouts).toHaveLength(1)
    expect(payouts[0].cutoffId).toBe(1n)
    expect(payouts[0].amountPaise).toBe(60_000n)
  })

  it('zero-earnings weeks: no payout, no carry-forward', () => {
    const weeks: WeeklyEarning[] = [
      { cutoffId: 1n, netEarnedPaise: 0n },
      { cutoffId: 2n, netEarnedPaise: 0n },
    ]
    const { payouts, finalWithdrawable } = planWeeklyPayouts(weeks, MIN)
    expect(payouts).toHaveLength(0)
    expect(finalWithdrawable).toBe(0n)
  })

  it('conservation: Σ(payouts) + finalWithdrawable == Σ(netEarned) + initialWithdrawable', () => {
    const initial = 25_000n
    const weeks: WeeklyEarning[] = [
      { cutoffId: 1n, netEarnedPaise: 30_000n },
      { cutoffId: 2n, netEarnedPaise: 100_000n },
      { cutoffId: 3n, netEarnedPaise: 40_000n },
      { cutoffId: 4n, netEarnedPaise: 20_000n },
    ]
    const { payouts, finalWithdrawable } = planWeeklyPayouts(weeks, MIN, initial)

    const totalIn = initial + weeks.reduce((s, w) => s + w.netEarnedPaise, 0n)
    const totalOut = payouts.reduce((s, p) => s + p.amountPaise, 0n) + finalWithdrawable

    expect(totalOut).toBe(totalIn)
  })

  it('capped week (₹1L cap already applied externally): no internal re-capping', () => {
    // netEarnedPaise is already capped before entering this function.
    // Passing exactly CUTOFF_CAP_PAISE should still fire correctly.
    const weeks: WeeklyEarning[] = [
      { cutoffId: 1n, netEarnedPaise: 10_000_000n }, // ₹1,00,000 (the cap)
    ]
    const { payouts } = planWeeklyPayouts(weeks, MIN)
    expect(payouts).toHaveLength(1)
    expect(payouts[0].amountPaise).toBe(10_000_000n)
  })

  it('exactly at threshold: payout fires (>= not >)', () => {
    const weeks: WeeklyEarning[] = [
      { cutoffId: 1n, netEarnedPaise: 50_000n }, // exactly ₹500
    ]
    const { payouts } = planWeeklyPayouts(weeks, MIN)
    expect(payouts).toHaveLength(1)
    expect(payouts[0].amountPaise).toBe(50_000n)
  })

  it('one paise below threshold: no payout', () => {
    const weeks: WeeklyEarning[] = [
      { cutoffId: 1n, netEarnedPaise: 49_999n }, // ₹499.99 — just below
    ]
    const { payouts, finalWithdrawable } = planWeeklyPayouts(weeks, MIN)
    expect(payouts).toHaveLength(0)
    expect(finalWithdrawable).toBe(49_999n)
  })
})
