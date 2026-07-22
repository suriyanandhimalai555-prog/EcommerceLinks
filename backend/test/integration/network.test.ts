/**
 * /network/downline + /network/tree depth-cap integration tests.
 * Requires: Postgres 16 + Redis 7 running, migrations applied, root seeded.
 *
 * Fixture placement tree (registered fresh under a helper anchor):
 *
 *   A ── L ── B ── L ── D ── L ── E ── L ── F ── L ── G   (5-deep chain)
 *     └─ R ── C
 *
 * The shared dev DB means other test files may hang members under these
 * nodes concurrently, so assertions check inclusion/exclusion and relative
 * order of the fixture members — never exact result sets or totals.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { app } from '../../src/api/server.js'
import { pool } from '../../src/lib/db.js'
import { redis } from '../../src/lib/redis.js'
import { registerMember } from '../../src/services/placement.js'
import { registerAnchor, uniqueEmail, uniquePhone } from './helpers.js'

const PASSWORD = 'Test@12345'

interface Fixture {
  memberId: bigint
  memberCode: string
  email: string
}

async function registerUnder(sponsorCode: string, name: string): Promise<Fixture> {
  const email = uniqueEmail('net')
  const { memberId, memberCode } = await registerMember({
    sponsorCode,
    name,
    phone: uniquePhone(),
    email,
    password: PASSWORD,
  })
  return { memberId, memberCode, email }
}

/** Login that works whether or not login_otp_enabled is on (OTP read from Redis). */
async function loginFor(f: Fixture): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/auth/login',
    payload: { email: f.email, password: PASSWORD },
  })
  expect(res.statusCode).toBe(200)
  const body = JSON.parse(res.body)
  if (!body.otpRequired) return body.accessToken
  const code = await redis().get(`login_otp:${f.memberId}`)
  expect(code).toBeTruthy()
  const v = await app.inject({
    method: 'POST', url: '/auth/login/verify-otp',
    payload: { email: f.email, otp: code },
  })
  expect(v.statusCode).toBe(200)
  return JSON.parse(v.body).accessToken
}

interface DownlineItem {
  memberCode: string
  name: string
  level: number
  leg: 'L' | 'R'
  isActive: boolean
  isQualified: boolean
  joinedAt: string
}

async function getDownline(token: string, qs = 'limit=100') {
  const res = await app.inject({
    method: 'GET', url: `/network/downline?${qs}`,
    headers: { authorization: `Bearer ${token}` },
  })
  expect(res.statusCode).toBe(200)
  return JSON.parse(res.body) as {
    items: DownlineItem[]; total: number; page: number; limit: number
  }
}

let A: Fixture, B: Fixture, C: Fixture, D: Fixture, E: Fixture, F: Fixture, G: Fixture
let H: Fixture, I: Fixture
let tokenA: string
let tokenB: string

beforeAll(async () => {
  await app.ready()
  const anchor = await registerAnchor('NetAnchor')
  A = await registerUnder(anchor.memberCode, 'NetTreeA')
  B = await registerUnder(A.memberCode, 'NetTreeB') // first under A → L
  C = await registerUnder(A.memberCode, 'NetTreeC') // second under A → R
  D = await registerUnder(B.memberCode, 'NetTreeD') // first under B → L
  E = await registerUnder(D.memberCode, 'NetTreeE')
  F = await registerUnder(E.memberCode, 'NetTreeF')
  G = await registerUnder(F.memberCode, 'NetTreeG') // level 5 below A
  H = await registerUnder(G.memberCode, 'NetTreeH') // level 6 — at the cap
  I = await registerUnder(H.memberCode, 'NetTreeI') // level 7 — beyond the cap
  tokenA = await loginFor(A)
  tokenB = await loginFor(B)
}, 120_000)

afterAll(async () => {
  await app.close()
  await pool().end().catch(() => null)
})

