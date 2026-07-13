/**
 * Shared helpers for integration tests.
 *
 * With the 2-referral cap every member has at most two binary slots, so tests
 * can no longer register everything under root. Each test registers its own
 * fresh "anchor" member (guaranteed 0 children) and hangs its fixtures there:
 * the first registration under an anchor is deterministically L, the second R.
 *
 * Test files run in parallel forks against one shared DB, so anchor creation
 * tolerates slot races: on "Referral limit reached" it tries the next open
 * sponsor.
 */
import { randomInt } from 'node:crypto'
import { pool } from '../../src/lib/db.js'
import { registerMember } from '../../src/services/placement.js'

/** 10-digit phone unique across parallel test files. */
export function uniquePhone(prefix = '6') {
  return `${prefix}${Date.now().toString().slice(-6)}${String(randomInt(1000)).padStart(3, '0')}`
}

/** Email unique across parallel test files (login identifier). */
export function uniqueEmail(prefix = 'test') {
  return `${prefix}-${Date.now().toString().slice(-7)}-${randomInt(100000)}@test.avg`
}

/** Member codes that still have a free binary slot, shallowest first. */
export async function findOpenSponsors(limit = 20): Promise<string[]> {
  const { rows } = await pool().query<{ member_code: string }>(
    `SELECT m.member_code
     FROM members m
     LEFT JOIN members c ON c.parent_id = m.id
     WHERE m.role <> 'management'
     GROUP BY m.id, m.member_code
     HAVING COUNT(c.id) < 2
     ORDER BY m.id
     LIMIT $1`,
    [limit],
  )
  return rows.map((r) => r.member_code)
}

/**
 * Register a fresh anchor member (0 children) somewhere in the tree.
 * Retries the next open sponsor when a parallel test grabs the slot first.
 */
export async function registerAnchor(
  name: string,
): Promise<{ memberId: bigint; memberCode: string }> {
  for (const sponsorCode of await findOpenSponsors()) {
    try {
      return await registerMember({
        sponsorCode,
        name,
        phone: uniquePhone(),
        email: uniqueEmail('anchor'),
        password: 'Test@12345',
      })
    } catch (err) {
      const e = err as { statusCode?: number; message?: string }
      if (
        e.statusCode === 409 &&
        /referral limit|cannot be used as a sponsor/i.test(e.message ?? '')
      ) continue
      throw err
    }
  }
  throw new Error('registerAnchor: no open sponsor slot found')
}
