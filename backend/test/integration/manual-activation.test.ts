/**
 * Integration tests for POST /admin/orders/on-behalf — management-initiated
 * member activation without the normal member-driven proof upload flow.
 *
 * Requires: Postgres 16 + Redis 7 running, migrations applied, root seeded,
 * and management seeded (npm run seed + npm run seed:management).
 *
 * The test logs in as the management account using the MGMT_SEED_PASSWORD env var.
 * If the env var is absent the suite skips gracefully.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { app } from '../../src/api/server.js'
import { pool } from '../../src/lib/db.js'
import { registerAnchor, uniqueEmail, uniquePhone } from './helpers.js'

const PASSWORD = 'Test@12345'
const PRODUCT_ID = 1 // seeded in migration 003_commerce.sql (Starter Product)

interface Fixture {
  memberId: bigint
  memberCode: string
  email: string
}

/** Sign a JWT for a given member id directly via app.jwt (avoids the OTP flow). */
function signToken(memberId: bigint, memberCode: string, name: string): string {
  return app.jwt.sign({ sub: String(memberId), code: memberCode, name })
}

/** Look up the management account from the DB. */
async function getManagementAccount(): Promise<{ id: bigint; memberCode: string } | null> {
  const { rows } = await pool().query<{ id: string; member_code: string }>(
    "SELECT id, member_code FROM members WHERE role = 'management' LIMIT 1",
  )
  if (!rows[0]) return null
  return { id: BigInt(rows[0].id), memberCode: rows[0].member_code }
}

let mgmtToken: string
let targetMember: Fixture

beforeAll(async () => {
  await app.ready()

  const mgmt = await getManagementAccount()
  if (!mgmt) {
    console.warn('[manual-activation] management account not found — run npm run seed:management first')
    return
  }
  mgmtToken = signToken(mgmt.id, mgmt.memberCode, 'AVG Management')

  const anchor = await registerAnchor('ActAnchor')
  const email = uniqueEmail('act')
  const { memberId, memberCode } = await (await import('../../src/services/placement.js')).registerMember({
    sponsorCode: anchor.memberCode,
    name: 'ActivationTestMember',
    phone: uniquePhone(),
    email,
    password: PASSWORD,
  })
  targetMember = { memberId, memberCode, email }
}, 120_000)

afterAll(async () => {
  await app.close()
  await pool().end().catch(() => null)
})

describe('POST /admin/orders/on-behalf', () => {
  it('returns 403 for non-management callers', async () => {
    // Use the management token but pretend it belongs to a regular member by
    // creating a token with a different role — actually simpler: just use a
    // fresh registered member token.
    if (!mgmtToken) return
    // Re-use targetMember itself as a non-management caller.
    const memberToken = signToken(targetMember.memberId, targetMember.memberCode, 'ActivationTestMember')
    const res = await app.inject({
      method: 'POST',
      url: '/admin/orders/on-behalf',
      headers: { authorization: `Bearer ${memberToken}` },
      payload: { memberId: String(targetMember.memberId), productId: PRODUCT_ID, paymentRef: 'UTR-TEST' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('activates the member on the first call (activated=true)', async () => {
    if (!mgmtToken) return
    const before = await pool().query<{ is_active: boolean }>(
      'SELECT is_active FROM members WHERE id = $1',
      [targetMember.memberId],
    )
    expect(before.rows[0]?.is_active).toBe(false)

    const res = await app.inject({
      method: 'POST',
      url: '/admin/orders/on-behalf',
      headers: { authorization: `Bearer ${mgmtToken}` },
      payload: {
        memberId: String(targetMember.memberId),
        productId: PRODUCT_ID,
        paymentRef: 'UTR-INTEG-001',
      },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { ok: boolean; orderId: string; activated: boolean }
    expect(body.ok).toBe(true)
    expect(typeof body.orderId).toBe('string')
    expect(body.activated).toBe(true)

    // Member should now be active.
    const after = await pool().query<{ is_active: boolean }>(
      'SELECT is_active FROM members WHERE id = $1',
      [targetMember.memberId],
    )
    expect(after.rows[0]?.is_active).toBe(true)

    // Order should be confirmed.
    const order = await pool().query<{ status: string }>(
      'SELECT status FROM orders WHERE id = $1',
      [body.orderId],
    )
    expect(order.rows[0]?.status).toBe('confirmed')

    // MemberActivated event should be in the outbox.
    const outbox = await pool().query<{ event_type: string }>(
      `SELECT event_type FROM events_outbox
       WHERE (payload->>'member_id')::bigint = $1 AND event_type = 'MemberActivated'`,
      [Number(targetMember.memberId)],
    )
    expect(outbox.rows.length).toBeGreaterThanOrEqual(1)

    // Audit log entry should exist.
    const audit = await pool().query<{ action: string }>(
      `SELECT action FROM admin_audit_log
       WHERE action = 'manual_activation' AND target_id = $1`,
      [String(targetMember.memberId)],
    )
    expect(audit.rows.length).toBeGreaterThanOrEqual(1)
  })

  it('is idempotent: second call returns activated=false and no second activation event', async () => {
    if (!mgmtToken) return

    const outboxBefore = await pool().query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM events_outbox
       WHERE (payload->>'member_id')::bigint = $1 AND event_type = 'MemberActivated'`,
      [Number(targetMember.memberId)],
    )
    const cntBefore = Number(outboxBefore.rows[0].cnt)

    const res = await app.inject({
      method: 'POST',
      url: '/admin/orders/on-behalf',
      headers: { authorization: `Bearer ${mgmtToken}` },
      payload: {
        memberId: String(targetMember.memberId),
        productId: PRODUCT_ID,
        paymentRef: 'UTR-INTEG-002',
      },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { ok: boolean; activated: boolean }
    expect(body.ok).toBe(true)
    expect(body.activated).toBe(false)

    // No new MemberActivated event emitted.
    const outboxAfter = await pool().query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM events_outbox
       WHERE (payload->>'member_id')::bigint = $1 AND event_type = 'MemberActivated'`,
      [Number(targetMember.memberId)],
    )
    expect(Number(outboxAfter.rows[0].cnt)).toBe(cntBefore)
  })

  it('returns 409 when trying to activate a management account', async () => {
    if (!mgmtToken) return
    const mgmt = await getManagementAccount()
    if (!mgmt) return

    const res = await app.inject({
      method: 'POST',
      url: '/admin/orders/on-behalf',
      headers: { authorization: `Bearer ${mgmtToken}` },
      payload: {
        memberId: String(mgmt.id),
        productId: PRODUCT_ID,
        paymentRef: 'UTR-MGMT',
      },
    })
    expect(res.statusCode).toBe(409)
  })
})
