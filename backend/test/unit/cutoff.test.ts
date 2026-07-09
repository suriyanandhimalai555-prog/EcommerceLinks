import { describe, it, expect } from 'vitest'
import { DateTime } from 'luxon'
import { nextWindowStart, windowEnd } from '../../src/workers/cutoff.js'

const TZ = 'Asia/Kolkata'

describe('cutoff window math (G-6)', () => {
  it('8 consecutive windows are each exactly 7 days long and start/end on Saturday 18:00/17:59:59', () => {
    // Sat 6 Jan 2024 18:00:00 IST — a known Saturday
    // Cast to ReturnType<typeof windowEnd> to satisfy luxon's generic variance
    let start = DateTime.fromISO('2024-01-06T18:00:00', { zone: TZ }) as ReturnType<typeof windowEnd>

    for (let i = 0; i < 8; i++) {
      const end = windowEnd(start)

      // Duration: exactly 7 days minus 1 second
      expect(end.diff(start, 'seconds').seconds).toBe(7 * 24 * 60 * 60 - 1)

      // Start: Saturday 18:00:00
      expect(start.weekday).toBe(6)
      expect(start.hour).toBe(18)
      expect(start.minute).toBe(0)
      expect(start.second).toBe(0)
      expect(start.millisecond).toBe(0)

      // End: Saturday 17:59:59
      expect(end.weekday).toBe(6)
      expect(end.hour).toBe(17)
      expect(end.minute).toBe(59)
      expect(end.second).toBe(59)

      start = nextWindowStart(end)
    }
  })

  it('nextWindowStart(windowEnd(t)) === t + 7 days (no drift)', () => {
    const start = DateTime.fromISO('2024-03-02T18:00:00', { zone: TZ }) as ReturnType<typeof windowEnd>
    const roundTrip = nextWindowStart(windowEnd(start))
    expect(roundTrip.toISO()).toBe(start.plus({ days: 7 }).toISO())
  })
})
