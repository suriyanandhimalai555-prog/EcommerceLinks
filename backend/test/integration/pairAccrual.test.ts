/**
 * Integration tests for the carry-forward pair matching income model (v2, migration 038).
 *
 * Model: A pair completes at node N when BOTH N.left_active >= 1 AND N.right_active >= 1
 * under the cumulative carry-forward rule. ₹1000 accrues to N only (BR-7 — no fan-out).
 * Accruals stay pending until the earner qualifies (3-gen gate, BR-9), then release
 * retroactively. Cap overage on qualification-backlog release is DEFERRED to the
 * member's own deferred_bonus account (BR-13), not forfeited; ongoing overage is
 * forfeited as before (BR-12).
 *
 * Requires: Postgres 16 + Redis 7 running, migration 038 applied, root seeded.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { randomUUID } from 'crypto'
import { pool, withTxn } from '../../src/lib/db.js'
import { registerMember } from '../../src/services/placement.js'
import { evaluateQualification } from '../../src/services/qualification.js'
import { applyIncrements } from '../../src/workers/counterPair.js'
import { accruePairBonus, releasePendingBonuses } from '../../src/workers/ledger.js'
import { reconcile } from '../../src/workers/reconciler.js'
import { ensureCutoffExists } from '../../src/workers/cutoff.js'
import { toPaise, fromPaise } from '../../src/lib/money.js'
import { CFG } from '../../src/config.js'
import type { PairBonusAccrued, PendingBonusReleaseRequested } from '../../src/events/types.js'
import { registerAnchor, uniqueEmail, uniquePhone } from './helpers.js'

const BONUS = BigInt(CFG.PAIR_BONUS_PAISE) // 100_000n = ₹1,000

async function register(sponsorCode: string, name: string) {
  return registerMember({
    sponsorCode, name, phone: uniquePhone('9'), email: uniqueEmail('pa'), password: 'Test@1234',
  })
}

/**
 * v2 activate: set is_active, then send a CounterIncrement to each ancestor
 * (mirrors what fanout.ts + counterPair.ts do in production).
 */
async function activate(memberId: bigint) {
  await pool().query('UPDATE members SET is_active=TRUE, activated_at=now() WHERE id=$1', [memberId])
  const { rows: m } = await pool().query<{ placement_path: number[]; placement_sides: string[] }>(
    'SELECT placement_path, placement_sides FROM members WHERE id=$1', [memberId],
  )
  if (!m[0] || !m[0].placement_path?.length) return
  for (let i = 0; i < m[0].placement_path.length; i++) {
    const ancestorId = BigInt(m[0].placement_path[i])
    const side = m[0].placement_sides[i] as 'L' | 'R'
    const eventId = randomUUID()
    await applyIncrements(ancestorId, [{
      event_id: eventId, event_type: 'CounterIncrement',
      occurred_at: new Date().toISOString(), schema_version: 1,
      ancestor_id: Number(ancestorId), side, counter_type: 'active',
      source_member_id: Number(memberId), source_event_id: eventId,
    }])
  }
}

async function walletPaise(memberId: bigint): Promise<bigint> {
  const { rows } = await pool().query<{ balance: string }>(
    `SELECT wb.balance FROM wallet_balances wb
      JOIN accounts a ON a.id = wb.account_id
     WHERE a.owner_id=$1 AND a.kind='wallet'`, [memberId],
  )
  return toPaise(rows[0]?.balance ?? '0')
}

async function deferredPaise(memberId: bigint): Promise<bigint> {
  const { rows } = await pool().query<{ balance: string }>(
    `SELECT wb.balance FROM wallet_balances wb
      JOIN accounts a ON a.id = wb.account_id
     WHERE a.owner_id=$1 AND a.kind='deferred_bonus'`, [memberId],
  )
  return toPaise(rows[0]?.balance ?? '0')
}

