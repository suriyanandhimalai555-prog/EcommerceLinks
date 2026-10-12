/**
 * Integration tests for campaignLedger.ts — binary eligibility gate.
 *
 * Confirms the "release all pairs once eligible" behaviour:
 *   ₹10k beneficiary → 0 released, all pending (not yet eligible)
 *   ₹30k beneficiary → ALL released immediately (eligible; no numeric cap)
 *   ₹50k beneficiary → ALL released immediately (eligible; no numeric cap)
 *   Upgrade ₹10k→₹30k via CampaignEligibilityReached → ALL pending released
 *   No-op: already-eligible member gets CampaignEligibilityReached → 0 new releases
 *   Idempotency: replaying CampaignEligibilityReached does not double-release
 *
 * The release rule mirrors the live pair-matching engine (all pairs to qualified
 * nodes) — the only campaign difference is unit-weighted MINTING (₹30k=3u, ₹50k=5u).
 * The release layer has NO per-tier cap.
 *
 * Requires: Postgres 16, migrations applied, root seeded (npm run seed).
 * Does NOT require Redis — worker functions are called directly.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { randomUUID } from 'crypto'
import { pool } from '../../src/lib/db.js'
import { registerAnchor } from './helpers.js'
import { ensureCutoffExists } from '../../src/workers/cutoff.js'
import { accrueCampaignPairBonus, releasePendingCampaignBonuses } from '../../src/workers/campaignLedger.js'
import { fromPaise, toPaise } from '../../src/lib/money.js'
import type { CampaignPairBonusAccrued, CampaignEligibilityReached } from '../../src/events/types.js'

const CAMPAIGN_BONUS_PAISE = 100_000n // ₹1,000 per campaign pair

// ── helpers ───────────────────────────────────────────────────────────────────

/** Set a member's package_value_paise directly (no order needed). */
async function setPackage(memberId: bigint, valuePaise: bigint) {
  await pool().query(
    'UPDATE members SET package_value_paise=$2 WHERE id=$1',
    [memberId, valuePaise],
  )
}

/** Insert a synthetic campaign_pair for a member and return its id. */
async function insertCampaignPair(memberId: bigint, sequenceNo: number): Promise<bigint> {
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO campaign_pairs (member_id, sequence_no, bonus_amount)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [memberId, sequenceNo, fromPaise(CAMPAIGN_BONUS_PAISE)],
  )
  return BigInt(rows[0].id)
}

/** Build a CampaignPairBonusAccrued event for a given pair + beneficiary. */
function makeAccrualEvent(
  campaignPairId: bigint,
  beneficiaryId: bigint,
): CampaignPairBonusAccrued {
  return {
    event_id: randomUUID(),
    event_type: 'CampaignPairBonusAccrued',
    occurred_at: new Date().toISOString(),
    schema_version: 1,
    beneficiary_id: Number(beneficiaryId),
    campaign_pair_id: Number(campaignPairId),
    amount_paise: Number(CAMPAIGN_BONUS_PAISE),
  }
}

/** Build a CampaignEligibilityReached event for a member. */
function makeEligibilityEvent(memberId: bigint): CampaignEligibilityReached {
  return {
    event_id: randomUUID(),
    event_type: 'CampaignEligibilityReached',
    occurred_at: new Date().toISOString(),
    schema_version: 1,
    member_id: Number(memberId),
  }
}

/** Count released / pending campaign accruals for a beneficiary. */
async function accrualCounts(
  beneficiaryId: bigint,
): Promise<{ released: number; pending: number }> {
  const { rows } = await pool().query<{ status: string; cnt: string }>(
    `SELECT status, count(*)::int AS cnt
       FROM campaign_pair_accruals
      WHERE beneficiary_id = $1
      GROUP BY status`,
    [beneficiaryId],
  )
  const released = Number(rows.find((r) => r.status === 'released')?.cnt ?? 0)
  const pending = Number(rows.find((r) => r.status === 'pending')?.cnt ?? 0)
  return { released, pending }
}

