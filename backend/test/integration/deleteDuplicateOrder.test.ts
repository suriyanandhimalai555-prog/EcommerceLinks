/**
 * Integration tests for deleteDuplicateOrder() in services/orderService.ts.
 *
 * Verifies:
 *   (a) happy path — deletes a genuine 2nd confirmed order; order + proof rows gone,
 *       audit log written with full before_state; money tables untouched.
 *   (b) guard: refuses the member's first (activating) confirmed order (409).
 *   (c) guard: refuses a non-confirmed (paid) order (409).
 *   (d) guard: refuses an upgrade order (upgrade_to_value_paise set) (409).
 *   (e) guard: refuses an upgrade delivery leg (source_upgrade_order_id set) (409).
 *   (f) guard: refuses an order with an avg_coin_grants row (409).
 *   (g) guard: refuses a missing order (404).
 *   (h) money-safety: is_active, activated_at, package_value_paise, member_counters,
 *       pairs, pair_accruals, wallet/ledger balances are all unchanged after deletion.
 *
 * Requires: Postgres running, migrations applied (including 025, 044, 046, 050),
 * root + management seeded (npm run seed && npm run seed:management).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { pool } from '../../src/lib/db.js'
import { deleteDuplicateOrder } from '../../src/services/orderService.js'
import { registerAnchor } from './helpers.js'

const PRODUCT_ID = 1 // Starter Product (₹10k), seeded by migration 003

let memberId: bigint
let actorId: string   // management or root — just needs to be a valid members.id

/** Helper: insert a confirmed order for memberId without touching the pipeline. */
async function insertConfirmed(opts: { upgradeToValuePaise?: number; sourceUpgradeOrderId?: bigint } = {}): Promise<string> {
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO orders
       (member_id, product_id, base_amount, gst_amount, total_amount,
        idempotency_key, status, confirmed_at, upgrade_to_value_paise, source_upgrade_order_id)
     VALUES ($1, $2, 10000.00, 0.00, 10000.00, gen_random_uuid(), 'confirmed', now(), $3, $4)
     RETURNING id`,
    [memberId, PRODUCT_ID, opts.upgradeToValuePaise ?? null, opts.sourceUpgradeOrderId ?? null],
  )
  return rows[0].id
}

/** Helper: snapshot all money-relevant values for memberId. */
async function moneySnapshot() {
  const { rows: m } = await pool().query<{
    is_active: boolean
    activated_at: string | null
    package_value_paise: string
  }>(
    'SELECT is_active, activated_at, package_value_paise FROM members WHERE id = $1',
    [memberId],
  )
  const { rows: mc } = await pool().query<{ left_active: string; right_active: string }>(
    'SELECT left_active, right_active FROM member_counters WHERE member_id = $1',
    [memberId],
  )
  const { rows: pairs } = await pool().query<{ cnt: string }>(
    'SELECT COUNT(*) AS cnt FROM pairs WHERE member_id = $1',
    [memberId],
  )
  const { rows: pa } = await pool().query<{ cnt: string }>(
    'SELECT COUNT(*) AS cnt FROM pair_accruals WHERE beneficiary_id = $1',
    [memberId],
  )
  // Wallet balance via accounts + wallet_balances (the double-entry ledger schema).
  const { rows: wb } = await pool().query<{ balance: string }>(
    `SELECT wb.balance
       FROM wallet_balances wb
       JOIN accounts a ON a.id = wb.account_id
      WHERE a.owner_type = 'member' AND a.owner_id = $1 AND a.kind = 'wallet'`,
    [memberId],
  )
  return {
    isActive: m[0]?.is_active ?? null,
    activatedAt: m[0]?.activated_at ?? null,
    packageValuePaise: m[0]?.package_value_paise ?? '0',
    leftActive: mc[0]?.left_active ?? '0',
    rightActive: mc[0]?.right_active ?? '0',
    pairsCount: pairs[0]?.cnt ?? '0',
    pairAccrualsCount: pa[0]?.cnt ?? '0',
    walletBalance: wb[0]?.balance ?? '0.00',
  }
}

beforeAll(async () => {
  const anchor = await registerAnchor('DelDupOrderTest')
  memberId = anchor.memberId

  const { rows } = await pool().query<{ id: string }>(
    "SELECT id FROM members WHERE parent_id IS NULL AND role <> 'management' LIMIT 1",
  )
  if (!rows[0]) throw new Error('Root member not seeded — run npm run seed first')
  actorId = rows[0].id
})

afterAll(async () => {
  await pool().end().catch(() => null)
})

// ─── (a) Happy path + (h) money-safety ───────────────────────────────────────

describe('deleteDuplicateOrder — happy path', () => {
  let firstOrderId: string
  let secondOrderId: string
  let proofKey: string

  beforeAll(async () => {
    firstOrderId  = await insertConfirmed()
    secondOrderId = await insertConfirmed()

    // Attach a fake proof row to the second order to exercise proof cleanup.
    proofKey = `payment-proofs/${memberId}/fake-proof-${Date.now()}.jpg`
    await pool().query(
      'INSERT INTO order_payment_proofs (order_id, s3_key) VALUES ($1, $2)',
      [secondOrderId, proofKey],
    )
  })

  it('(h) money tables are identical before and after deletion', async () => {
    const before = await moneySnapshot()
    await deleteDuplicateOrder(actorId, secondOrderId)
    const after = await moneySnapshot()
    expect(after).toEqual(before)
  })

  it('(a) order row is gone after deletion', async () => {
    const { rows } = await pool().query('SELECT id FROM orders WHERE id = $1', [secondOrderId])
    expect(rows).toHaveLength(0)
  })

  it('(a) proof row is gone after deletion', async () => {
    const { rows } = await pool().query(
      'SELECT id FROM order_payment_proofs WHERE order_id = $1',
      [secondOrderId],
    )
    expect(rows).toHaveLength(0)
  })

  it('(a) audit log row written with correct action and before_state', async () => {
    const { rows } = await pool().query<{
      action: string
      target_type: string
      target_id: string
      before_state: Record<string, unknown>
      after_state: unknown
    }>(
      `SELECT action, target_type, target_id, before_state, after_state
         FROM admin_audit_log
        WHERE action = 'order_delete' AND target_id = $1
        ORDER BY id DESC LIMIT 1`,
      [secondOrderId],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].action).toBe('order_delete')
    expect(rows[0].target_type).toBe('order')
    expect(rows[0].target_id).toBe(secondOrderId)
    expect(rows[0].after_state).toBeNull()
    // before_state must include the proof key for reconstructability.
    const bs = rows[0].before_state
    expect(bs.id).toBe(secondOrderId)
    expect(bs.status).toBe('confirmed')
    expect((bs.proofKeys as string[])).toContain(proofKey)
  })

  it('(a) first order still exists (was not touched)', async () => {
    const { rows } = await pool().query('SELECT id FROM orders WHERE id = $1', [firstOrderId])
    expect(rows).toHaveLength(1)
  })
})

// ─── (b) Guard: refuses the activating (first) order ─────────────────────────

describe('deleteDuplicateOrder — guard: refuses first order', () => {
  it('throws 409 when attempting to delete the earliest confirmed order', async () => {
    // Create a standalone member with a single confirmed order.
    const anchor = await registerAnchor('DelDupFirst')
    const oid = await pool().query<{ id: string }>(
      `INSERT INTO orders (member_id, product_id, base_amount, gst_amount, total_amount,
                           idempotency_key, status, confirmed_at)
       VALUES ($1, $2, 10000.00, 0.00, 10000.00, gen_random_uuid(), 'confirmed', now())
       RETURNING id`,
      [anchor.memberId, PRODUCT_ID],
    )
    const firstId = oid.rows[0].id
    await expect(deleteDuplicateOrder(actorId, firstId)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('first confirmed order'),
    })
  })
})

// ─── (c) Guard: refuses non-confirmed orders ──────────────────────────────────

describe('deleteDuplicateOrder — guard: refuses non-confirmed order', () => {
  it('throws 409 for a paid (non-confirmed) order', async () => {
    const { rows } = await pool().query<{ id: string }>(
      `INSERT INTO orders (member_id, product_id, base_amount, gst_amount, total_amount,
                           idempotency_key, status)
       VALUES ($1, $2, 10000.00, 0.00, 10000.00, gen_random_uuid(), 'paid')
       RETURNING id`,
      [memberId, PRODUCT_ID],
    )
    await expect(deleteDuplicateOrder(actorId, rows[0].id)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('confirmed'),
    })
  })
})

// ─── (d) Guard: refuses upgrade order ────────────────────────────────────────

describe('deleteDuplicateOrder — guard: refuses upgrade order', () => {
  it('throws 409 for an order with upgrade_to_value_paise set', async () => {
    const upgradeId = await insertConfirmed({ upgradeToValuePaise: 3_000_000 })
    await expect(deleteDuplicateOrder(actorId, upgradeId)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('promotional or upgrade'),
    })
  })
})

// ─── (e) Guard: refuses upgrade delivery leg ─────────────────────────────────

describe('deleteDuplicateOrder — guard: refuses upgrade delivery leg', () => {
  it('throws 409 for an order with source_upgrade_order_id set', async () => {
    // Need a real order to reference as source.
    const srcId = await insertConfirmed()
    const deliveryId = await insertConfirmed({ sourceUpgradeOrderId: BigInt(srcId) })
    await expect(deleteDuplicateOrder(actorId, deliveryId)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('promotional or upgrade'),
    })
  })
})

// ─── (f) Guard: refuses coin-granting order ───────────────────────────────────

describe('deleteDuplicateOrder — guard: refuses order that granted coins', () => {
  it('throws 409 when avg_coin_grants row exists for the order', async () => {
    const coinOrderId = await insertConfirmed()
    // Insert a fake coin grant row for this order.
    await pool().query(
      `INSERT INTO avg_coin_grants (member_id, order_id, coins, package_value_paise)
       VALUES ($1, $2, 100, 1000000)
       ON CONFLICT (order_id) DO NOTHING`,
      [memberId, coinOrderId],
    )
    await expect(deleteDuplicateOrder(actorId, coinOrderId)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('campaign coins'),
    })
  })
})

// ─── (g) Guard: 404 for missing order ────────────────────────────────────────

describe('deleteDuplicateOrder — guard: 404 for non-existent order', () => {
  it('throws 404 for an order id that does not exist', async () => {
    await expect(deleteDuplicateOrder(actorId, '999999999')).rejects.toMatchObject({
      statusCode: 404,
    })
  })
})
