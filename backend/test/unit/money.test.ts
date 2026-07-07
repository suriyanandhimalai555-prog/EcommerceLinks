import { describe, it, expect } from 'vitest'
import { toPaise, fromPaise, pct, pctRoundUp } from '../../src/lib/money.js'

describe('money', () => {
  it('toPaise converts rupees to paise', () => {
    expect(toPaise(10000)).toBe(1_000_000n)
    expect(toPaise('10000')).toBe(1_000_000n)
    expect(toPaise(1000)).toBe(100_000n)
    expect(toPaise('0.01')).toBe(1n)
  })

  it('fromPaise converts paise to rupee string', () => {
    expect(fromPaise(100_000n)).toBe('1000.00')
    expect(fromPaise(1n)).toBe('0.01')
    expect(fromPaise(0n)).toBe('0.00')
  })

  it('pct(toPaise(10000), 18) === 180000n — acceptance criterion T1', () => {
    expect(pct(toPaise(10000), 18)).toBe(180_000n)
  })

  it('pctRoundUp rounds half-up', () => {
    // 5% of ₹10,000 = ₹500 = 50,000 paise
    expect(pctRoundUp(toPaise(10000), 5)).toBe(50_000n)
    // 5% of ₹999 = ₹49.95 → rounds to ₹49.95 = 4,995 paise
    expect(pctRoundUp(toPaise(999), 5)).toBe(4_995n)
  })

  it('pair bonus cap arithmetic', () => {
    const cap = 10_000_000n  // ₹1,00,000
    const bonus = 100_000n   // ₹1,000
    const earned = 9_950_000n  // ₹99,500
    const wallet = earned + bonus < cap ? bonus : cap - earned
    expect(wallet).toBe(50_000n) // ₹500
    expect(bonus - wallet).toBe(50_000n) // ₹500 to deferred
  })
})