/**
 * Deliver PairBonusAccrued events written by counterPair for a specific matching
 * node. Under v2, aggregate_id = beneficiary_id = the matching node itself (BR-7).
 */
async function deliverAccruals(matchingNodeId: bigint) {
  const { rows } = await pool().query<{ payload: PairBonusAccrued }>(
    `SELECT payload::jsonb AS payload FROM events_outbox
      WHERE event_type='PairBonusAccrued' AND aggregate_id=$1`,
    [matchingNodeId],
  )
  for (const r of rows) await accruePairBonus(r.payload)
}

/** Feed the PendingBonusReleaseRequested written by evaluateQualification. */
async function deliverRelease(memberId: bigint) {
  const { rows } = await pool().query<{ payload: PendingBonusReleaseRequested }>(
    `SELECT payload::jsonb AS payload FROM events_outbox
      WHERE event_type='PendingBonusReleaseRequested' AND aggregate_id=$1`,
    [memberId],
  )
  expect(rows.length).toBeGreaterThanOrEqual(1)
  for (const r of rows) await releasePendingBonuses(r.payload)
}

describe('v2: pair completes at matching node only (BR-7 — no fan-out)', () => {
  it('a pair at node N creates exactly one pair_accruals row for N, not for ancestors', async () => {
    await ensureCutoffExists()
    const ts = Date.now().toString().slice(-6)
    // Tree: A → L (left), R (right)
    const { memberId: aId, memberCode: aC } = await registerAnchor(`BR7Ax${ts}`)
    const { memberId: lId } = await register(aC, `BR7Lx${ts}`)
    const { memberId: rId } = await register(aC, `BR7Rx${ts}`)

    await activate(lId)
    await activate(rId) // A mints pair seq=1 (L vs R)

    // Exactly one PairBonusAccrued event in the outbox, for A (not for A's ancestors)
    const { rows: events } = await pool().query<{ payload: PairBonusAccrued }>(
      `SELECT payload::jsonb AS payload FROM events_outbox
        WHERE event_type='PairBonusAccrued' AND aggregate_id=$1`,
      [aId],
    )
    expect(events.length).toBe(1)
    expect(events[0].payload.beneficiary_id).toBe(Number(aId))

    // Deliver accruals to A; confirm it is pending (A not yet qualified)
    await deliverAccruals(aId)
    const { rows: acc } = await pool().query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM pair_accruals pa JOIN pairs p ON p.id = pa.pair_id
        WHERE p.member_id=$1 AND pa.beneficiary_id=$1`, [aId],
    )
    expect(Number(acc[0].count)).toBe(1)

    // A's ancestors received NO pair_accruals from A's pair
    const { rows: aRow } = await pool().query<{ placement_path: number[] }>(
      'SELECT placement_path FROM members WHERE id=$1', [aId],
    )
    for (const ancestorId of (aRow[0]?.placement_path ?? [])) {
      const { rows: ancAcc } = await pool().query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM pair_accruals pa JOIN pairs p ON p.id = pa.pair_id
          WHERE p.member_id=$1 AND pa.beneficiary_id=$1 AND pa.id > 0`,
        // Narrow to THIS specific pair: accruals where pair was minted at A
        // Ancestors earn from THEIR OWN pairs (via their own L/R counters),
        // not from A's pair — query any accrual for the ancestor from A's specific pair
        [ancestorId],
      )
      // Note: ancestors may legitimately have their OWN pair_accruals from prior test
      // data; we only assert A's specific pair id is not attributed to ancestors.
      const { rows: asPairs } = await pool().query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM pair_accruals WHERE pair_id IN
          (SELECT id FROM pairs WHERE member_id=$1) AND beneficiary_id=$2`,
        [aId, ancestorId],
      )
      expect(Number(asPairs[0].count)).toBe(0) // A's pair accrues to A only, not ancestor
    }
  })
})

describe('v2: worked example — pair matching + qualification gate', () => {
  it('node earns from own pair only; qualification gate holds and releases', async () => {
    await ensureCutoffExists()
    const ts = (Date.now() + 1).toString().slice(-6)
    // Tree: m02 → m03 (L), m04 (R); m03 → m05 (L), m06 (R)
    const { memberId: m02, memberCode: c02 } = await registerAnchor(`WE02x${ts}`)
    const { memberId: m03, memberCode: c03 } = await register(c02, `WE03x${ts}`)
    const { memberId: m04 } = await register(c02, `WE04x${ts}`)
    const { memberId: m05, memberCode: c05 } = await register(c03, `WE05x${ts}`)
    const { memberId: m06 } = await register(c03, `WE06x${ts}`)

    // m02 must be active to qualify
    await activate(m02)
    await activate(m03)
    await activate(m04) // m02 mints pair seq=1 (m03 vs m04)

    await deliverAccruals(m02)

    // m02 is not yet qualified → accrual pending, wallet untouched
    expect(await walletPaise(m02)).toBe(0n)
    const { rows: pend02 } = await pool().query<{ status: string }>(
      `SELECT status FROM pair_accruals pa JOIN pairs p ON p.id = pa.pair_id
        WHERE p.member_id=$1 AND pa.beneficiary_id=$1`, [m02],
    )
    expect(pend02[0]?.status).toBe('pending')

    // m05 activates → m02 qualifies (directs m03+m04 both active, grandchild m05 under m03)
    await activate(m05)
    const q02 = await withTxn(async (c) => evaluateQualification(m02, c))
    expect(q02).toBe(true)
    await deliverRelease(m02)
    expect(await walletPaise(m02)).toBe(BONUS) // ₹1,000 — own pair released

    // m06 activates → pair completes at m03 (m05 vs m06)
    await activate(m06)
    await deliverAccruals(m03)

    // Under v2 (BR-7): m03's pair does NOT fan-out to m02
    expect(await walletPaise(m02)).toBe(BONUS) // still ₹1,000, not ₹2,000

    // m03's accrual is pending (not yet qualified)
    expect(await walletPaise(m03)).toBe(0n)
    const { rows: pend03 } = await pool().query<{ status: string }>(
      `SELECT status FROM pair_accruals pa JOIN pairs p ON p.id = pa.pair_id
        WHERE p.member_id=$1 AND pa.beneficiary_id=$1`, [m03],
    )
    expect(pend03[0]?.status).toBe('pending')

    // someone under m05 activates → m03 now qualifies (directs m05+m06, grandchild m07 under m05)
    const { memberId: m07 } = await register(c05, `WE07x${ts}`)
    await activate(m07)
    const q03 = await withTxn(async (c) => evaluateQualification(m03, c))
    expect(q03).toBe(true)
    await deliverRelease(m03)
    expect(await walletPaise(m03)).toBe(BONUS) // m03's own pair released ₹1,000

    const { rows: rel03 } = await pool().query<{ status: string; released_at: string }>(
      `SELECT status, released_at FROM pair_accruals pa JOIN pairs p ON p.id = pa.pair_id
        WHERE p.member_id=$1 AND pa.beneficiary_id=$1`, [m03],
    )
    expect(rel03[0]?.status).toBe('released')
    expect(rel03[0]?.released_at).not.toBeNull()
  })
})

describe('v2: accrue + release idempotency key → single ledger txn', () => {
  it('replay of same PairBonusAccrued does not double-pay', async () => {
    await ensureCutoffExists()
    const ts = (Date.now() + 5).toString().slice(-6)
    const { memberId: pId, memberCode: pCode } = await registerAnchor(`IDcx${ts}`)
    const { memberId: lId } = await register(pCode, `IDLx${ts}`)
    const { memberId: rId } = await register(pCode, `IDRx${ts}`)
    await activate(lId)
    await activate(rId) // pId mints pair seq=1

    // Pre-qualify
    await pool().query('UPDATE members SET is_qualified=TRUE WHERE id=$1', [pId])

    // Read the PairBonusAccrued event and deliver it (should release immediately)
    const { rows: pe } = await pool().query<{ payload: PairBonusAccrued }>(
      `SELECT payload::jsonb AS payload FROM events_outbox
        WHERE event_type='PairBonusAccrued' AND aggregate_id=$1`, [pId],
    )
    expect(pe.length).toBe(1)
    await accruePairBonus(pe[0].payload)
    expect(await walletPaise(pId)).toBe(BONUS)

    // replay same event → processed_events skip
    await accruePairBonus(pe[0].payload)
    // synthetic retroactive release → no pending rows, no double pay
    await releasePendingBonuses({
      event_id: randomUUID(), event_type: 'PendingBonusReleaseRequested',
      occurred_at: new Date().toISOString(), schema_version: 1, member_id: Number(pId),
    })
    expect(await walletPaise(pId)).toBe(BONUS)

    const { rows: txns } = await pool().query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM ledger_txns WHERE idempotency_key LIKE 'pairbonus:%:${pId}'`,
    )
    expect(Number(txns[0].count)).toBe(1)
  })
})

