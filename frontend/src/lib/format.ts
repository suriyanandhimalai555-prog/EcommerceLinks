/** Render a value once resolved; show '—' while undefined/null (unwired or loading). */
export function orDash<T>(v: T | null | undefined, fmt: (x: T) => string): string {
  return v == null ? '—' : fmt(v)
}

export function formatINR(paise: number): string {
  const rupees = Math.floor(paise / 100)
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(rupees)
}

/**
 * Parse a rupee amount typed by a user ("1234", "1234.5", "1,234.56") into
 * integer paise using string math — never float arithmetic on money.
 */
export function rupeesToPaise(input: string): number {
  const cleaned = input.replace(/[,\s₹]/g, '')
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return Number.NaN
  const [whole, frac = ''] = cleaned.split('.')
  return parseInt(whole, 10) * 100 + parseInt(frac.padEnd(2, '0') || '0', 10)
}

export function formatDate(isoString: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  }).format(new Date(isoString))
}

export function formatDateTime(isoString: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Kolkata',
    hour12: true,
  }).format(new Date(isoString))
}
