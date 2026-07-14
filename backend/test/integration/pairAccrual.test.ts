/**
 * Integration tests for the 2-Direct Pair Matching income path (migration 020).
 *
 * Model: a pair completes at member P when both of P's direct referrals are
 * active. ₹1000 accrues to P and to every placement ancestor of P; accruals
 * stay pending until the earner qualifies (3-gen gate), then release
 * retroactively through creditBonusWithCap (per-cutoff cap applies).
 *
 * Requires: Postgres 16 + Redis 7 running, migrations applied, root seeded.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { randomUUID } from 'crypto'
import { pool, withTxn } from '../../src/lib/db.js'
import { registerMember } from '../../src/services/placement.js'
import { evaluateQualification } from '../../src/services/qualification.js'
import { detectPairCompletion } from '../../src/workers/pairComplete.js'
import { fanOutPairBonus } from '../../src/workers/fanout.js'
import { accruePairBonus, releasePendingBonuses } from '../../src/workers/ledger.js'
import { reconcile } from '../../src/workers/reconciler.js'
import { ensureCutoffExists } from '../../src/workers/cutoff.js'
import { toPaise, fromPaise } from '../../src/lib/money.js'
import { CFG } from '../../src/config.js'
import type { PairCompleted, PendingBonusReleaseRequested } from '../../src/events/types.js'
import { registerAnchor, uniqueEmail, uniquePhone } from './helpers.js'

const BONUS = BigInt(CFG.PAIR_BONUS_PAISE) // 100_000n = ₹1,000

async function register(sponsorCode: string, name: string) {
  return registerMember({
    sponsorCode, name, phone: uniquePhone('9'), email: uniqueEmail('pa'), password: 'Test@1234',
  })
}

/** Activate directly (as T9 does) and run pair-completion detection. */
async function activate(memberId: bigint) {
  await pool().query(
    'UPDATE members SET is_active=TRUE, activated_at=now() WHERE id=$1', [memberId],
  )
  await detectPairCompletion(memberId, randomUUID())
}

async function walletPaise(memberId: bigint): Promise<bigint> {
  const { rows } = await pool().query<{ balance: string }>(
    `SELECT wb.balance FROM wallet_balances wb
      JOIN accounts a ON a.id = wb.account_id
     WHERE a.owner_id=$1 AND a.kind='wallet'`, [memberId],
  )
  return toPaise(rows[0]?.balance ?? '0')
}

/** Feed the (single) PairCompleted event for `ownerId` through the fanout + accrual handlers. */
async function deliverAccruals(ownerId: bigint) {
  const { rows } = await pool().query<{ payload: PairCompleted }>(
    `SELECT payload FROM events_outbox WHERE event_type='PairCompleted' AND aggregate_id=$1`,
    [ownerId],
  )
  expect(rows.length).toBe(1)
  const { rows: m } = await pool().query<{ placement_path: string[] }>(
    'SELECT placement_path FROM members WHERE id=$1', [ownerId],
  )
  const accruals = fanOutPairBonus(rows[0].payload, (m[0].placement_path ?? []).map(BigInt))
  for (const a of accruals) await accruePairBonus(a)
}

/** Feed the PendingBonusReleaseRequested written by evaluateQualification. */
async function deliverRelease(memberId: bigint) {
  const { rows } = await pool().query<{ payload: PendingBonusReleaseRequested }>(
    `SELECT payload FROM events_outbox
      WHERE event_type='PendingBonusReleaseRequested' AND aggregate_id=$1`,
    [memberId],
  )
  expect(rows.length).toBeGreaterThanOrEqual(1)
  for (const r of rows) await releasePendingBonuses(r.payload)
}

