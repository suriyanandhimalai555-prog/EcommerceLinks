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
