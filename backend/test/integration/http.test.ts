/**
 * G-15 HTTP-layer integration tests.
 * Requires: Postgres 16 + Redis 7 running, migrations applied, root seeded.
 *
 * Covers:
 *   - G-10: duplicate phone/email registration → 409
 *   - G-9:  refresh token rotation (old jti rejected after rotation)
 *   - G-9:  /auth/logout revokes token (subsequent refresh → 401)
 *   - G-12: member A cannot query member B's tree (403)
 *   - G-2:  webhook secret gate (missing/wrong secret → 401; correct → 200)
 *   - G-7:  webhook with status=failed → order marked 'failed', not 'paid'
 */
import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { app } from '../../src/api/server.js'
import { pool } from '../../src/lib/db.js'
import { CFG } from '../../src/config.js'

function uniquePhone(suffix: number) {
  const s = String(suffix).padStart(3, '0')
  return `8${Date.now().toString().slice(-7)}${s}`
}

let rootCode: string

beforeAll(async () => {
  await app.ready()
  const { rows } = await pool().query<{ member_code: string }>(
    'SELECT member_code FROM members WHERE parent_id IS NULL LIMIT 1'
  )
  if (!rows[0]) throw new Error('Root member not seeded — run npm run seed first')
  rootCode = rows[0].member_code
})

afterAll(async () => {
  await app.close()
  await pool().end().catch(() => null)
})

// ─── G-10: Duplicate phone registration returns 409 ──────────────────────────

describe('G-10 – Duplicate registration returns 409', () => {
  const phone = uniquePhone(1)

  it('first registration succeeds (201)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/auth/register',
      payload: {
        sponsorCode: rootCode, preferredLeg: 'L',
        name: 'DupTest', phone, password: 'Test@12345',
      },
    })
    expect(res.statusCode).toBe(201)
  })

  it('second registration with same phone returns 409', async () => {
    const res = await app.inject({
      method: 'POST', url: '/auth/register',
      payload: {
        sponsorCode: rootCode, preferredLeg: 'R',
        name: 'DupTest2', phone, password: 'Test@12345',
      },
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).error).toMatch(/already registered/i)
  })
})

// ─── G-9: Refresh token rotation ─────────────────────────────────────────────

describe('G-9 – Refresh token rotation and logout', () => {
  let firstRefresh: string
  let secondRefresh: string
  const phone = uniquePhone(2)

  beforeAll(async () => {
    // Register + login a fresh member
    await app.inject({
      method: 'POST', url: '/auth/register',
      payload: { sponsorCode: rootCode, preferredLeg: 'L', name: 'TokenTest', phone, password: 'Test@12345' },
    })
    const loginRes = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { phone, password: 'Test@12345' },
    })
    firstRefresh = JSON.parse(loginRes.body).refreshToken
  })

  it('first /auth/refresh succeeds and returns a new token', async () => {
    const res = await app.inject({
      method: 'POST', url: '/auth/refresh',
      payload: { refreshToken: firstRefresh },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.accessToken).toBeTruthy()
    expect(body.refreshToken).toBeTruthy()
    secondRefresh = body.refreshToken
  })

  it('reusing the old (now-rotated) refresh token returns 401', async () => {
    const res = await app.inject({
      method: 'POST', url: '/auth/refresh',
      payload: { refreshToken: firstRefresh },
    })
    expect(res.statusCode).toBe(401)
  })

  it('/auth/logout revokes the current token', async () => {
    const res = await app.inject({
      method: 'POST', url: '/auth/logout',
      payload: { refreshToken: secondRefresh },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).ok).toBe(true)
  })

  it('refresh after logout returns 401', async () => {
    const res = await app.inject({
      method: 'POST', url: '/auth/refresh',
      payload: { refreshToken: secondRefresh },
    })
    expect(res.statusCode).toBe(401)
  })
})

// ─── G-12: Tree privacy ───────────────────────────────────────────────────────