describe('GET /network/downline', () => {
  it('requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/network/downline' })
    expect(res.statusCode).toBe(401)
  })

  it('is scoped to the caller subtree: B sees D but never A or C or itself', async () => {
    const page = await getDownline(tokenB)
    const codes = page.items.map((i) => i.memberCode)
    expect(codes).toContain(D.memberCode)
    expect(codes).not.toContain(A.memberCode)
    expect(codes).not.toContain(B.memberCode)
    expect(codes).not.toContain(C.memberCode)
  })

  it('returns correct levels and level-order (level asc, oldest first within level)', async () => {
    const page = await getDownline(tokenA)
    const byCode = new Map(page.items.map((i) => [i.memberCode, i]))
    expect(byCode.get(B.memberCode)?.level).toBe(1)
    expect(byCode.get(C.memberCode)?.level).toBe(1)
    expect(byCode.get(D.memberCode)?.level).toBe(2)
    expect(byCode.get(G.memberCode)?.level).toBe(5)
    const idx = (f: Fixture) => page.items.findIndex((i) => i.memberCode === f.memberCode)
    expect(idx(B)).toBeLessThan(idx(C)) // same level, B registered first
    expect(idx(C)).toBeLessThan(idx(D)) // level 1 before level 2
    expect(idx(D)).toBeLessThan(idx(G)) // level 2 before level 5
  })

  it('reports the leg each descendant sits under', async () => {
    const page = await getDownline(tokenA)
    const byCode = new Map(page.items.map((i) => [i.memberCode, i]))
    expect(byCode.get(B.memberCode)?.leg).toBe('L')
    expect(byCode.get(C.memberCode)?.leg).toBe('R')
    expect(byCode.get(D.memberCode)?.leg).toBe('L') // D reached via A's left leg
    expect(byCode.get(G.memberCode)?.leg).toBe('L')
  })

  it('search matches member code and name (ILIKE), empty result for garbage', async () => {
    const byCode = await getDownline(tokenA, `limit=100&q=${encodeURIComponent(B.memberCode)}`)
    expect(byCode.total).toBe(1)
    expect(byCode.items[0].memberCode).toBe(B.memberCode)

    const byName = await getDownline(tokenA, 'limit=100&q=nettreec')
    expect(byName.items.some((i) => i.memberCode === C.memberCode)).toBe(true)

    const none = await getDownline(tokenA, 'limit=100&q=zzz-no-such-member-xyz')
    expect(none.total).toBe(0)
    expect(none.items).toEqual([])
  })

  it('paginates with a stable total and no overlap between pages', async () => {
    const p1 = await getDownline(tokenA, 'limit=1&page=1')
    const p2 = await getDownline(tokenA, 'limit=1&page=2')
    expect(p1.items).toHaveLength(1)
    expect(p2.items).toHaveLength(1)
    expect(p1.items[0].memberCode).not.toBe(p2.items[0].memberCode)
    expect(p1.total).toBe(p2.total)
    expect(p1.page).toBe(1)
    expect(p2.page).toBe(2)
  })
})

describe('GET /network/tree depth cap (raised to 12)', () => {
  interface Node {
    memberCode: string; left: Node | null; right: Node | null
    [k: string]: unknown
  }

  function findDepth(node: Node | null, code: string, lvl = 0): number | null {
    if (!node) return null
    if (node.memberCode === code) return lvl
    return findDepth(node.left, code, lvl + 1) ?? findDepth(node.right, code, lvl + 1)
  }

  async function getTree(depth: number): Promise<Node> {
    const res = await app.inject({
      method: 'GET', url: `/network/tree?root=me&depth=${depth}`,
      headers: { authorization: `Bearer ${tokenA}` },
    })
    expect(res.statusCode).toBe(200)
    return JSON.parse(res.body) as Node
  }

  it('an explicit depth=6 request still returns exactly levels 0..6', async () => {
    const tree = await getTree(6)
    expect(findDepth(tree, G.memberCode)).toBe(5)
    expect(findDepth(tree, H.memberCode)).toBe(6)
    expect(findDepth(tree, I.memberCode)).toBeNull()
  })

  it('depth=4 excludes deeper nodes and keeps the exact node shape (contract)', async () => {
    const tree = await getTree(4)
    expect(findDepth(tree, F.memberCode)).toBe(4)
    expect(findDepth(tree, G.memberCode)).toBeNull()
    expect(Object.keys(tree).sort()).toEqual(
      ['isActive', 'isQualified', 'left', 'memberCode', 'name', 'position', 'right'].sort(),
    )
  })

  // The cap was raised past 6: a level-7 node that used to be clamped away now
  // shows. (The fixture only reaches level 7, so this proves cap > 6, not the
  // exact 12 boundary — the cap is a config value, not a money invariant.)
  it('depth beyond the fixture returns level 7 (cap raised past 6)', async () => {
    const tree = await getTree(99)
    expect(findDepth(tree, H.memberCode)).toBe(6)
    expect(findDepth(tree, I.memberCode)).toBe(7)
  })
})