/** Read wallet balance in paise for a member. */
async function walletPaise(memberId: bigint): Promise<bigint> {
  const { rows } = await pool().query<{ balance: string }>(
    `SELECT wb.balance FROM wallet_balances wb
       JOIN accounts a ON a.id = wb.account_id
      WHERE a.owner_id = $1 AND a.kind = 'wallet'`,
    [memberId],
  )
  return toPaise(rows[0]?.balance ?? '0')
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('campaignLedger: ₹10k member earns nothing (not eligible)', () => {
  it('₹10k beneficiary: 3 campaign pairs → 0 released, 3 pending, wallet unchanged', async () => {
    await ensureCutoffExists()
    const ts = Date.now().toString().slice(-6)
    const { memberId } = await registerAnchor(`CLT10k${ts}`)

    // Package = ₹10k (below ₹30k eligibility threshold)
    await setPackage(memberId, 1_000_000n)

    for (let seq = 1; seq <= 3; seq++) {
      const pairId = await insertCampaignPair(memberId, seq)
      await accrueCampaignPairBonus(makeAccrualEvent(pairId, memberId))
    }

    const counts = await accrualCounts(memberId)
    expect(counts.released).toBe(0)
    expect(counts.pending).toBe(3)
    expect(await walletPaise(memberId)).toBe(0n)
  })
})

describe('campaignLedger: ₹30k member releases ALL pairs (no cap)', () => {
  it('₹30k beneficiary: 4 campaign pairs → all 4 released, 0 pending, wallet ₹4,000', async () => {
    await ensureCutoffExists()
    const ts = (Date.now() + 1).toString().slice(-6)
    const { memberId } = await registerAnchor(`CLT30k${ts}`)

    // Package = ₹30k (eligible — binary gate passes)
    await setPackage(memberId, 3_000_000n)

    for (let seq = 1; seq <= 4; seq++) {
      const pairId = await insertCampaignPair(memberId, seq)
      await accrueCampaignPairBonus(makeAccrualEvent(pairId, memberId))
    }

    const counts = await accrualCounts(memberId)
    expect(counts.released).toBe(4)  // ALL released — no cap
    expect(counts.pending).toBe(0)
    expect(await walletPaise(memberId)).toBe(CAMPAIGN_BONUS_PAISE * 4n) // ₹4,000
  })

  it('₹50k beneficiary: 5 campaign pairs → all 5 released, 0 pending, wallet ₹5,000', async () => {
    await ensureCutoffExists()
    const ts = (Date.now() + 2).toString().slice(-6)
    const { memberId } = await registerAnchor(`CLT50k${ts}`)

    // Package = ₹50k (eligible — binary gate passes)
    await setPackage(memberId, 5_000_000n)

    for (let seq = 1; seq <= 5; seq++) {
      const pairId = await insertCampaignPair(memberId, seq)
      await accrueCampaignPairBonus(makeAccrualEvent(pairId, memberId))
    }

    const counts = await accrualCounts(memberId)
    expect(counts.released).toBe(5)  // ALL released — no cap
    expect(counts.pending).toBe(0)
    expect(await walletPaise(memberId)).toBe(CAMPAIGN_BONUS_PAISE * 5n) // ₹5,000
  })
})

describe('campaignLedger: upgrade ₹10k→₹30k releases all pending', () => {
  it('CampaignEligibilityReached after ₹10k→₹30k upgrade releases all pending pairs', async () => {
    await ensureCutoffExists()
    const ts = (Date.now() + 3).toString().slice(-6)
    const { memberId } = await registerAnchor(`CLTUpg${ts}`)

    // Start at ₹10k — accrue 3 pairs (all stay pending)
    await setPackage(memberId, 1_000_000n)
    for (let seq = 1; seq <= 3; seq++) {
      const pairId = await insertCampaignPair(memberId, seq)
      await accrueCampaignPairBonus(makeAccrualEvent(pairId, memberId))
    }

    const before = await accrualCounts(memberId)
    expect(before.released).toBe(0)
    expect(before.pending).toBe(3)
    expect(await walletPaise(memberId)).toBe(0n)

    // Upgrade to ₹30k → CampaignEligibilityReached → ALL 3 released
    await setPackage(memberId, 3_000_000n)
    await releasePendingCampaignBonuses(makeEligibilityEvent(memberId))

    const after = await accrualCounts(memberId)
    expect(after.released).toBe(3)  // all released
    expect(after.pending).toBe(0)
    expect(await walletPaise(memberId)).toBe(CAMPAIGN_BONUS_PAISE * 3n) // ₹3,000
  })

  it('Already-eligible member: CampaignEligibilityReached is a no-op (nothing pending)', async () => {
    await ensureCutoffExists()
    const ts = (Date.now() + 4).toString().slice(-6)
    const { memberId } = await registerAnchor(`CLTNoop${ts}`)

    // ₹30k from the start — 2 pairs, both released immediately
    await setPackage(memberId, 3_000_000n)
    for (let seq = 1; seq <= 2; seq++) {
      const pairId = await insertCampaignPair(memberId, seq)
      await accrueCampaignPairBonus(makeAccrualEvent(pairId, memberId))
    }
    const mid = await accrualCounts(memberId)
    expect(mid.released).toBe(2)
    expect(mid.pending).toBe(0)

    // CampaignEligibilityReached fires (e.g. from confirmOrder) — no-op
    await releasePendingCampaignBonuses(makeEligibilityEvent(memberId))

    const after = await accrualCounts(memberId)
    expect(after.released).toBe(2)  // unchanged
    expect(after.pending).toBe(0)
  })
})

describe('campaignLedger: idempotency', () => {
  it('replaying CampaignEligibilityReached does not double-release', async () => {
    await ensureCutoffExists()
    const ts = (Date.now() + 5).toString().slice(-6)
    const { memberId } = await registerAnchor(`CLTIdem${ts}`)

    // ₹10k → accrue 2 pairs (pending)
    await setPackage(memberId, 1_000_000n)
    for (let seq = 1; seq <= 2; seq++) {
      const pairId = await insertCampaignPair(memberId, seq)
      await accrueCampaignPairBonus(makeAccrualEvent(pairId, memberId))
    }
    expect((await accrualCounts(memberId)).released).toBe(0)

    // Upgrade and release
    await setPackage(memberId, 3_000_000n)
    const ev = makeEligibilityEvent(memberId)
    await releasePendingCampaignBonuses(ev)
    expect((await accrualCounts(memberId)).released).toBe(2)

    // Replay the same event_id — processed_events guard deduplicates
    await releasePendingCampaignBonuses(ev)
    expect((await accrualCounts(memberId)).released).toBe(2) // no double-release

    const { rows: txns } = await pool().query<{ cnt: string }>(
      `SELECT COUNT(*)::int AS cnt FROM ledger_txns
        WHERE idempotency_key LIKE 'campaignbonus:%:${memberId}'`,
    )
    expect(Number(txns[0].cnt)).toBe(2) // exactly 2 ledger entries (one per pair)
  })
})

afterAll(async () => {
  await pool().end().catch(() => null)
})