describe('v2: BR-13 — qualification backlog release defers cap overage', () => {
  it('₹500 headroom + two ₹1000 pending accruals → wallet +500, deferred +1500, forfeited unchanged', async () => {
    await ensureCutoffExists()
    const ts = (Date.now() + 9).toString().slice(-6)
    const { memberId: bId, memberCode: bCode } = await registerAnchor(`CApx${ts}`)
    const { memberId: lId } = await register(bCode, `CALx${ts}`)
    const { memberId: rId } = await register(bCode, `CARx${ts}`)
    await activate(lId)
    await activate(rId) // bId mints pair seq=1

    // Create a second synthetic pair for bId (seq=2) with synthetic FKs
    const { rows: p1Rows } = await pool().query<{ id: string }>(
      'SELECT id FROM pairs WHERE member_id=$1', [bId],
    )
    expect(p1Rows.length).toBe(1) // pair from counterPair
    const p1Id = p1Rows[0].id

    // Insert a second pair row directly (lId as pair owner just needs valid FKs)
    const { rows: p2Rows } = await pool().query<{ id: string }>(
      `INSERT INTO pairs (member_id, sequence_no, left_member_id, right_member_id, bonus_amount)
       VALUES ($1,2,$2,$3,$4) RETURNING id`,
      [bId, lId, rId, fromPaise(BONUS)],
    )
    const p2Id = p2Rows[0].id

    // Insert pending pair_accruals for both pairs with bId as beneficiary
    await pool().query(
      `INSERT INTO pair_accruals (pair_id, beneficiary_id, amount)
       VALUES ($1,$3,$4),($2,$3,$4)`,
      [p1Id, p2Id, bId, fromPaise(BONUS)],
    )

    // Consume all but ₹500 of this cutoff's cap
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

    // Snapshot system forfeited balance BEFORE release
    const forfeitedSum = async () => {
      const { rows } = await pool().query<{ net: string }>(
        `SELECT COALESCE(SUM(CASE WHEN le.direction='C' THEN le.amount ELSE -le.amount END),0) AS net
           FROM ledger_entries le
           JOIN accounts a ON a.id = le.account_id
          WHERE a.owner_type='system' AND a.kind='bonus_forfeited'`,
      )
      return toPaise(rows[0].net)
    }
    const forfeitedBefore = await forfeitedSum()

    // BR-13: releasePendingBonuses uses mode="defer" for backlog releases
    await releasePendingBonuses({
      event_id: randomUUID(), event_type: 'PendingBonusReleaseRequested',
      occurred_at: new Date().toISOString(), schema_version: 1, member_id: Number(bId),
    })

    expect(await walletPaise(bId)).toBe(50_000n) // ₹500 fit under the cap

    // Overage is DEFERRED (not forfeited) — this is the BR-13 change vs v1
    expect(await deferredPaise(bId)).toBe(150_000n) // ₹1,500 deferred to drain later
    expect(await forfeitedSum() - forfeitedBefore).toBe(0n) // forfeited unchanged

    const { rows: ce } = await pool().query<{ earned: string }>(
      `SELECT earned FROM cutoff_earnings WHERE member_id=$1 AND cutoff_id=$2`,
      [bId, co[0].id],
    )
    expect(toPaise(ce[0].earned)).toBe(capPaise) // earned pinned at the cap
    const { rows: released } = await pool().query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM pair_accruals WHERE beneficiary_id=$1 AND status='released'`,
      [bId],
    )
    expect(Number(released[0].count)).toBe(2) // both accruals released
  })
})

describe('v2: BR-12 — ongoing (already-qualified) overage still forfeits', () => {
  it('immediate release on already-qualified member forfeits cap overage', async () => {
    await ensureCutoffExists()
    const ts = (Date.now() + 13).toString().slice(-6)
    const { memberId: qId, memberCode: qCode } = await registerAnchor(`OnGx${ts}`)
    const { memberId: qlId } = await register(qCode, `OnLx${ts}`)
    const { memberId: qrId } = await register(qCode, `OnRx${ts}`)

    // Pre-qualify and consume all but ₹500 of the cap
    await pool().query('UPDATE members SET is_active=TRUE, is_qualified=TRUE WHERE id=$1', [qId])
    const { rows: co } = await pool().query<{ id: string }>(
      `SELECT id FROM cutoffs WHERE status='open' LIMIT 1`,
    )
    const capPaise = BigInt(CFG.CUTOFF_CAP_PAISE)
    await pool().query(
      `INSERT INTO cutoff_earnings (member_id, cutoff_id, earned) VALUES ($1,$2,$3)
       ON CONFLICT (member_id, cutoff_id) DO UPDATE SET earned = EXCLUDED.earned`,
      [qId, co[0].id, fromPaise(capPaise - 50_000n)], // ₹99,500 earned
    )

    // Activate directs → qId mints pair seq=1 → accruePairBonus releases immediately (qualified)
    await activate(qlId)
    await activate(qrId) // qId gets pair

    const forfeitedSum = async () => {
      const { rows } = await pool().query<{ net: string }>(
        `SELECT COALESCE(SUM(CASE WHEN le.direction='C' THEN le.amount ELSE -le.amount END),0) AS net
           FROM ledger_entries le
           JOIN accounts a ON a.id = le.account_id
          WHERE a.owner_type='system' AND a.kind='bonus_forfeited'`,
      )
      return toPaise(rows[0].net)
    }
    const forfeitedBefore = await forfeitedSum()
    const deferredBefore = await deferredPaise(qId)

    // Deliver the PairBonusAccrued — accruePairBonus calls releaseAccrual with mode="forfeit"
    // because this is an immediate/ongoing release for an already-qualified member (BR-12)
    await deliverAccruals(qId)

    expect(await walletPaise(qId)).toBe(50_000n) // ₹500 to wallet
    // BR-12: ongoing overage is forfeited, NOT deferred
    expect(await forfeitedSum() - forfeitedBefore).toBe(50_000n) // ₹500 forfeited
    expect(await deferredPaise(qId)).toBe(deferredBefore) // deferred_bonus unchanged
  })
})

describe('Reconciler – accrual and counter invariants hold after v2 pipeline', () => {
  it('no accrual_release_drift / accrual_pending_drift / pairs_drift alerts on clean DB', async () => {
    const alerts = await reconcile()
    const criticalAlerts = alerts.filter(
      (a) => a.type === 'accrual_release_drift' || a.type === 'accrual_pending_drift' || a.type === 'pairs_drift',
    )
    expect(criticalAlerts).toEqual([])
  })
})

afterAll(async () => {
  await pool().end().catch(() => null)
})
