/**
 * Integration tests for markDelivered() and unmarkDelivered() in services/orderService.ts.
 *
 * Verifies:
 *   markDelivered:
 *     (a) confirmed, undelivered order → rowCount 1, delivered_at set.
 *     (b) same order called again (idempotency) → rowCount 0, no data change.
 *     (c) non-confirmed order (paid) → rowCount 0.
 *   unmarkDelivered:
 *     (d) delivered order → rowCount 1, delivered_at is NULL again.
 *     (e) same order called again (idempotency) → rowCount 0.
 *     (f) confirmed but never-delivered order → rowCount 0.
 *
 * Requires: Postgres 16 running, migrations applied (including 044), root seeded.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { pool } from '../../src/lib/db.js'
import { markDelivered, unmarkDelivered } from '../../src/services/orderService.js'
import { registerAnchor } from './helpers.js'

const PRODUCT_ID = 1 // seeded by migration 003_commerce.sql (Starter Product)

let memberId: bigint
let actorId: string  // management or root member id — just needs to be a valid members.id

beforeAll(async () => {
  // Register a fresh anchor member to own the test orders.
  const anchor = await registerAnchor('MarkDeliveredTest')
  memberId = anchor.memberId

  // Use the root member (parent_id IS NULL, role <> 'management') as the actor.
  const { rows } = await pool().query<{ id: string }>(
    "SELECT id FROM members WHERE parent_id IS NULL AND role <> 'management' LIMIT 1",
  )
  if (!rows[0]) throw new Error('Root member not seeded — run npm run seed first')
  actorId = rows[0].id
})

afterAll(async () => {
  await pool().end().catch(() => null)
})

// ─── (a) + (b): confirmed order — success then idempotent no-op ─────────────

describe('markDelivered on a confirmed order', () => {
  let orderId: string

  beforeAll(async () => {
    const { rows } = await pool().query<{ id: string }>(
      `INSERT INTO orders (member_id, product_id, base_amount, gst_amount, total_amount,
                           idempotency_key, status)
       VALUES ($1, $2, 10000.00, 0.00, 10000.00, gen_random_uuid(), 'confirmed')
       RETURNING id`,
      [memberId, PRODUCT_ID],
    )
    orderId = rows[0].id
  })

  it('marks the order delivered and returns rowCount 1', async () => {
    const { rowCount } = await markDelivered(orderId, actorId)
    expect(rowCount).toBe(1)

    const { rows } = await pool().query<{ delivered_at: Date | null; delivered_by: string | null }>(
      'SELECT delivered_at, delivered_by FROM orders WHERE id = $1',
      [orderId],
    )
    expect(rows[0].delivered_at).not.toBeNull()
    expect(rows[0].delivered_by).toBe(actorId)
  })

  it('is idempotent — second call returns rowCount 0 without changing delivered_at', async () => {
    // Capture the delivered_at timestamp set by the first call.
    const { rows: before } = await pool().query<{ delivered_at: Date }>(
      'SELECT delivered_at FROM orders WHERE id = $1',
      [orderId],
    )
    const firstDeliveredAt = before[0].delivered_at

    const { rowCount } = await markDelivered(orderId, actorId)
    expect(rowCount).toBe(0)

    // delivered_at must be unchanged.
    const { rows: after } = await pool().query<{ delivered_at: Date }>(
      'SELECT delivered_at FROM orders WHERE id = $1',
      [orderId],
    )
    expect(after[0].delivered_at).toEqual(firstDeliveredAt)
  })
})

// ─── (c): non-confirmed order (paid) → rowCount 0 ───────────────────────────

describe('markDelivered on a paid (non-confirmed) order', () => {
  it('returns rowCount 0 and does not update the order', async () => {
    const { rows } = await pool().query<{ id: string }>(
      `INSERT INTO orders (member_id, product_id, base_amount, gst_amount, total_amount,
                           idempotency_key, status)
       VALUES ($1, $2, 10000.00, 0.00, 10000.00, gen_random_uuid(), 'paid')
       RETURNING id`,
      [memberId, PRODUCT_ID],
    )
    const paidOrderId = rows[0].id

    const { rowCount } = await markDelivered(paidOrderId, actorId)
    expect(rowCount).toBe(0)

    const { rows: check } = await pool().query<{ delivered_at: Date | null }>(
      'SELECT delivered_at FROM orders WHERE id = $1',
      [paidOrderId],
    )
    expect(check[0].delivered_at).toBeNull()
  })
})

// ─── (d) + (e): unmarkDelivered — success then idempotent no-op ─────────────

describe('unmarkDelivered on a delivered order', () => {
  let orderId: string

  beforeAll(async () => {
    // Insert a confirmed order and immediately mark it delivered.
    const { rows } = await pool().query<{ id: string }>(
      `INSERT INTO orders (member_id, product_id, base_amount, gst_amount, total_amount,
                           idempotency_key, status)
       VALUES ($1, $2, 10000.00, 0.00, 10000.00, gen_random_uuid(), 'confirmed')
       RETURNING id`,
      [memberId, PRODUCT_ID],
    )
    orderId = rows[0].id
    await markDelivered(orderId, actorId)
  })

  it('clears delivered_at and returns rowCount 1', async () => {
    const { rowCount } = await unmarkDelivered(orderId)
    expect(rowCount).toBe(1)

    const { rows } = await pool().query<{ delivered_at: Date | null; delivered_by: string | null }>(
      'SELECT delivered_at, delivered_by FROM orders WHERE id = $1',
      [orderId],
    )
    expect(rows[0].delivered_at).toBeNull()
    expect(rows[0].delivered_by).toBeNull()
  })

  it('is idempotent — second call returns rowCount 0', async () => {
    const { rowCount } = await unmarkDelivered(orderId)
    expect(rowCount).toBe(0)
  })
})

// ─── (f): unmarkDelivered on a never-delivered confirmed order → rowCount 0 ──

describe('unmarkDelivered on a confirmed but never-delivered order', () => {
  it('returns rowCount 0', async () => {
    const { rows } = await pool().query<{ id: string }>(
      `INSERT INTO orders (member_id, product_id, base_amount, gst_amount, total_amount,
                           idempotency_key, status)
       VALUES ($1, $2, 10000.00, 0.00, 10000.00, gen_random_uuid(), 'confirmed')
       RETURNING id`,
      [memberId, PRODUCT_ID],
    )
    const neverDeliveredId = rows[0].id

    const { rowCount } = await unmarkDelivered(neverDeliveredId)
    expect(rowCount).toBe(0)
  })
})
