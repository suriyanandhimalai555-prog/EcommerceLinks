/**
 * Admin rank achievement lifecycle tests.
 * Requires: Postgres 16 + Redis 7 running, migrations applied, root seeded.
 *
 * Covers:
 *   - approve no longer sets fulfilled_at (verification ≠ reward hand-over)
 *   - GET /admin/ranks status/rankLevel/q filters + pagination shape
 *   - GET /admin/ranks/summary per-level counts
 *   - POST /admin/ranks/mark-received: management-only, bulk, idempotent,
 *     touches only approved+unfulfilled rows, audits each row
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { app } from '../../src/api/server.js'
import { pool } from '../../src/lib/db.js'
import { registerAnchor, uniqueEmail, uniquePhone } from './helpers.js'

let mgmtToken: string
let adminToken: string
let achieverAId: string   // will be approved then marked received
let achieverBId: string   // stays pending — mark-received must skip it
let achievementA: string
let achievementB: string
let achieverACode: string

beforeAll(async () => {
  await app.ready()

  // Login-able management account
  const argon2 = (await import('argon2')).default
  const mgmtEmail = uniqueEmail('mgmtranks')
  await pool().query(
    `INSERT INTO members
       (member_code, name, phone, email, password_hash,
        sponsor_id, parent_id, position, placement_path, placement_sides,
        is_active, role)
     VALUES ($1,'Ranks Mgmt',$2,$3,$4,NULL,NULL,NULL,'{}','{}',TRUE,'management')`,
    [`TSTRK${Date.now().toString().slice(-6)}`, uniquePhone('9'), mgmtEmail,
     await argon2.hash('Mgmt@12345')]
  )
  const mgmtLogin = await app.inject({
    method: 'POST', url: '/auth/login',
    payload: { email: mgmtEmail, password: 'Mgmt@12345' },
  })
  mgmtToken = JSON.parse(mgmtLogin.body).accessToken

  // Plain admin (not management) to prove the 403 on mark-received
  const anchorCode = (await registerAnchor('RanksAdminAnchor')).memberCode
  const adminEmail = uniqueEmail('ranksadmin')
  const regAdmin = await app.inject({
    method: 'POST', url: '/auth/register',
    payload: { sponsorCode: anchorCode, name: 'RanksAdmin', phone: uniquePhone(), email: adminEmail, password: 'Test@12345' },
  })
  await pool().query("UPDATE members SET role='admin' WHERE id=$1",
    [JSON.parse(regAdmin.body).memberId])
  const adminLogin = await app.inject({
    method: 'POST', url: '/auth/login',
    payload: { email: adminEmail, password: 'Test@12345' },
  })
  adminToken = JSON.parse(adminLogin.body).accessToken

  // Two achievers with a rank-1 achievement each (worker path is tested elsewhere;
  // here we exercise the admin lifecycle, so insert the achievement rows directly)
  const a = await registerAnchor('RankAchieverA')
  const b = await registerAnchor('RankAchieverB')
  achieverAId = String(a.memberId)
  achieverBId = String(b.memberId)
  achieverACode = a.memberCode
  const { rows: insA } = await pool().query<{ id: string }>(
    `INSERT INTO rank_achievements (member_id, rank_level) VALUES ($1,1) RETURNING id`,
    [achieverAId]
  )
  const { rows: insB } = await pool().query<{ id: string }>(
    `INSERT INTO rank_achievements (member_id, rank_level) VALUES ($1,1) RETURNING id`,
    [achieverBId]
  )
  achievementA = insA[0].id
  achievementB = insB[0].id
})

afterAll(async () => {
  await app.close()
  await pool().end().catch(() => null)
})

describe('Rank verification vs reward hand-over', () => {
  it('approve marks the rank approved WITHOUT setting fulfilled_at', async () => {
    const res = await app.inject({
      method: 'POST', url: `/admin/ranks/${achievementA}/approve`,
      headers: { authorization: `Bearer ${mgmtToken}` },
      payload: { notes: 'verified by test' },
    })
    expect(res.statusCode).toBe(200)

    const { rows } = await pool().query<{ verification_status: string; fulfilled_at: string | null }>(
      'SELECT verification_status, fulfilled_at FROM rank_achievements WHERE id=$1',
      [achievementA]
    )
    expect(rows[0].verification_status).toBe('approved')
    expect(rows[0].fulfilled_at).toBeNull()
  })

  it('GET /admin/ranks?status=approved&rankLevel=1&q=<code> finds the achiever, paginated', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/admin/ranks?status=approved&rankLevel=1&q=${achieverACode}`,
      headers: { authorization: `Bearer ${mgmtToken}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as {
      ranks: Array<{ id: string; member_code: string; fulfilled_at: string | null }>
      total: number; page: number; limit: number
    }
    expect(body.total).toBe(1)
    expect(body.ranks[0].id).toBe(achievementA)
    expect(body.ranks[0].member_code).toBe(achieverACode)
    expect(body.ranks[0].fulfilled_at).toBeNull()
  })

  it('GET /admin/ranks rejects bad status and rankLevel (400)', async () => {
    const bad1 = await app.inject({
      method: 'GET', url: '/admin/ranks?status=nonsense',
      headers: { authorization: `Bearer ${mgmtToken}` },
    })
    expect(bad1.statusCode).toBe(400)
    const bad2 = await app.inject({
      method: 'GET', url: '/admin/ranks?rankLevel=13',
      headers: { authorization: `Bearer ${mgmtToken}` },
    })
    expect(bad2.statusCode).toBe(400)
  })

  it('a non-management admin cannot mark rewards received (403); rows untouched', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/ranks/mark-received',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { ids: [achievementA] },
    })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toMatch(/management only/i)

    const { rows } = await pool().query<{ fulfilled_at: string | null }>(
      'SELECT fulfilled_at FROM rank_achievements WHERE id=$1', [achievementA]
    )
    expect(rows[0].fulfilled_at).toBeNull()
  })

  it('management bulk mark-received updates only approved+unfulfilled rows and audits each', async () => {
    // achievementA is approved; achievementB is still pending → must be skipped
    const res = await app.inject({
      method: 'POST', url: '/admin/ranks/mark-received',
      headers: { authorization: `Bearer ${mgmtToken}` },
      payload: { ids: [achievementA, achievementB], notes: 'handed over at office' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.updated).toBe(1)
    expect(body.skipped).toBe(1)

    const { rows } = await pool().query<{ fulfilled_at: string | null; fulfillment_notes: string | null }>(
      'SELECT fulfilled_at, fulfillment_notes FROM rank_achievements WHERE id=$1', [achievementA]
    )
    expect(rows[0].fulfilled_at).not.toBeNull()
    expect(rows[0].fulfillment_notes).toBe('handed over at office')

    const { rows: pendingB } = await pool().query<{ fulfilled_at: string | null }>(
      'SELECT fulfilled_at FROM rank_achievements WHERE id=$1', [achievementB]
    )
    expect(pendingB[0].fulfilled_at).toBeNull()

    const { rows: audit } = await pool().query(
      `SELECT after_state FROM admin_audit_log
       WHERE action='rank_reward_received' AND target_id=$1`,
      [achievementA]
    )
    expect(audit.length).toBe(1)
  })

  it('re-posting the same ids is a no-op (updated=0)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/ranks/mark-received',
      headers: { authorization: `Bearer ${mgmtToken}` },
      payload: { ids: [achievementA] },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.updated).toBe(0)
    expect(body.skipped).toBe(1)
  })

  it('GET /admin/ranks?status=received now includes the achiever; approved no longer does', async () => {
    const received = await app.inject({
      method: 'GET', url: `/admin/ranks?status=received&rankLevel=1&q=${achieverACode}`,
      headers: { authorization: `Bearer ${mgmtToken}` },
    })
    expect(JSON.parse(received.body).total).toBe(1)

    const approved = await app.inject({
      method: 'GET', url: `/admin/ranks?status=approved&rankLevel=1&q=${achieverACode}`,
      headers: { authorization: `Bearer ${mgmtToken}` },
    })
    expect(JSON.parse(approved.body).total).toBe(0)
  })

  it('GET /admin/ranks/summary reports per-level pending/approved/received counts', async () => {
    const res = await app.inject({
      method: 'GET', url: '/admin/ranks/summary',
      headers: { authorization: `Bearer ${mgmtToken}` },
    })
    expect(res.statusCode).toBe(200)
    const rows = JSON.parse(res.body) as Array<{
      rank_level: number; pending: number; approved: number; received: number; rejected: number
    }>
    const level1 = rows.find((r) => r.rank_level === 1)
    expect(level1).toBeTruthy()
    // At least our fixtures: A received, B pending (other parallel tests may add more)
    expect(level1!.received).toBeGreaterThanOrEqual(1)
    expect(level1!.pending).toBeGreaterThanOrEqual(1)
  })
})
