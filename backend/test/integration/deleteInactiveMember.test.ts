/**
 * Integration tests for DELETE /admin/network/:memberCode — admin-only hard-delete
 * of an inactive, childless, order-free member.
 *
 * Requires: Postgres 16 + Redis 7 running, migrations applied, root seeded,
 * and management seeded (npm run seed + npm run seed:management).
 *
 * Guards tested:
 *   404 — unknown member code
 *   403 — trying to delete the management account itself
 *   403 — non-admin caller (regular member) is rejected
 *   409 — member is active (has confirmed order)
 *   409 — member has their own downline (is not a leaf)
 *   409 — member has a live (created) order
 *   200 — clean inactive leaf is fully deleted + slot freed
 *   200 — cleans up rejected orders + kyc_documents rows automatically
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { app } from '../../src/api/server.js'
import { pool } from '../../src/lib/db.js'
import { registerAnchor, uniqueEmail, uniquePhone } from './helpers.js'

function signToken(memberId: bigint | string, memberCode: string, name: string): string {
  return app.jwt.sign({ sub: String(memberId), code: memberCode, name })
}

async function getManagementAccount(): Promise<{ id: bigint; memberCode: string } | null> {
  const { rows } = await pool().query<{ id: string; member_code: string }>(
    "SELECT id, member_code FROM members WHERE role = 'management' LIMIT 1",
  )
  if (!rows[0]) return null
  return { id: BigInt(rows[0].id), memberCode: rows[0].member_code }
}

/** Register a plain (inactive) member directly under an anchor via the service layer. */
async function registerLeaf(sponsorCode: string, name: string): Promise<{ memberId: bigint; memberCode: string }> {
  const { registerMember } = await import('../../src/services/placement.js')
  return registerMember({ sponsorCode, name, phone: uniquePhone(), email: uniqueEmail('del'), password: 'Test@12345' })
}

let mgmtId: bigint
let mgmtCode: string
let mgmtToken: string
let regularToken: string

beforeAll(async () => {
  await app.ready()

  const mgmt = await getManagementAccount()
  if (!mgmt) {
    console.warn('[deleteInactiveMember] management account not found — run npm run seed:management')
    return
  }
  mgmtId = mgmt.id
  mgmtCode = mgmt.memberCode
  mgmtToken = signToken(mgmt.id, mgmt.memberCode, 'AVG Management')

  const { rows } = await pool().query<{ id: string; member_code: string }>(
    "SELECT id, member_code FROM members WHERE role = 'member' LIMIT 1",
  )
  if (rows[0]) regularToken = signToken(BigInt(rows[0].id), rows[0].member_code, 'Regular')
})

afterAll(async () => {
  await pool().end().catch(() => null)
})