// The user-confirmed ground truth: 02 → 03(L),04(R); 03 → 05(L),06(R).
// After 05+06 activate: 02 = ₹2000, 03 = ₹0 pending ₹1000; a buyer under 05
// qualifies 03 and releases his ₹1000.
describe('Worked example – recursive pair bonus with qualification gate', () => {
  it('02 earns ₹2000, 03 pends then releases ₹1000', async () => {
    const ts = Date.now().toString().slice(-6)
    const { memberId: m02, memberCode: c02 } = await registerAnchor(`WE02x${ts}`)
    const { memberId: m03, memberCode: c03 } = await register(c02, `WE03x${ts}`)
    const { memberId: m04 } = await register(c02, `WE04x${ts}`)
    const { memberId: m05, memberCode: c05 } = await register(c03, `WE05x${ts}`)
    const { memberId: m06 } = await register(c03, `WE06x${ts}`)

    await activate(m02)
    await activate(m03)
    await activate(m04) // completes 02's own pair (03,04)
    await deliverAccruals(m02)

    // 02 is not yet qualified → accrual pending, wallet untouched
    expect(await walletPaise(m02)).toBe(0n)
    const { rows: pend02 } = await pool().query<{ status: string }>(
      `SELECT status FROM pair_accruals pa JOIN pairs p ON p.id = pa.pair_id
        WHERE p.member_id=$1 AND pa.beneficiary_id=$1`, [m02],
    )
    expect(pend02[0].status).toBe('pending')

    // 05 activates → 02 qualifies (child 03 + grandchild 05) → own pair releases
    await activate(m05)
    const q02 = await withTxn(async (c) => evaluateQualification(m02, c))
    expect(q02).toBe(true)
    await deliverRelease(m02)
    expect(await walletPaise(m02)).toBe(BONUS) // ₹1,000

    // 06 activates → pair completes at 03 → 03 pends, 02 (qualified) paid now
    await activate(m06)
    await deliverAccruals(m03)
    expect(await walletPaise(m02)).toBe(2n * BONUS) // ₹2,000
    expect(await walletPaise(m03)).toBe(0n)
    const { rows: pend03 } = await pool().query<{ status: string }>(
      `SELECT status FROM pair_accruals pa JOIN pairs p ON p.id = pa.pair_id
        WHERE p.member_id=$1 AND pa.beneficiary_id=$1`, [m03],
    )
    expect(pend03[0].status).toBe('pending')

    // someone under 05 buys → 03 qualifies → held ₹1000 releases retroactively
    const { memberId: m07 } = await register(c05, `WE07x${ts}`)
    await activate(m07)
    const q03 = await withTxn(async (c) => evaluateQualification(m03, c))
    expect(q03).toBe(true)
    await deliverRelease(m03)
    expect(await walletPaise(m03)).toBe(BONUS)
    const { rows: rel03 } = await pool().query<{ status: string; released_at: string }>(
      `SELECT status, released_at FROM pair_accruals pa JOIN pairs p ON p.id = pa.pair_id
        WHERE p.member_id=$1 AND pa.beneficiary_id=$1`, [m03],
    )
    expect(rel03[0].status).toBe('released')
    expect(rel03[0].released_at).not.toBeNull()
  })
})

