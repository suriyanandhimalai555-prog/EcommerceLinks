import Big from 'big.js'

// All arithmetic operates on integer paise (bigint). Never use Number for money.

export function toPaise(rupees: string | number): bigint {
  return BigInt(new Big(rupees).times(100).toFixed(0))
}

export function fromPaise(p: bigint): string {
  return (Number(p) / 100).toFixed(2)
}

// Floor division — no rounding up on the payer's side.
export function pct(p: bigint, percent: number): bigint {
  return (p * BigInt(percent)) / 100n
}

// Round half-up to nearest paise — used for TDS deduction.
export function pctRoundUp(p: bigint, percent: number): bigint {
  return BigInt(new Big(fromPaise(p)).times(percent).div(100).round(2, Big.roundHalfUp).times(100).toFixed(0))
}