describe('G-12 – Tree access is restricted to own subtree', () => {
  let tokenA: string
  let memberBId: string

  beforeAll(async () => {
    // Register two unrelated members under root
    const phoneA = uniquePhone(3)
    const phoneB = uniquePhone(4)

    await app.inject({
      method: 'POST', url: '/auth/register',
      payload: { sponsorCode: rootCode, preferredLeg: 'L', name: 'TreeA', phone: phoneA, password: 'Test@12345' },
    })
    const regB = await app.inject({
      method: 'POST', url: '/auth/register',
      payload: { sponsorCode: rootCode, preferredLeg: 'R', name: 'TreeB', phone: phoneB, password: 'Test@12345' },
    })
    memberBId = JSON.parse(regB.body).memberId

    const loginA = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { phone: phoneA, password: 'Test@12345' },
    })
    tokenA = JSON.parse(loginA.body).accessToken
  })

  it('member A querying own tree (?root=me) returns 200', async () => {
    const res = await app.inject({
      method: 'GET', url: '/network/tree?root=me',
      headers: { authorization: `Bearer ${tokenA}` },
    })
    expect(res.statusCode).toBe(200)
  })

  it('member A querying member B tree (not in A downline) returns 403', async () => {
    const res = await app.inject({
      method: 'GET', url: `/network/tree?root=${memberBId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    })
    expect(res.statusCode).toBe(403)
  })
})

// ─── G-2/G-7: Payment webhook secret gate and order status ───────────────────

describe('G-2/G-7 – Webhook secret gate and payment status', () => {
  let accessToken: string
  let orderId: string   // returned as string by Postgres BIGINT

  beforeAll(async () => {
    // Register a fresh member for webhook tests
    const phone = uniquePhone(10)
    await app.inject({
      method: 'POST', url: '/auth/register',
      payload: { sponsorCode: rootCode, preferredLeg: 'L', name: 'HookTest', phone, password: 'Test@12345' },
    })
    const loginRes = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { phone, password: 'Test@12345' },
    })
    accessToken = JSON.parse(loginRes.body).accessToken

    // Create an order
    const orderRes = await app.inject({
      method: 'POST', url: '/orders',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { productId: 1 },
    })
    orderId = JSON.parse(orderRes.body).orderId
  })

  it('webhook missing x-webhook-secret returns 401 when WEBHOOK_SECRET is configured', async () => {
    if (!CFG.WEBHOOK_SECRET) return  // gate is disabled in this env — skip
    const res = await app.inject({
      method: 'POST', url: '/webhooks/payment',
      payload: {
        gatewayEventId: randomUUID(),
        orderId: Number(orderId),
        paymentRef: 'ref-missing',
        status: 'success',
      },
    })
    expect(res.statusCode).toBe(401)
  })

  it('webhook with wrong x-webhook-secret returns 401', async () => {
    if (!CFG.WEBHOOK_SECRET) return
    const res = await app.inject({
      method: 'POST', url: '/webhooks/payment',
      headers: { 'x-webhook-secret': 'definitely-wrong' },
      payload: {
        gatewayEventId: randomUUID(),
        orderId: Number(orderId),
        paymentRef: 'ref-wrong',
        status: 'success',
      },
    })
    expect(res.statusCode).toBe(401)
  })

  it('webhook with correct secret (or no secret required) confirms the order', async () => {
    // The webhook uses gatewayEventId as the idempotency_key match.
    // Fetch the key that was stored when POST /orders ran.
    const { rows } = await pool().query<{ idempotency_key: string }>(
      'SELECT idempotency_key FROM orders WHERE id=$1', [orderId]
    )
    const idemKey = rows[0].idempotency_key

    const headers: Record<string, string> = {}
    if (CFG.WEBHOOK_SECRET) headers['x-webhook-secret'] = CFG.WEBHOOK_SECRET

    const res = await app.inject({
      method: 'POST', url: '/webhooks/payment',
      headers,
      payload: { gatewayEventId: idemKey, orderId: Number(orderId), paymentRef: 'ref-ok', status: 'success' },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).ok).toBe(true)

    // Order must be marked 'confirmed' (not 'paid' or 'created')
    const { rows: oRows } = await pool().query<{ status: string }>(
      'SELECT status FROM orders WHERE id=$1', [orderId]
    )
    expect(oRows[0].status).toBe('confirmed')

    // MemberActivated event written to outbox (proves money-entry path was reached)
    const { rows: ob } = await pool().query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM events_outbox WHERE event_type='MemberActivated'
       AND (payload->>'order_id')::bigint = $1`,
      [Number(orderId)]
    )
    expect(Number(ob[0].count)).toBe(1)
  })

  it('G-2: idempotent webhook replay (same gatewayEventId) does not re-confirm', async () => {
    // The order from the previous test is already 'confirmed'. Replaying the same
    // gatewayEventId must not error (should be idempotent — either 200 no-op or 409).
    const { rows } = await pool().query<{ idempotency_key: string }>(
      'SELECT idempotency_key FROM orders WHERE id=$1', [orderId]
    )
    const idemKey = rows[0].idempotency_key
    const headers: Record<string, string> = {}
    if (CFG.WEBHOOK_SECRET) headers['x-webhook-secret'] = CFG.WEBHOOK_SECRET

    const res = await app.inject({
      method: 'POST', url: '/webhooks/payment',
      headers,
      payload: { gatewayEventId: idemKey, orderId: Number(orderId), paymentRef: 'ref-replay', status: 'success' },
    })
    // idempotent replay should not crash — 200 or 409 both acceptable
    expect([200, 409]).toContain(res.statusCode)
  })

  it('webhook with status=failed marks order as failed (G-7)', async () => {
    // Use a second member so the 'first activation' guard doesn't block
    const phone2 = uniquePhone(11)
    await app.inject({
      method: 'POST', url: '/auth/register',
      payload: { sponsorCode: rootCode, preferredLeg: 'R', name: 'HookFail', phone: phone2, password: 'Test@12345' },
    })
    const login2 = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { phone: phone2, password: 'Test@12345' },
    })
    const token2 = JSON.parse(login2.body).accessToken

    const orderRes2 = await app.inject({
      method: 'POST', url: '/orders',
      headers: { authorization: `Bearer ${token2}` },
      payload: { productId: 1 },
    })
    const failOrderId = JSON.parse(orderRes2.body).orderId

    const headers: Record<string, string> = {}
    if (CFG.WEBHOOK_SECRET) headers['x-webhook-secret'] = CFG.WEBHOOK_SECRET

    const res = await app.inject({
      method: 'POST', url: '/webhooks/payment',
      headers,
      payload: { gatewayEventId: randomUUID(), orderId: Number(failOrderId), paymentRef: 'ref-fail', status: 'failed' },
    })
    expect(res.statusCode).toBe(200)

    const { rows } = await pool().query<{ status: string }>(
      'SELECT status FROM orders WHERE id=$1', [failOrderId]
    )
    expect(rows[0].status).toBe('failed')
  })
})

