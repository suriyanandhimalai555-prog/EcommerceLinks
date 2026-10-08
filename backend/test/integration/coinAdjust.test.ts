/**
 * Integration tests for coinService.adjustMemberCoins — DB-level.
 *
 * Verifies:
 *  (a) positive delta increases total correctly
 *  (b) delta that would make balance negative is rejected (409) and leaves no row
 *  (c) exact-zero deduction (floor) is accepted
 *  (d) each accepted call writes a coin_adjustments row and an admin_audit_log row
 *  (e) getMemberCoinTotal includes both grants and adjustments
 *
 * Requires: migrations applied (npm run migrate), root seeded.
 *
 * Cleanup: afterAll deletes the test member in FK-safe order.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { pool } from '../../src/lib/db.js'
import { registerAnchor, uniqueEmail } from './helpers.js'
import {
  adjustMemberCoins,
  getMemberCoinTotal,
} from '../../src/services/coinService.js'

let memberId: string
let actorId: string   // use the same anchor as the actor (management check is route-level)

beforeAll(async () => {
  // Register a fresh test member with a fresh anchor as both the subject and actor.
  const { memberId: mid } = await registerAnchor('CoinAdjTest')
  memberId = String(mid)

  // Use a second fresh anchor as the actor (simulates the management account id).
  const { memberId: aid } = await registerAnchor('CoinAdjActor')
  actorId = String(aid)

  // Seed one campaign grant row (250 coins) so the starting total is not zero.
  // We need an order FK; use a fake order number that won't clash.
  // Insert a minimal orders row first.
  const { rows: oRows } = await pool().query<{ id: string }>(
    `INSERT INTO orders
       (member_id, product_id, base_amount, gst_amount, total_amount, idempotency_key, status)
     VALUES ($1, (SELECT id FROM products LIMIT 1), 10000.00, 0.00, 10000.00,
             gen_random_uuid(), 'confirmed')
     RETURNING id`,
    [memberId],
  )
  await pool().query(
    `INSERT INTO avg_coin_grants (member_id, order_id, coins, package_value_paise)
     VALUES ($1, $2, 250, 3000000)`,
    [memberId, oRows[0].id],
  )
})

afterAll(async () => {
  if (!memberId) return
  // FK-safe order: dependent rows first
  await pool().query('DELETE FROM coin_adjustments WHERE member_id IN ($1,$2)', [memberId, actorId])
  await pool().query('DELETE FROM admin_audit_log  WHERE target_id::text IN ($1,$2)', [memberId, actorId])
  await pool().query('DELETE FROM avg_coin_grants  WHERE member_id = $1', [memberId])
  await pool().query('DELETE FROM orders           WHERE member_id = $1', [memberId])
  await pool().query('DELETE FROM member_counters  WHERE member_id IN ($1,$2)', [memberId, actorId])
  // wallet_balances references accounts — delete balances first
  await pool().query(
    `DELETE FROM wallet_balances
     WHERE account_id IN (
       SELECT id FROM accounts WHERE owner_id IN ($1,$2) AND owner_type='member'
     )`,
    [memberId, actorId],
  )
  await pool().query(
    `DELETE FROM accounts WHERE owner_id IN ($1,$2) AND owner_type='member'`,
    [memberId, actorId],
  )
  await pool().query('DELETE FROM members WHERE id IN ($1,$2)', [memberId, actorId])
})

describe('coinService.adjustMemberCoins', () => {
  it('(a) +100 brings total from 250 to 350', async () => {
    const newTotal = await adjustMemberCoins(memberId, actorId, 100, 'Test add')
    expect(newTotal).toBe(350)

    const fetched = await getMemberCoinTotal(memberId)
    expect(fetched).toBe(350)
  })

  it('(b) −500 is rejected when balance is only 350', async () => {
    await expect(
      adjustMemberCoins(memberId, actorId, -500, 'Test over-deduct'),
    ).rejects.toMatchObject({ statusCode: 409 })

    // No new row inserted
    const { rows } = await pool().query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM coin_adjustments
       WHERE member_id = $1 AND delta = -500`,
      [memberId],
    )
    expect(Number(rows[0].cnt)).toBe(0)
  })

  it('(c) −350 brings total exactly to 0 (floor allowed)', async () => {
    const newTotal = await adjustMemberCoins(memberId, actorId, -350, 'Test floor deduct')
    expect(newTotal).toBe(0)

    const fetched = await getMemberCoinTotal(memberId)
    expect(fetched).toBe(0)
  })

  it('(d) accepted adjustments each write a coin_adjustments row and admin_audit_log row', async () => {
    const { rows: adjRows } = await pool().query<{ delta: string }>(
      `SELECT delta FROM coin_adjustments WHERE member_id = $1 ORDER BY created_at`,
      [memberId],
    )
    // Two accepted: +100 and −350 (the −500 was rejected and left no row)
    expect(adjRows.map((r) => Number(r.delta))).toEqual([100, -350])

    const { rows: auditRows } = await pool().query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM admin_audit_log
       WHERE target_id = $1 AND action = 'coin_adjustment'`,
      [memberId],
    )
    expect(Number(auditRows[0].cnt)).toBe(2)
  })

  it('(e) getMemberCoinTotal sums grants + adjustments correctly', async () => {
    // After (a) +100 and (c) −350: grants=250, adjustments=100+(−350)=−250; total=0
    const total = await getMemberCoinTotal(memberId)
    expect(total).toBe(0)
  })
})