describe('Pair completion – concurrency and idempotency', () => {
  it('concurrent sibling activations produce exactly one pair and one event', async () => {
    const ts = (Date.now() + 3).toString().slice(-6)
    const { memberId: pId, memberCode: pCode } = await registerAnchor(`PCcx${ts}`)
    const { memberId: lId } = await register(pCode, `PCLx${ts}`)
    const { memberId: rId } = await register(pCode, `PCRx${ts}`)

    await pool().query(
      'UPDATE members SET is_active=TRUE, activated_at=now() WHERE id = ANY($1)',
      [[String(lId), String(rId)]],
    )
    await Promise.all([
      detectPairCompletion(lId, randomUUID()),
      detectPairCompletion(rId, randomUUID()),
    ])

    const { rows: pairs } = await pool().query(
      'SELECT id FROM pairs WHERE member_id=$1', [pId],
    )
    expect(pairs.length).toBe(1)
    const { rows: events } = await pool().query(
      `SELECT event_id FROM events_outbox WHERE event_type='PairCompleted' AND aggregate_id=$1`,
      [pId],
    )
    expect(events.length).toBe(1)

    // re-delivery (fresh event id, same activation) does not fire again
    await detectPairCompletion(lId, randomUUID())
    const { rows: after } = await pool().query(
      `SELECT event_id FROM events_outbox WHERE event_type='PairCompleted' AND aggregate_id=$1`,
      [pId],
    )
    expect(after.length).toBe(1)
  })

  it('accrue + release paths share one idempotency key → single ledger txn', async () => {
    const ts = (Date.now() + 5).toString().slice(-6)
    const { memberId: pId, memberCode: pCode } = await registerAnchor(`IDcx${ts}`)
    const { memberId: lId } = await register(pCode, `IDLx${ts}`)
    const { memberId: rId } = await register(pCode, `IDRx${ts}`)
    await activate(lId)
    await activate(rId)

    // beneficiary already qualified → accruePairBonus releases immediately
    await pool().query('UPDATE members SET is_qualified=TRUE WHERE id=$1', [pId])
    const { rows: pe } = await pool().query<{ payload: PairCompleted }>(
      `SELECT payload FROM events_outbox WHERE event_type='PairCompleted' AND aggregate_id=$1`, [pId],
    )
    const accrual = fanOutPairBonus(pe[0].payload, [])[0] // beneficiary = pair owner
    await accruePairBonus(accrual)
    expect(await walletPaise(pId)).toBe(BONUS)

    // replay same event → processed_events skip
    await accruePairBonus(accrual)
    // synthetic retroactive release for the same member → no pending rows, no double pay
    await releasePendingBonuses({
      event_id: randomUUID(), event_type: 'PendingBonusReleaseRequested',
      occurred_at: new Date().toISOString(), schema_version: 1, member_id: Number(pId),
    })
    expect(await walletPaise(pId)).toBe(BONUS)

    const { rows: txns } = await pool().query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM ledger_txns WHERE idempotency_key=$1`,
      [`pairbonus:${pe[0].payload.pair_id}:${pId}`],
    )
    expect(Number(txns[0].count)).toBe(1)
  })
})

describe('Retroactive release respects the per-cutoff cap', () => {
  it('₹500 headroom + two ₹1000 accruals → wallet +500, deferred +1500', async () => {
    await ensureCutoffExists()
    const ts = (Date.now() + 9).toString().slice(-6)
    const { memberId: bId, memberCode: bCode } = await registerAnchor(`CApx${ts}`)
    const { memberId: lId } = await register(bCode, `CALx${ts}`)
    const { memberId: rId } = await register(bCode, `CARx${ts}`)
    await activate(lId)
    await activate(rId) // b's own pair exists now

    // a second synthetic pair below b (owner = l; child ids only need valid FKs)
    const { rows: p2 } = await pool().query<{ id: string }>(
      `INSERT INTO pairs (member_id, sequence_no, left_member_id, right_member_id, bonus_amount)
       VALUES ($1,1,$2,$3,$4) RETURNING id`,
      [lId, rId, bId, fromPaise(BONUS)],
    )
    const { rows: p1 } = await pool().query<{ id: string }>(
      'SELECT id FROM pairs WHERE member_id=$1', [bId],
    )
    await pool().query(
      `INSERT INTO pair_accruals (pair_id, beneficiary_id, amount) VALUES ($1,$3,$4),($2,$3,$4)`,
      [p1[0].id, p2[0].id, bId, fromPaise(BONUS)],
    )

    // consume all but ₹500 of this cutoff's cap
    const { rows: co } = await pool().query<{ id: string }>(
      `SELECT id FROM cutoffs WHERE status='open' LIMIT 1`,
    )
    const capPaise = BigInt(CFG.CUTOFF_CAP_PAISE)
    await pool().query(
      `INSERT INTO cutoff_earnings (member_id, cutoff_id, earned) VALUES ($1,$2,$3)
       ON CONFLICT (member_id, cutoff_id) DO UPDATE SET earned = EXCLUDED.earned`,
      [bId, co[0].id, fromPaise(capPaise - 50_000n)], // ₹99,500 earned
    )

    await pool().query('UPDATE members SET is_qualified=TRUE WHERE id=$1', [bId])
    await releasePendingBonuses({
      event_id: randomUUID(), event_type: 'PendingBonusReleaseRequested',
      occurred_at: new Date().toISOString(), schema_version: 1, member_id: Number(bId),
    })

    expect(await walletPaise(bId)).toBe(50_000n) // ₹500 fit under the cap
    const { rows: def } = await pool().query<{ balance: string }>(
      `SELECT wb.balance FROM wallet_balances wb
        JOIN accounts a ON a.id = wb.account_id
       WHERE a.owner_id=$1 AND a.kind='deferred_bonus'`, [bId],
    )
    expect(toPaise(def[0].balance)).toBe(150_000n) // ₹1,500 deferred
    const { rows: ce } = await pool().query<{ earned: string }>(
      `SELECT earned FROM cutoff_earnings WHERE member_id=$1 AND cutoff_id=$2`,
      [bId, co[0].id],
    )
    expect(toPaise(ce[0].earned)).toBe(capPaise) // earned pinned at the cap
    const { rows: released } = await pool().query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM pair_accruals WHERE beneficiary_id=$1 AND status='released'`,
      [bId],
    )
    expect(Number(released[0].count)).toBe(2)
  })
})

describe('Reconciler – accrual invariants hold after the pipeline runs', () => {
  it('no accrual_release_drift / accrual_pending_drift alerts', async () => {
    const alerts = await reconcile()
    const accrualAlerts = alerts.filter(
      (a) => a.type === 'accrual_release_drift' || a.type === 'accrual_pending_drift',
    )
    expect(accrualAlerts).toEqual([])
  })
})

afterAll(async () => {
  await pool().end().catch(() => null)
})