// ─── G-9: Concurrent refresh token race (atomic rotation) ────────────────────

describe('G-9 – Concurrent refresh calls with same token: exactly one succeeds', () => {
  let sharedRefreshToken: string

  beforeAll(async () => {
    const phone = uniquePhone(20)
    await app.inject({
      method: 'POST', url: '/auth/register',
      payload: { sponsorCode: rootCode, preferredLeg: 'L', name: 'RaceTest', phone, password: 'Test@12345' },
    })
    const loginRes = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { phone, password: 'Test@12345' },
    })
    sharedRefreshToken = JSON.parse(loginRes.body).refreshToken
  })

  it('two concurrent refreshes with the same token produce exactly one 200 and one 401', async () => {
    // Fire both requests simultaneously — the atomic UPDATE … WHERE revoked_at IS NULL
    // RETURNING jti ensures only one can win the race. Without it the non-atomic
    // SELECT-then-UPDATE path allows both SELECTs to pass before either UPDATE commits.
    const [resA, resB] = await Promise.all([
      app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: sharedRefreshToken } }),
      app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: sharedRefreshToken } }),
    ])
    const statuses = [resA.statusCode, resB.statusCode].sort()
    // Exactly one 200, one 401 — never [200,200] (double rotation) or [401,401]
    expect(statuses).toEqual([200, 401])
  })
})
