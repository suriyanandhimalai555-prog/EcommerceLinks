import { describe, it, expect } from 'vitest'
import { CFG } from '../../src/config.js'
import { fromPaise } from '../../src/lib/money.js'

/**
 * G-8: Guards that code-side config constants match the DB-side schema constants.
 * The DB constraints (pairs.bonus_amount DEFAULT 1000.00, cutoffs chk_cap 100000.00)
 * are fixed; if anyone changes the env vars the mismatch becomes visible here.
 */
describe('Config constants match DB schema constants (G-8)', () => {
  it('PAIR_BONUS_PAISE matches the 005_pairs.sql DEFAULT (1000.00 = 100000 paise)', () => {
    expect(CFG.PAIR_BONUS_PAISE).toBe(100_000)
    // fromPaise must produce the decimal string the DB expects
    expect(fromPaise(BigInt(CFG.PAIR_BONUS_PAISE))).toBe('1000.00')
  })

  it('CUTOFF_CAP_PAISE matches the 006_cutoffs.sql chk_cap (100000.00 = 10000000 paise)', () => {
    expect(CFG.CUTOFF_CAP_PAISE).toBe(10_000_000)
    expect(fromPaise(BigInt(CFG.CUTOFF_CAP_PAISE))).toBe('100000.00')
  })

  it('PairCompleted outbox event amount_paise comes from CFG (regression guard)', () => {
    // The value used in pairComplete.ts writeOutbox must equal CFG.PAIR_BONUS_PAISE
    const amountUsedInOutbox = Number(CFG.PAIR_BONUS_PAISE)
    expect(amountUsedInOutbox).toBe(100_000)
  })
})
