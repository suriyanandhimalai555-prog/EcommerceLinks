/**
 * Integration test for the qualification revert
 * (scripts/revertQualification.ts) — v2 income model.
 *
 * Scenario under v2 (carry-forward pairs, no fan-out):
 *   P → L (left), R (right); L → G1 (left)
 *   All four activate → P mints pair seq=1 (L vs R), P qualifies,
 *   pair accrual releases → P wallet = ₹1,000.
 *
 *   revert → P unqualified, money clawed back, accrual pending (release_seq=1),
 *            upline qualified counters restored, audit row written.
 *
 *   re-qualify (conditions still hold) → pending accrual re-releases under
 *   the :1 idempotency key so the original txn does NOT swallow the re-credit.
 *
 * Requires: Postgres + Redis, migrations applied, root + management seeded.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { randomUUID } from 'crypto'
import { pool, withTxn } from '../../src/lib/db.js'
import { registerMember } from '../../src/services/placement.js'
import { evaluateQualification } from '../../src/services/qualification.js'
import { fanOut } from '../../src/workers/fanout.js'
import { applyIncrements } from '../../src/workers/counterPair.js'
import { releasePendingBonuses } from '../../src/workers/ledger.js'
import { writeOutbox } from '../../src/events/outbox.js'
import { ensureCutoffExists } from '../../src/workers/cutoff.js'
import { toPaise } from '../../src/lib/money.js'
import { CFG } from '../../src/config.js'
import type { MemberQualified, PairBonusAccrued, PendingBonusReleaseRequested } from '../../src/events/types.js'
import { revertQualifications } from '../../scripts/revertQualification.js'
import { registerAnchor, uniqueEmail, uniquePhone } from './helpers.js'

const BONUS = BigInt(CFG.PAIR_BONUS_PAISE)

async function register(sponsorCode: string, name: string) {
  return registerMember({
    sponsorCode, name, phone: uniquePhone('8'), email: uniqueEmail('rv'), password: 'Test@1234',
  })
}

/**
 * v2 activate: set is_active, then send a CounterIncrement to each ancestor.
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

async function qualifiedCounters(memberIds: number[]) {
  const { rows } = await pool().query<{ member_id: string; left_qualified: string; right_qualified: string }>(
    'SELECT member_id, left_qualified, right_qualified FROM member_counters WHERE member_id = ANY($1)',
    [memberIds],
  )
  return new Map(rows.map((r) => [r.member_id, `${r.left_qualified}/${r.right_qualified}`]))
}

/** Deliver PairBonusAccrued events written by counterPair for the matching node. */
async function deliverAccruals(matchingNodeId: bigint) {
  const { rows } = await pool().query<{ payload: PairBonusAccrued }>(
    `SELECT payload::jsonb AS payload FROM events_outbox
      WHERE event_type='PairBonusAccrued' AND aggregate_id=$1`,
    [matchingNodeId],
  )
  for (const r of rows) {
    // accruePairBonus via re-import avoids circular reference with the ledger worker
    const { accruePairBonus } = await import('../../src/workers/ledger.js')
    await accruePairBonus(r.payload)
  }
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

describe('Qualification revert + re-release round trip (v2 — own pair, no fan-out)', () => {
  it('claws back, restores qualified counters, and re-releases after re-qualification', async () => {
    await ensureCutoffExists()
    const ts = Date.now().toString().slice(-6)

    // P → L (left), R (right); L → G1 (left)
    // All four activate → P mints pair seq=1 (L vs R); P qualifies (2 directs + G1 grandchild)
    const { memberId: pId, memberCode: pCode } = await registerAnchor(`RVPx${ts}`)
    const { memberId: lId, memberCode: lCode } = await register(pCode, `RVLx${ts}`)
    const { memberId: rId } = await register(pCode, `RVRx${ts}`)
    const { memberId: g1 } = await register(lCode, `RVG1x${ts}`)

    // P must be active to qualify
    await activate(pId)
    await activate(lId)   // P.leftActive=1
    await activate(g1)    // P.leftActive=2 (G1 on P's left via L); L.leftActive=1
    await activate(rId)   // P.rightActive=1 → P mints pair seq=1 (L vs R)

    // P's pair accrual is in the outbox; deliver it (P not qualified yet → pending)
    await deliverAccruals(pId)
    expect(await walletPaise(pId)).toBe(0n)

    // Evaluate qualification: P has 2 active directs (L, R) + grandchild G1 → qualifies
    const qualified = await withTxn(async (c) => evaluateQualification(pId, c))
    expect(qualified).toBe(true)

    // Simulate the MemberQualified fan-out to update upline qualified counters.
    // Read the MemberQualified event written by evaluateQualification.
    const { rows: mqRows } = await pool().query<{ payload: MemberQualified }>(
      `SELECT payload::jsonb AS payload FROM events_outbox
        WHERE event_type='MemberQualified' AND aggregate_id=$1`, [pId],
    )
    expect(mqRows.length).toBe(1)
    const qualEvent = mqRows[0].payload

    const { rows: pm } = await pool().query<{ placement_path: number[]; placement_sides: string[] }>(
      'SELECT placement_path, placement_sides FROM members WHERE id=$1', [pId],
    )
    const path = pm[0].placement_path ?? []
    // Capture before-fanout state of upline qualified counters
    const before = await qualifiedCounters(path)
    // Apply qualified fan-out (mirrors what fanout.ts + counterPair.ts would do)
    for (const inc of fanOut(qualEvent, path.map(BigInt), pm[0].placement_sides ?? [])) {
      await applyIncrements(BigInt(inc.ancestor_id), [inc])
    }

    // Release the pending pair accrual (P is now qualified)
    await deliverRelease(pId)
    expect(await walletPaise(pId)).toBe(BONUS) // ₹1,000

    // ── The revert ──
    const summary = await revertQualifications({ execute: true, memberIds: [pId] })
    expect(summary.reverted.length).toBe(1)
    expect(summary.reverted[0].clawedBackPaise).toBe(BONUS)

    const { rows: flags } = await pool().query<{ is_qualified: boolean; qualified_at: string | null }>(
      'SELECT is_qualified, qualified_at FROM members WHERE id=$1', [pId],
    )
    expect(flags[0].is_qualified).toBe(false)
    expect(flags[0].qualified_at).toBeNull()
    expect(await walletPaise(pId)).toBe(0n)

    const { rows: acc } = await pool().query<{ status: string; release_seq: number; released_at: string | null; pair_id: string }>(
      `SELECT status, release_seq, released_at, pair_id FROM pair_accruals
        WHERE beneficiary_id=$1`, [pId],
    )
    expect(acc.length).toBe(1)
    expect(acc[0].status).toBe('pending')
    expect(acc[0].release_seq).toBe(1)
    expect(acc[0].released_at).toBeNull()

    // Upline qualified counters restored to pre-fanout values
    expect(await qualifiedCounters(path)).toEqual(before)

    const { rows: audit } = await pool().query(
      `SELECT 1 FROM admin_audit_log WHERE action='qualification_revert' AND target_id=$1`, [pId],
    )
    expect(audit.length).toBe(1)

    // ── Legitimate re-qualification: conditions still hold (L, R, G1 still active) ──
    const requalified = await withTxn(async (c) => evaluateQualification(pId, c))
    expect(requalified).toBe(true)

    const { rows: rel } = await pool().query<{ payload: PendingBonusReleaseRequested }>(
      `SELECT payload::jsonb AS payload FROM events_outbox
        WHERE event_type='PendingBonusReleaseRequested' AND aggregate_id=$1
        ORDER BY id DESC LIMIT 1`, [pId],
    )
    expect(rel.length).toBe(1)
    await releasePendingBonuses(rel[0].payload)

    // Money is back — the re-release posted under the :1 key, not swallowed by the original txn
    expect(await walletPaise(pId)).toBe(BONUS)
    const { rows: reAcc } = await pool().query<{ status: string; release_seq: number }>(
      'SELECT status, release_seq FROM pair_accruals WHERE beneficiary_id=$1', [pId],
    )
    expect(reAcc[0].status).toBe('released')
    expect(reAcc[0].release_seq).toBe(1)

    // Three distinct ledger txn keys: original release, revert, re-release
    const { rows: txns } = await pool().query<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM ledger_txns
        WHERE idempotency_key IN ($1, $2, $3)`,
      [
        `pairbonus:${acc[0].pair_id}:${pId}`,
        `pairbonus-revert:${acc[0].pair_id}:${pId}:0`,
        `pairbonus:${acc[0].pair_id}:${pId}:1`,
      ],
    )
    expect(txns.length).toBe(3)
  })
})

afterAll(async () => {
  await pool().end().catch(() => null)
})
