/**
 * Integration tests for DELETE /admin/products/:id — management-only hard-delete.
 *
 * Requires: Postgres 16 running, migrations applied, root seeded,
 * and management seeded (npm run seed + npm run seed:management).
 *
 * Guards tested:
 *   400 — non-numeric :id param
 *   403 — non-management caller (regular member, requireAdmin gate)
 *   404 — product id does not exist
 *   409 — product has orders in any status (FK constraint blocks hard-delete regardless)
 *   409 — product with only rejected orders also blocked (rejected orders are not dead:
 *          createOrder dedup reuses them; FK enforces the block at the DB level)
 *   200 — product with zero orders is deleted successfully
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { app } from '../../src/api/server.js'
import { pool } from '../../src/lib/db.js'

function signToken(memberId: bigint, memberCode: string, name: string): string {
  return app.jwt.sign({ sub: String(memberId), code: memberCode, name })
}

async function getManagementAccount(): Promise<{ id: bigint; memberCode: string } | null> {
  const { rows } = await pool().query<{ id: string; member_code: string }>(
    "SELECT id, member_code FROM members WHERE role = 'management' LIMIT 1",
  )
  if (!rows[0]) return null
  return { id: BigInt(rows[0].id), memberCode: rows[0].member_code }
}

async function createTestProduct(mgmtToken: string, name: string): Promise<number> {
  const res = await app.inject({
    method: 'POST',
    url: '/admin/products',
    headers: { authorization: `Bearer ${mgmtToken}` },
    payload: {
      name,
      description: 'Product for delete integration tests',
      basePricePaise: 100000,
      active: true,
      imageKeys: [],
    },
  })
  expect(res.statusCode).toBe(201)
  return JSON.parse(res.body).id
}

let mgmtToken: string
let regularToken: string

beforeAll(async () => {
  await app.ready()

  const mgmt = await getManagementAccount()
  if (!mgmt) {
    console.warn('[product-delete] management account not found — run npm run seed:management first')
    return
  }
  mgmtToken = signToken(mgmt.id, mgmt.memberCode, 'AVG Management')

  const { rows: memberRows } = await pool().query<{ id: string; member_code: string }>(
    "SELECT id, member_code FROM members WHERE role = 'member' LIMIT 1",
  )
  if (memberRows[0]) {
    regularToken = signToken(BigInt(memberRows[0].id), memberRows[0].member_code, 'Regular Member')
  }
})

describe('DELETE /admin/products/:id', () => {
  it('400 — non-numeric id param', async () => {
    if (!mgmtToken) return
    const res = await app.inject({
      method: 'DELETE',
      url: '/admin/products/not-a-number',
      headers: { authorization: `Bearer ${mgmtToken}` },
    })
    expect(res.statusCode).toBe(400)
  })

  it('403 — non-management caller', async () => {
    if (!mgmtToken || !regularToken) return
    const res = await app.inject({
      method: 'DELETE',
      url: '/admin/products/1',
      headers: { authorization: `Bearer ${regularToken}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('404 — non-existent product', async () => {
    if (!mgmtToken) return
    const res = await app.inject({
      method: 'DELETE',
      url: '/admin/products/999999',
      headers: { authorization: `Bearer ${mgmtToken}` },
    })
    expect(res.statusCode).toBe(404)
  })

  it('409 — product has orders (confirmed status)', async () => {
    if (!mgmtToken) return
    const productId = await createTestProduct(mgmtToken, `Del-HasOrders-${Date.now()}`)
    const { rows: memberRows } = await pool().query<{ id: string }>(
      "SELECT id FROM members WHERE role = 'member' LIMIT 1",
    )
    expect(memberRows[0]).toBeTruthy()
    await pool().query(
      `INSERT INTO orders (member_id, product_id, base_amount, gst_amount, total_amount, idempotency_key, status)
       VALUES ($1, $2, 1000.00, 180.00, 1180.00, gen_random_uuid(), 'confirmed')`,
      [memberRows[0].id, productId],
    )

    const res = await app.inject({
      method: 'DELETE',
      url: `/admin/products/${productId}`,
      headers: { authorization: `Bearer ${mgmtToken}` },
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).error).toMatch(/order/)

    // Cleanup so the product doesn't pollute other tests.
    await pool().query('DELETE FROM orders WHERE product_id = $1', [productId])
    await pool().query('DELETE FROM products WHERE id = $1', [productId])
  })

  it('409 — product with only rejected orders is still blocked (FK enforces regardless of status)', async () => {
    if (!mgmtToken) return
    const productId = await createTestProduct(mgmtToken, `Del-RejectedOnly-${Date.now()}`)
    const { rows: memberRows } = await pool().query<{ id: string }>(
      "SELECT id FROM members WHERE role = 'member' LIMIT 1",
    )
    expect(memberRows[0]).toBeTruthy()
    // Rejected orders are not dead: createOrder dedup reuses them (status IN ('created','paid','rejected')).
    // The FK on orders.product_id (no CASCADE) also physically prevents deletion regardless.
    await pool().query(
      `INSERT INTO orders (member_id, product_id, base_amount, gst_amount, total_amount, idempotency_key, status, rejection_reason)
       VALUES ($1, $2, 1000.00, 180.00, 1180.00, gen_random_uuid(), 'rejected', 'Bad screenshot')`,
      [memberRows[0].id, productId],
    )

    const res = await app.inject({
      method: 'DELETE',
      url: `/admin/products/${productId}`,
      headers: { authorization: `Bearer ${mgmtToken}` },
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).error).toMatch(/order/)

    // Cleanup so the product doesn't pollute other tests.
    await pool().query('DELETE FROM orders WHERE product_id = $1', [productId])
    await pool().query('DELETE FROM products WHERE id = $1', [productId])
  })

  it('200 — product with zero orders is deleted and removed from DB', async () => {
    if (!mgmtToken) return
    const productId = await createTestProduct(mgmtToken, `Del-Clean-${Date.now()}`)

    const res = await app.inject({
      method: 'DELETE',
      url: `/admin/products/${productId}`,
      headers: { authorization: `Bearer ${mgmtToken}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).ok).toBe(true)

    const { rows: check } = await pool().query('SELECT id FROM products WHERE id = $1', [productId])
    expect(check.length).toBe(0)
  })
})
