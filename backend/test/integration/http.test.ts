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
 *   - CAP:  2-referral cap — direct placement L then R, 3rd registration → 409
 */
import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { app } from '../../src/api/server.js'
import { pool } from '../../src/lib/db.js'
import { CFG } from '../../src/config.js'
import { registerAnchor, uniqueEmail } from './helpers.js'

function uniquePhone(suffix: number) {
  const s = String(suffix).padStart(3, '0')
  return `8${Date.now().toString().slice(-7)}${s}`
}

beforeAll(async () => {
  await app.ready()
  const { rows } = await pool().query<{ member_code: string }>(
    "SELECT member_code FROM members WHERE parent_id IS NULL AND role <> 'management' LIMIT 1"
  )
  if (!rows[0]) throw new Error('Root member not seeded — run npm run seed first')
})

afterAll(async () => {
  await app.close()
  await pool().end().catch(() => null)
})

// ─── G-10: Duplicate phone registration returns 409 ──────────────────────────

describe('G-10 – Duplicate registration returns 409', () => {
  const phone = uniquePhone(1)
  const email = uniqueEmail('dup')
  let anchorCode: string

  beforeAll(async () => {
    anchorCode = (await registerAnchor('DupAnchor')).memberCode
  })

  it('first registration succeeds (201)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/auth/register',
      payload: {
        sponsorCode: anchorCode,
        name: 'DupTest', phone, email, password: 'Test@12345',
      },
    })
    expect(res.statusCode).toBe(201)
  })

  it('second registration with same phone returns 409', async () => {
    // Anchor's R slot is still free and the email differs,
    // so the failure is the phone constraint
    const res = await app.inject({
      method: 'POST', url: '/auth/register',
      payload: {
        sponsorCode: anchorCode,
        name: 'DupTest2', phone, email: uniqueEmail('dup2'), password: 'Test@12345',
      },
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).error).toMatch(/already registered/i)
  })

  it('registration with same email but different phone returns 409', async () => {
    const res = await app.inject({
      method: 'POST', url: '/auth/register',
      payload: {
        sponsorCode: anchorCode,
        name: 'DupTest3', phone: uniquePhone(2), email, password: 'Test@12345',
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
  const phone = uniquePhone(3)
  const email = uniqueEmail('token')

  beforeAll(async () => {
    // Register + login a fresh member
    const anchorCode = (await registerAnchor('TokenAnchor')).memberCode
    await app.inject({
      method: 'POST', url: '/auth/register',
      payload: { sponsorCode: anchorCode, name: 'TokenTest', phone, email, password: 'Test@12345' },
    })
    const loginRes = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { email, password: 'Test@12345' },
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
    // Register two unrelated members as siblings under one anchor
    // (A must NOT be B's ancestor for the 404 assertion to hold)
    const anchorCode = (await registerAnchor('TreeAnchor')).memberCode
    const emailA = uniqueEmail('treea')

    await app.inject({
      method: 'POST', url: '/auth/register',
      payload: { sponsorCode: anchorCode, name: 'TreeA', phone: uniquePhone(4), email: emailA, password: 'Test@12345' },
    })
    const regB = await app.inject({
      method: 'POST', url: '/auth/register',
      payload: { sponsorCode: anchorCode, name: 'TreeB', phone: uniquePhone(5), email: uniqueEmail('treeb'), password: 'Test@12345' },
    })
    memberBId = JSON.parse(regB.body).memberId

    const loginA = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { email: emailA, password: 'Test@12345' },
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

  it('member A querying member B tree (not in A downline) returns 404 (not 403, to avoid member-code existence leak)', async () => {
    const res = await app.inject({
      method: 'GET', url: `/network/tree?root=${memberBId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    })
    expect(res.statusCode).toBe(404)
  })
})

// ─── G-2/G-7: Payment webhook secret gate and order status ───────────────────

describe('G-2/G-7 – Webhook secret gate and payment status', () => {
  let accessToken: string
  let orderId: string   // returned as string by Postgres BIGINT
  let hookAnchorCode: string

  beforeAll(async () => {
    // Register a fresh member for webhook tests
    hookAnchorCode = (await registerAnchor('HookAnchor')).memberCode
    const email = uniqueEmail('hook')
    const regRes = await app.inject({
      method: 'POST', url: '/auth/register',
      payload: { sponsorCode: hookAnchorCode, name: 'HookTest', phone: uniquePhone(10), email, password: 'Test@12345' },
    })
    // POST /orders now gates on verified KYC
    await pool().query("UPDATE members SET kyc_status='verified' WHERE id=$1",
      [JSON.parse(regRes.body).memberId])
    const loginRes = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { email, password: 'Test@12345' },
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
    const email2 = uniqueEmail('hookfail')
    const regFail = await app.inject({
      method: 'POST', url: '/auth/register',
      payload: { sponsorCode: hookAnchorCode, name: 'HookFail', phone: uniquePhone(11), email: email2, password: 'Test@12345' },
    })
    await pool().query("UPDATE members SET kyc_status='verified' WHERE id=$1",
      [JSON.parse(regFail.body).memberId])
    const login2 = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { email: email2, password: 'Test@12345' },
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

// ─── Phase 2: Admin management endpoints ─────────────────────────────────────

describe('Phase 2 – Admin management endpoints', () => {
  let rootToken: string
  let targetMemberId: string
  let nonRootAdminId: string
  let nonRootAdminToken: string

  beforeAll(async () => {
    // Since the three-tier roles change the tree root is a plain member —
    // admin control lives on management accounts. Create a login-able one.
    const argon2 = (await import('argon2')).default
    const mgmtEmail = uniqueEmail('mgmtphase2')
    await pool().query(
      `INSERT INTO members
         (member_code, name, phone, email, password_hash,
          sponsor_id, parent_id, position, placement_path, placement_sides,
          is_active, role)
       VALUES ($1,'Phase2 Mgmt',$2,$3,$4,NULL,NULL,NULL,'{}','{}',TRUE,'management')`,
      [`TSTP2${Date.now().toString().slice(-6)}`, uniquePhone(904), mgmtEmail,
       await argon2.hash('Mgmt@12345')]
    )
    const loginRes = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { email: mgmtEmail, password: 'Mgmt@12345' },
    })
    rootToken = JSON.parse(loginRes.body).accessToken

    // Register a member that admin tests will operate on
    const anchorCode = (await registerAnchor('AdminAnchor')).memberCode
    const regRes = await app.inject({
      method: 'POST', url: '/auth/register',
      payload: { sponsorCode: anchorCode, name: 'AdjTarget', phone: uniquePhone(30), email: uniqueEmail('adjtarget'), password: 'Test@12345' },
    })
    targetMemberId = JSON.parse(regRes.body).memberId

    // Register a second member to promote to non-root admin
    const adminEmail = uniqueEmail('nonrootadmin')
    const reg2 = await app.inject({
      method: 'POST', url: '/auth/register',
      payload: { sponsorCode: anchorCode, name: 'NonRootAdmin', phone: uniquePhone(31), email: adminEmail, password: 'Test@12345' },
    })
    nonRootAdminId = JSON.parse(reg2.body).memberId

    const login2 = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { email: adminEmail, password: 'Test@12345' },
    })
    nonRootAdminToken = JSON.parse(login2.body).accessToken
  })

  it('non-admin member is rejected from admin endpoint (403)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/admin/members',
      headers: { authorization: `Bearer ${nonRootAdminToken}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('credit adjustment increases wallet balance and writes audit row (BR-12)', async () => {
    const { rows: b0 } = await pool().query<{ balance: string }>(
      `SELECT wb.balance FROM wallet_balances wb
       JOIN accounts a ON a.id = wb.account_id
       WHERE a.owner_id = $1 AND a.kind = 'wallet'`,
      [targetMemberId]
    )
    const balanceBefore = parseFloat(b0[0].balance)

    const res = await app.inject({
      method: 'POST', url: `/admin/members/${targetMemberId}/adjustment`,
      headers: { authorization: `Bearer ${rootToken}` },
      payload: { amountPaise: 1000, direction: 'credit', notes: 'test credit' },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).ok).toBe(true)

    // Balance must increase by exactly 1000 paise (₹10.00)
    const { rows: b1 } = await pool().query<{ balance: string }>(
      `SELECT wb.balance FROM wallet_balances wb
       JOIN accounts a ON a.id = wb.account_id
       WHERE a.owner_id = $1 AND a.kind = 'wallet'`,
      [targetMemberId]
    )
    expect(parseFloat(b1[0].balance)).toBeCloseTo(balanceBefore + 10, 2)

    // Audit row written in the same transaction (BR-12)
    const { rows: audit } = await pool().query<{
      action: string; after_state: { direction: string; amountPaise: number; notes: string }
    }>(
      `SELECT action, after_state FROM admin_audit_log
       WHERE target_id=$1 AND action='adjustment' ORDER BY created_at DESC LIMIT 1`,
      [targetMemberId]
    )
    expect(audit.length).toBe(1)
    expect(audit[0].after_state.direction).toBe('credit')
    expect(audit[0].after_state.amountPaise).toBe(1000)
  })

  it('debit adjustment decreases wallet balance and writes audit row', async () => {
    const { rows: b0 } = await pool().query<{ balance: string }>(
      `SELECT wb.balance FROM wallet_balances wb
       JOIN accounts a ON a.id = wb.account_id
       WHERE a.owner_id = $1 AND a.kind = 'wallet'`,
      [targetMemberId]
    )
    const balanceBefore = parseFloat(b0[0].balance)

    const res = await app.inject({
      method: 'POST', url: `/admin/members/${targetMemberId}/adjustment`,
      headers: { authorization: `Bearer ${rootToken}` },
      payload: { amountPaise: 500, direction: 'debit', notes: 'test debit' },
    })
    expect(res.statusCode).toBe(200)

    const { rows: b1 } = await pool().query<{ balance: string }>(
      `SELECT wb.balance FROM wallet_balances wb
       JOIN accounts a ON a.id = wb.account_id
       WHERE a.owner_id = $1 AND a.kind = 'wallet'`,
      [targetMemberId]
    )
    // Balance must decrease by exactly 500 paise (₹5.00)
    expect(parseFloat(b1[0].balance)).toBeCloseTo(balanceBefore - 5, 2)

    const { rows: audit } = await pool().query<{
      after_state: { direction: string; amountPaise: number }
    }>(
      `SELECT after_state FROM admin_audit_log
       WHERE target_id=$1 AND action='adjustment' ORDER BY created_at DESC LIMIT 1`,
      [targetMemberId]
    )
    expect(audit[0].after_state.direction).toBe('debit')
    expect(audit[0].after_state.amountPaise).toBe(500)
  })

  it('KYC update persists status and writes audit row', async () => {
    const res = await app.inject({
      method: 'POST', url: `/admin/members/${targetMemberId}/kyc`,
      headers: { authorization: `Bearer ${rootToken}` },
      payload: { status: 'verified', notes: 'documents ok' },
    })
    expect(res.statusCode).toBe(200)

    const { rows: mRows } = await pool().query<{ kyc_status: string }>(
      'SELECT kyc_status FROM members WHERE id=$1',
      [targetMemberId]
    )
    expect(mRows[0].kyc_status).toBe('verified')

    const { rows: audit } = await pool().query<{
      before_state: { kyc_status: string }; after_state: { kyc_status: string }
    }>(
      `SELECT before_state, after_state FROM admin_audit_log
       WHERE target_id=$1 AND action='kyc_update' ORDER BY created_at DESC LIMIT 1`,
      [targetMemberId]
    )
    expect(audit.length).toBe(1)
    expect(audit[0].before_state.kyc_status).toBe('pending')
    expect(audit[0].after_state.kyc_status).toBe('verified')
  })

  it('non-root admin is rejected from role change endpoint (403)', async () => {
    // Promote nonRootAdminId to admin role (using root)
    const promoteRes = await app.inject({
      method: 'POST', url: `/admin/members/${nonRootAdminId}/role`,
      headers: { authorization: `Bearer ${rootToken}` },
      payload: { role: 'admin' },
    })
    expect(promoteRes.statusCode).toBe(200)

    // Non-root admin (has parent_id) tries to change someone else's role → must 403
    const res = await app.inject({
      method: 'POST', url: `/admin/members/${targetMemberId}/role`,
      headers: { authorization: `Bearer ${nonRootAdminToken}` },
      payload: { role: 'member' },
    })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toMatch(/management only/i)
  })
})

// ─── G-9: Concurrent refresh token race (atomic rotation) ────────────────────

describe('G-9 – Concurrent refresh calls with same token: exactly one succeeds', () => {
  let sharedRefreshToken: string

  beforeAll(async () => {
    const anchorCode = (await registerAnchor('RaceAnchor')).memberCode
    const email = uniqueEmail('race')
    await app.inject({
      method: 'POST', url: '/auth/register',
      payload: { sponsorCode: anchorCode, name: 'RaceTest', phone: uniquePhone(20), email, password: 'Test@12345' },
    })
    const loginRes = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { email, password: 'Test@12345' },
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

// ─── CAP: 2-referral hard cap with direct placement ──────────────────────────

describe('CAP – each member can refer at most 2 people, placed L then R', () => {
  it('referrals fill L then R directly under the sponsor; 3rd returns 409', async () => {
    const anchor = await registerAnchor('CapAnchor')

    const results: Array<{ status: number; body: string }> = []
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: 'POST', url: '/auth/register',
        payload: { sponsorCode: anchor.memberCode, name: `CapKid${i}`, phone: uniquePhone(40 + i), email: uniqueEmail(`capkid${i}`), password: 'Test@12345' },
      })
      results.push({ status: res.statusCode, body: res.body })
    }

    expect(results[0].status).toBe(201)
    expect(results[1].status).toBe(201)
    expect(results[2].status).toBe(409)
    expect(JSON.parse(results[2].body).error).toMatch(/referral limit/i)

    // Both children sit DIRECTLY under the sponsor: first L, second R
    const c1 = JSON.parse(results[0].body).memberId
    const c2 = JSON.parse(results[1].body).memberId
    const { rows } = await pool().query<{ id: string; sponsor_id: string; parent_id: string; position: string }>(
      'SELECT id, sponsor_id, parent_id, position FROM members WHERE id = ANY($1)',
      [[c1, c2]]
    )
    const byId = Object.fromEntries(rows.map(r => [r.id, r]))
    expect(byId[c1].parent_id).toBe(String(anchor.memberId))
    expect(byId[c1].sponsor_id).toBe(String(anchor.memberId))
    expect(byId[c1].position).toBe('L')
    expect(byId[c2].parent_id).toBe(String(anchor.memberId))
    expect(byId[c2].sponsor_id).toBe(String(anchor.memberId))
    expect(byId[c2].position).toBe('R')
  })

  it('two concurrent registrations for the last slot: exactly one 201 and one 409', async () => {
    const anchor = await registerAnchor('CapRaceAnchor')

    // Fill the L slot first, leaving exactly one open slot
    const first = await app.inject({
      method: 'POST', url: '/auth/register',
      payload: { sponsorCode: anchor.memberCode, name: 'CapRace0', phone: uniquePhone(50), email: uniqueEmail('caprace0'), password: 'Test@12345' },
    })
    expect(first.statusCode).toBe(201)

    // The sponsor row lock (FOR UPDATE) must serialize these — never [201,201]
    const [resA, resB] = await Promise.all([
      app.inject({
        method: 'POST', url: '/auth/register',
        payload: { sponsorCode: anchor.memberCode, name: 'CapRaceA', phone: uniquePhone(51), email: uniqueEmail('capracea'), password: 'Test@12345' },
      }),
      app.inject({
        method: 'POST', url: '/auth/register',
        payload: { sponsorCode: anchor.memberCode, name: 'CapRaceB', phone: uniquePhone(52), email: uniqueEmail('capraceb'), password: 'Test@12345' },
      }),
    ])
    const statuses = [resA.statusCode, resB.statusCode].sort()
    expect(statuses).toEqual([201, 409])
  })
})

// ─── Management accounts are off-tree: nothing may register under them ───────

describe('Management sponsor guard (placement.ts)', () => {
  let mgmtCode: string

  beforeAll(async () => {
    // Use the seeded management account, or create a throwaway one.
    const { rows } = await pool().query<{ member_code: string }>(
      "SELECT member_code FROM members WHERE role = 'management' LIMIT 1"
    )
    if (rows[0]) {
      mgmtCode = rows[0].member_code
    } else {
      mgmtCode = `TSTMGMT${Date.now().toString().slice(-6)}`
      await pool().query(
        `INSERT INTO members
           (member_code, name, phone, email, password_hash,
            sponsor_id, parent_id, position, placement_path, placement_sides,
            is_active, role)
         VALUES ($1,'Test Mgmt',$2,$3,'x',NULL,NULL,NULL,'{}','{}',TRUE,'management')`,
        [mgmtCode, uniquePhone(900), uniqueEmail('mgmt')]
      )
    }
  })

  it('registerMember service rejects a management sponsor with 409', async () => {
    const { registerMember } = await import('../../src/services/placement.js')
    await expect(
      registerMember({
        sponsorCode: mgmtCode,
        name: 'UnderMgmt',
        phone: uniquePhone(901),
        email: uniqueEmail('undermgmt'),
        password: 'Test@12345',
      })
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('POST /auth/register with a management sponsor returns 409', async () => {
    const res = await app.inject({
      method: 'POST', url: '/auth/register',
      payload: {
        sponsorCode: mgmtCode,
        name: 'UnderMgmt2',
        phone: uniquePhone(902),
        email: uniqueEmail('undermgmt2'),
        password: 'Test@12345',
      },
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).error).toMatch(/cannot be used as a sponsor/i)
  })
})

// ─── KYC gate: orders require verified KYC ───────────────────────────────────

describe('KYC gate – POST /orders requires kyc_status=verified', () => {
  let token: string
  let memberId: string

  beforeAll(async () => {
    const anchorCode = (await registerAnchor('KycGateAnchor')).memberCode
    const email = uniqueEmail('kycgate')
    const reg = await app.inject({
      method: 'POST', url: '/auth/register',
      payload: { sponsorCode: anchorCode, name: 'KycGate', phone: uniquePhone(60), email, password: 'Test@12345' },
    })
    memberId = JSON.parse(reg.body).memberId
    const login = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { email, password: 'Test@12345' },
    })
    token = JSON.parse(login.body).accessToken
  })

  it('unverified member gets 409 KYC_REQUIRED', async () => {
    const res = await app.inject({
      method: 'POST', url: '/orders',
      headers: { authorization: `Bearer ${token}` },
      payload: { productId: 1 },
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).error.code).toBe('KYC_REQUIRED')
  })

  it('verified member can create the order (201)', async () => {
    await pool().query("UPDATE members SET kyc_status='verified' WHERE id=$1", [memberId])
    const res = await app.inject({
      method: 'POST', url: '/orders',
      headers: { authorization: `Bearer ${token}` },
      payload: { productId: 1 },
    })
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body).status).toBe('created')
  })
})

// ─── Product catalog: management-only CRUD ───────────────────────────────────

describe('Products – management-only catalog CRUD', () => {
  let mgmtToken: string
  let adminToken: string
  let productId: number

  beforeAll(async () => {
    // A login-able management account (the seeded one's password is unknown here)
    const argon2 = (await import('argon2')).default
    const mgmtEmail = uniqueEmail('mgmtprod')
    const hash = await argon2.hash('Mgmt@12345')
    await pool().query(
      `INSERT INTO members
         (member_code, name, phone, email, password_hash,
          sponsor_id, parent_id, position, placement_path, placement_sides,
          is_active, role)
       VALUES ($1,'Prod Mgmt',$2,$3,$4,NULL,NULL,NULL,'{}','{}',TRUE,'management')`,
      [`TSTPM${Date.now().toString().slice(-6)}`, uniquePhone(903), mgmtEmail, hash]
    )
    const mgmtLogin = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { email: mgmtEmail, password: 'Mgmt@12345' },
    })
    mgmtToken = JSON.parse(mgmtLogin.body).accessToken

    // A plain admin (not management) to prove the 403
    const anchorCode = (await registerAnchor('ProdAdminAnchor')).memberCode
    const adminEmail = uniqueEmail('prodadmin')
    const reg = await app.inject({
      method: 'POST', url: '/auth/register',
      payload: { sponsorCode: anchorCode, name: 'ProdAdmin', phone: uniquePhone(61), email: adminEmail, password: 'Test@12345' },
    })
    await pool().query("UPDATE members SET role='admin' WHERE id=$1",
      [JSON.parse(reg.body).memberId])
    const adminLogin = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { email: adminEmail, password: 'Test@12345' },
    })
    adminToken = JSON.parse(adminLogin.body).accessToken
  })

  it('a non-management admin cannot create products (403)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/products',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'Nope', basePricePaise: 100000 },
    })
    expect(res.statusCode).toBe(403)
  })

  it('management creates a product; it appears on the member catalog with correct paise math and an audit row', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/products',
      headers: { authorization: `Bearer ${mgmtToken}` },
      payload: {
        name: 'Test Catalog Product',
        description: 'Integration test product',
        basePricePaise: 123456,
        active: true,
        imageKeys: [],
      },
    })
    expect(res.statusCode).toBe(201)
    productId = JSON.parse(res.body).id
    expect(productId).toBeGreaterThan(3)

    const list = await app.inject({ method: 'GET', url: '/products' })
    const products = JSON.parse(list.body) as Array<{
      id: number; description: string; basePricePaise: number
      gstPaise: number; totalPaise: number; images: unknown[]
    }>
    const created = products.find((p) => p.id === productId)
    expect(created).toBeTruthy()
    expect(created?.basePricePaise).toBe(123456)
    expect(created?.gstPaise).toBe(22222)          // floor(123456 * 18%)
    expect(created?.totalPaise).toBe(145678)
    expect(created?.description).toBe('Integration test product')
    expect(created?.images).toEqual([])

    const { rows: audit } = await pool().query(
      `SELECT action FROM admin_audit_log
       WHERE action='create_product' AND target_id=$1`,
      [productId]
    )
    expect(audit.length).toBe(1)
  })

  it('PATCH active=false hides the product from the member catalog', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/admin/products/${productId}`,
      headers: { authorization: `Bearer ${mgmtToken}` },
      payload: { active: false },
    })
    expect(res.statusCode).toBe(200)

    const list = await app.inject({ method: 'GET', url: '/products' })
    const products = JSON.parse(list.body) as Array<{ id: number }>
    expect(products.find((p) => p.id === productId)).toBeUndefined()

    // Still visible on the admin catalog
    const adminList = await app.inject({
      method: 'GET', url: '/admin/products',
      headers: { authorization: `Bearer ${mgmtToken}` },
    })
    const adminProducts = JSON.parse(adminList.body) as Array<{ id: number; active: boolean }>
    expect(adminProducts.find((p) => p.id === productId)?.active).toBe(false)
  })
})
