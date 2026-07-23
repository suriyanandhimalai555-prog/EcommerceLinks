/**
 * Integration test for the 2026-07 qualification revert
 * (scripts/revertQualification.ts) and the tightened gate.
 *
 * Recreates the production bug state: P qualified under the old one-child rule
 * (one active direct + active grandchild) with a released pair bonus, then:
 *   revert  → unqualified, money clawed back, accrual pending (release_seq+1),
 *             upline qualified counters restored, audit row written
 *   re-qualify (second direct activates) → pending accrual re-releases under
 *             the :seq idempotency key — the original ledger txn must NOT
 *             swallow the re-credit.
 *
 * Requires: Postgres + Redis, migrations applied, root + management seeded.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { randomUUID } from 'crypto'
import { pool, withTxn } from '../../src/lib/db.js'
import { registerMember } from '../../src/services/placement.js'
import { evaluateQualification } from '../../src/services/qualification.js'
import { detectPairCompletion } from '../../src/workers/pairComplete.js'
import { fanOut, fanOutPairBonus } from '../../src/workers/fanout.js'
import { applyIncrements } from '../../src/workers/counterPair.js'
import { accruePairBonus, releasePendingBonuses } from '../../src/workers/ledger.js'
import { writeOutbox } from '../../src/events/outbox.js'
import { ensureCutoffExists } from '../../src/workers/cutoff.js'
import { toPaise } from '../../src/lib/money.js'
import { CFG } from '../../src/config.js'
import type { MemberQualified, PairCompleted, PendingBonusReleaseRequested } from '../../src/events/types.js'
import { revertQualifications } from '../../scripts/revertQualification.js'
import { registerAnchor, uniqueEmail, uniquePhone } from './helpers.js'

const BONUS = BigInt(CFG.PAIR_BONUS_PAISE)

async function register(sponsorCode: string, name: string) {
  return registerMember({
    sponsorCode, name, phone: uniquePhone('8'), email: uniqueEmail('rv'), password: 'Test@1234',
  })
}

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

async function qualifiedCounters(memberIds: string[]) {
  const { rows } = await pool().query<{ member_id: string; left_qualified: string; right_qualified: string }>(
    'SELECT member_id, left_qualified, right_qualified FROM member_counters WHERE member_id = ANY($1)',
    [memberIds],
  )
  return new Map(rows.map((r) => [r.member_id, `${r.left_qualified}/${r.right_qualified}`]))
}

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

describe('Qualification revert + tightened gate round trip', () => {
  it('claws back, restores counters, and re-releases after real re-qualification', async () => {
    await ensureCutoffExists()
    const ts = Date.now().toString().slice(-6)

    // P → directs L,R; L → directs G1,G2 (P's grandchildren)
    const { memberId: pId, memberCode: pCode } = await registerAnchor(`RVPx${ts}`)
    const { memberId: lId, memberCode: lCode } = await register(pCode, `RVLx${ts}`)
    const { memberId: rId } = await register(pCode, `RVRx${ts}`)
    const { memberId: g1 } = await register(lCode, `RVG1x${ts}`)
    const { memberId: g2 } = await register(lCode, `RVG2x${ts}`)

    await activate(pId)
    await activate(lId)
    await activate(g1)

    // New rule: one active direct + grandchild does NOT qualify P
    const underNewRule = await withTxn(async (c) => evaluateQualification(pId, c))
    expect(underNewRule).toBe(false)

    // Recreate the legacy state exactly as the old pipeline left it:
    // flag + MemberQualified outbox event + processed counter fan-out.
    const qualEvent: MemberQualified = {
      event_id: randomUUID(), event_type: 'MemberQualified',
      occurred_at: new Date().toISOString(), schema_version: 1,
      member_id: Number(pId), via_child_id: Number(lId), via_grandchild_id: Number(g1),
    }
    await withTxn(async (c) => {
      await c.query('UPDATE members SET is_qualified=TRUE, qualified_at=now() WHERE id=$1', [pId])
      await writeOutbox(c, qualEvent)
    })
    const { rows: pm } = await pool().query<{ placement_path: string[]; placement_sides: string[] }>(
      'SELECT placement_path, placement_sides FROM members WHERE id=$1', [pId],
    )
    const path = (pm[0].placement_path ?? [])
    const before = await qualifiedCounters(path)
    for (const inc of fanOut(qualEvent, path.map(BigInt), pm[0].placement_sides ?? [])) {
      await applyIncrements(BigInt(inc.ancestor_id), [inc])
    }

    // G2 activates → pair completes at L → P (qualified) is paid immediately
    await activate(g2)
    await deliverAccruals(lId)
    expect(await walletPaise(pId)).toBe(BONUS)

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

    // Upline qualified counters restored to their pre-qualification values
    expect(await qualifiedCounters(path)).toEqual(before)

    const { rows: audit } = await pool().query(
      `SELECT 1 FROM admin_audit_log WHERE action='qualification_revert' AND target_id=$1`, [pId],
    )
    expect(audit.length).toBe(1)

    // ── Legitimate re-qualification: second direct activates ──
    await activate(rId) // also completes P's own pair (L,R)
    const requalified = await withTxn(async (c) => evaluateQualification(pId, c))
    expect(requalified).toBe(true)

    const { rows: rel } = await pool().query<{ payload: PendingBonusReleaseRequested }>(
      `SELECT payload FROM events_outbox
        WHERE event_type='PendingBonusReleaseRequested' AND aggregate_id=$1`, [pId],
    )
    expect(rel.length).toBe(1)
    await releasePendingBonuses(rel[0].payload)

    // Money is back — the re-release posted under the :1 key, not swallowed by
    // the original txn's idempotency.
    expect(await walletPaise(pId)).toBe(BONUS)
    const { rows: reAcc } = await pool().query<{ status: string; release_seq: number }>(
      'SELECT status, release_seq FROM pair_accruals WHERE beneficiary_id=$1', [pId],
    )
    expect(reAcc[0].status).toBe('released')
    expect(reAcc[0].release_seq).toBe(1)
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