describe('DELETE /admin/network/:memberCode', () => {
  it('404 — unknown member code', async () => {
    if (!mgmtToken) return
    const res = await app.inject({
      method: 'DELETE', url: '/admin/network/DOES-NOT-EXIST',
      headers: { authorization: `Bearer ${mgmtToken}` },
    })
    expect(res.statusCode).toBe(404)
  })

  it('403 — non-admin caller is rejected (requireAdmin gate)', async () => {
    if (!regularToken) return
    const anchor = await registerAnchor('DelGate')
    const { memberCode } = await registerLeaf(anchor.memberCode, 'DelGateLeaf')
    const res = await app.inject({
      method: 'DELETE', url: `/admin/network/${memberCode}`,
      headers: { authorization: `Bearer ${regularToken}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('403 — management account itself cannot be deleted', async () => {
    if (!mgmtToken || !mgmtCode) return
    const res = await app.inject({
      method: 'DELETE', url: `/admin/network/${mgmtCode}`,
      headers: { authorization: `Bearer ${mgmtToken}` },
    })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toMatch(/management/i)
  })

  it('409 — active member cannot be deleted', async () => {
    if (!mgmtToken) return
    const anchor = await registerAnchor('DelActiveAnchor')
    const { memberCode } = await registerLeaf(anchor.memberCode, 'DelActiveLeaf')
    // Flip is_active directly (the only state that matters for this guard;
    // orderService.confirmOrder is the sole write site and is tested separately).
    await pool().query("UPDATE members SET is_active = true WHERE member_code = $1", [memberCode])
    const res = await app.inject({
      method: 'DELETE', url: `/admin/network/${memberCode}`,
      headers: { authorization: `Bearer ${mgmtToken}` },
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).error).toMatch(/active/i)
  })

  it('409 — member with downline cannot be deleted', async () => {
    if (!mgmtToken) return
    const anchor = await registerAnchor('DelParentAnchor')
    const { memberCode: parentCode } = await registerLeaf(anchor.memberCode, 'DelParentLeaf')
    // Register a child under the leaf (parentCode becomes a parent_id)
    const { registerMember } = await import('../../src/services/placement.js')
    await registerMember({ sponsorCode: parentCode, name: 'DelChild', phone: uniquePhone(), email: uniqueEmail('delchild'), password: 'Test@12345' })
    const res = await app.inject({
      method: 'DELETE', url: `/admin/network/${parentCode}`,
      headers: { authorization: `Bearer ${mgmtToken}` },
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).error).toMatch(/referrals/i)
  })

  it('409 — member with a live (created) order cannot be deleted', async () => {
    if (!mgmtToken) return
    const { rows: prodRows } = await pool().query<{ id: number }>(
      "SELECT id FROM products WHERE active = true LIMIT 1",
    )
    if (!prodRows[0]) { console.warn('[deleteInactiveMember] no active product — skipping live-order guard test'); return }
    const anchor = await registerAnchor('DelLiveOrderAnchor')
    const { memberCode } = await registerLeaf(anchor.memberCode, 'DelLiveOrderLeaf')
    // Insert a 'created' order directly (bypassing the KYC gate for test isolation).
    // Must include all NOT NULL columns; price comes from the products row.
    const { rows: mRow2 } = await pool().query<{ id: string }>("SELECT id FROM members WHERE member_code=$1", [memberCode])
    const { rows: pRow } = await pool().query<{ base_price: string }>("SELECT base_price FROM products WHERE id=$1", [prodRows[0].id])
    await pool().query(
      `INSERT INTO orders (member_id, product_id, base_amount, gst_amount, total_amount, status, idempotency_key)
       VALUES ($1,$2,$3,0,$3,'created',$4)`,
      [mRow2[0].id, prodRows[0].id, pRow[0].base_price, `test-live-order-${Date.now()}`],
    )
    const res = await app.inject({
      method: 'DELETE', url: `/admin/network/${memberCode}`,
      headers: { authorization: `Bearer ${mgmtToken}` },
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).error).toMatch(/order in progress/i)
  })

  it('200 — clean inactive leaf is fully deleted and slot freed for re-registration', async () => {
    if (!mgmtToken) return
    const anchor = await registerAnchor('DelCleanAnchor')
    const { memberCode } = await registerLeaf(anchor.memberCode, 'DelCleanLeaf')

    // Confirm all the rows exist before deletion
    const { rows: before } = await pool().query<{ id: string }>(
      "SELECT id FROM members WHERE member_code = $1", [memberCode],
    )
    expect(before.length).toBe(1)
    const memberId = before[0].id
    const { rows: accBefore } = await pool().query<{ cnt: string }>(
      "SELECT COUNT(*) cnt FROM accounts WHERE owner_type='member' AND owner_id=$1", [memberId],
    )
    expect(Number(accBefore[0].cnt)).toBe(3) // wallet, deferred_bonus, withdrawable

    const res = await app.inject({
      method: 'DELETE', url: `/admin/network/${memberCode}`,
      headers: { authorization: `Bearer ${mgmtToken}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).ok).toBe(true)

    // All rows must be gone
    const { rows: after } = await pool().query("SELECT id FROM members WHERE member_code = $1", [memberCode])
    expect(after.length).toBe(0)
    const { rows: accAfter } = await pool().query("SELECT cnt FROM (SELECT COUNT(*) cnt FROM accounts WHERE owner_type='member' AND owner_id=$1) sub", [memberId])
    expect(Number(accAfter[0].cnt)).toBe(0)
    const { rows: ctrAfter } = await pool().query("SELECT cnt FROM (SELECT COUNT(*) cnt FROM member_counters WHERE member_id=$1) sub", [memberId])
    expect(Number(ctrAfter[0].cnt)).toBe(0)

    // The slot must be free: re-registering under the same anchor on the same leg succeeds
    const { registerMember } = await import('../../src/services/placement.js')
    const re = await registerMember({ sponsorCode: anchor.memberCode, name: 'DelReplacement', phone: uniquePhone(), email: uniqueEmail('delre'), password: 'Test@12345' })
    expect(re.memberId).toBeGreaterThan(0n)

    // Audit log written
    const { rows: audit } = await pool().query(
      "SELECT action FROM admin_audit_log WHERE action='delete_member' AND target_id=$1", [memberId],
    )
    expect(audit.length).toBe(1)
  })

  it('200 — cleans up rejected orders and kyc_documents automatically', async () => {
    if (!mgmtToken) return
    const { rows: prodRows } = await pool().query<{ id: number }>(
      "SELECT id FROM products WHERE active = true LIMIT 1",
    )
    if (!prodRows[0]) { console.warn('[deleteInactiveMember] no active product — skipping cleanup test'); return }
    const anchor = await registerAnchor('DelCleanupAnchor')
    const { memberCode } = await registerLeaf(anchor.memberCode, 'DelCleanupLeaf')
    const { rows: mRow } = await pool().query<{ id: string }>("SELECT id FROM members WHERE member_code = $1", [memberCode])
    const memberId = mRow[0].id

    // Rejected order + a KYC document row (no actual S3 — deleteObject no-ops when S3 is unconfigured).
    const { rows: pRow2 } = await pool().query<{ base_price: string }>("SELECT base_price FROM products WHERE id=$1", [prodRows[0].id])
    await pool().query(
      `INSERT INTO orders (member_id, product_id, base_amount, gst_amount, total_amount, status, idempotency_key)
       VALUES ($1,$2,$3,0,$3,'rejected',$4)`,
      [memberId, prodRows[0].id, pRow2[0].base_price, `test-rejected-order-${Date.now()}`],
    )
    await pool().query(
      "INSERT INTO kyc_documents (member_id, doc_type, s3_key) VALUES ($1,'pan','test/kyc/fake.jpg')",
      [memberId],
    )

    const res = await app.inject({
      method: 'DELETE', url: `/admin/network/${memberCode}`,
      headers: { authorization: `Bearer ${mgmtToken}` },
    })
    expect(res.statusCode).toBe(200)

    // Order and KYC doc must be gone
    const { rows: ordAfter } = await pool().query("SELECT id FROM orders WHERE member_id=$1", [memberId])
    expect(ordAfter.length).toBe(0)
    const { rows: kycAfter } = await pool().query("SELECT id FROM kyc_documents WHERE member_id=$1", [memberId])
    expect(kycAfter.length).toBe(0)
    // Member itself must be gone
    const { rows: mAfter } = await pool().query("SELECT id FROM members WHERE id=$1", [memberId])
    expect(mAfter.length).toBe(0)
  })
})
