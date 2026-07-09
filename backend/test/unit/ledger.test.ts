import { describe, it, expect } from 'vitest'
import { CFG } from '../../src/config.js'

/**
 * G-15 / T10: cap-boundary arithmetic for creditPairBonus.
 * Mirrors the split logic in workers/ledger.ts without touching the DB.
 */
describe('creditPairBonus cap-boundary arithmetic (G-15)', () => {
  const cap   = BigInt(CFG.CUTOFF_CAP_PAISE)   // 10_000_000 paise = ₹1,00,000
  const bonus = BigInt(CFG.PAIR_BONUS_PAISE)    //    100_000 paise = ₹1,000

  function split(alreadyEarned: bigint): { walletAmt: bigint; defAmt: bigint } {
    const walletAmt =
      bonus < cap - alreadyEarned
        ? bonus
        : cap - alreadyEarned > 0n
          ? cap - alreadyEarned
          : 0n
    const defAmt = bonus - walletAmt
    return { walletAmt, defAmt }
  }

  it('first pair (earned=0): full bonus goes to wallet', () => {
    const { walletAmt, defAmt } = split(0n)
    expect(walletAmt).toBe(100_000n)
    expect(defAmt).toBe(0n)
  })

  it('partial cap remaining (earned=9_950_000): splits correctly', () => {
    // ₹99,500 earned, ₹500 remaining before cap, pair bonus = ₹1,000
    const earned = 9_950_000n
    const { walletAmt, defAmt } = split(earned)
    expect(walletAmt).toBe(50_000n)   // ₹500 to wallet
    expect(defAmt).toBe(50_000n)      // ₹500 to deferred
  })

  it('cap already hit (earned=cap): full bonus deferred', () => {
    const { walletAmt, defAmt } = split(cap)
    expect(walletAmt).toBe(0n)
    expect(defAmt).toBe(bonus)
  })

  it('101 pairs from zero → wallet = cap, deferred = 1 bonus', () => {
    let totalWallet  = 0n
    let totalDeferred = 0n
    let earned = 0n

    for (let i = 0; i < 101; i++) {
      const { walletAmt, defAmt } = split(earned)
      totalWallet  += walletAmt
      totalDeferred += defAmt
      earned += walletAmt
    }

    expect(totalWallet).toBe(cap)             // 10_000_000
    expect(totalDeferred).toBe(bonus)          // 100_000
    expect(earned).toBe(cap)
  })
})
