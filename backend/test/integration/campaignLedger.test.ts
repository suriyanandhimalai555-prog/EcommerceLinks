/**
 * Integration tests for campaignLedger.ts — tier-cap release rule.
 *
 * Confirms the "cap campaign top-up by own package tier" behaviour (Oct 2026):
 *   ₹10k beneficiary → 0 released (no campaign extra units), all pending
 *   ₹30k beneficiary → at most 2 released (lifetime), remainder pending
 *   ₹50k beneficiary → at most 4 released (lifetime), remainder pending
 *   Upgrade ₹30k→₹50k via CampaignEligibilityReached → 2 more released
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

describe('campaignLedger: tier cap by own package (₹10k → 0 extra)', () => {
  it('₹10k beneficiary: 3 campaign pairs → 0 released, 3 pending, wallet unchanged', async () => {
    await ensureCutoffExists()
    const ts = Date.now().toString().slice(-6)
    const { memberId } = await registerAnchor(`CLT10k${ts}`)

    // Set package to ₹10k (campaignExtraUnits = 0)
    await setPackage(memberId, 1_000_000n)

    // Insert 3 campaign pairs and deliver accrual events
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

describe('campaignLedger: tier cap by own package (₹30k → 2 extra)', () => {
  it('₹30k beneficiary: 4 campaign pairs → exactly 2 released, 2 pending', async () => {
    await ensureCutoffExists()
    const ts = (Date.now() + 1).toString().slice(-6)
    const { memberId } = await registerAnchor(`CLT30k${ts}`)

    // Package = ₹30k (campaignExtraUnits = 2, lifetime cap = 2 releases)
    await setPackage(memberId, 3_000_000n)

    for (let seq = 1; seq <= 4; seq++) {
      const pairId = await insertCampaignPair(memberId, seq)
      await accrueCampaignPairBonus(makeAccrualEvent(pairId, memberId))
    }

    const counts = await accrualCounts(memberId)
    expect(counts.released).toBe(2)
    expect(counts.pending).toBe(2)
    expect(await walletPaise(memberId)).toBe(CAMPAIGN_BONUS_PAISE * 2n) // ₹2,000
  })

  it('₹30k beneficiary at cap: additional pair → 0 more released (lifetime cap enforced)', async () => {
    await ensureCutoffExists()
    const ts = (Date.now() + 2).toString().slice(-6)
    const { memberId } = await registerAnchor(`CLT30kCap${ts}`)

    await setPackage(memberId, 3_000_000n)

    // First 2 pairs fill the cap
    for (let seq = 1; seq <= 2; seq++) {
      const pairId = await insertCampaignPair(memberId, seq)
      await accrueCampaignPairBonus(makeAccrualEvent(pairId, memberId))
    }
    const mid = await accrualCounts(memberId)
    expect(mid.released).toBe(2) // cap exactly consumed

    // 5th pair (cap already full) → stays pending
    const extraPairId = await insertCampaignPair(memberId, 3)
    await accrueCampaignPairBonus(makeAccrualEvent(extraPairId, memberId))

    const counts = await accrualCounts(memberId)
    expect(counts.released).toBe(2)   // no new releases
    expect(counts.pending).toBe(1)    // new pair is pending
  })
})

describe('campaignLedger: release on upgrade ₹30k→₹50k', () => {
  it('CampaignEligibilityReached after upgrade releases the extra headroom (oldest-first)', async () => {
    await ensureCutoffExists()
    const ts = (Date.now() + 3).toString().slice(-6)
    const { memberId } = await registerAnchor(`CLTUpg${ts}`)

    // Start at ₹30k — earn 4 pairs (2 release, 2 pending)
    await setPackage(memberId, 3_000_000n)
    const pairIds: bigint[] = []
    for (let seq = 1; seq <= 4; seq++) {
      const pairId = await insertCampaignPair(memberId, seq)
      pairIds.push(pairId)
      await accrueCampaignPairBonus(makeAccrualEvent(pairId, memberId))
    }

    const before = await accrualCounts(memberId)
    expect(before.released).toBe(2)
    expect(before.pending).toBe(2)

    // Upgrade to ₹50k → headroom = 4 − 2 = 2 more releases
    await setPackage(memberId, 5_000_000n)
    await releasePendingCampaignBonuses(makeEligibilityEvent(memberId))

    const after = await accrualCounts(memberId)
    expect(after.released).toBe(4)   // all 4 now released
    expect(after.pending).toBe(0)
    expect(await walletPaise(memberId)).toBe(CAMPAIGN_BONUS_PAISE * 4n) // ₹4,000
  })

  it('at ₹50k cap: additional pairs after upgrade stay pending permanently', async () => {
    await ensureCutoffExists()
    const ts = (Date.now() + 4).toString().slice(-6)
    const { memberId } = await registerAnchor(`CLTFull${ts}`)

    // ₹50k from the start — 5 pairs → 4 released, 1 pending (max tier cap)
    await setPackage(memberId, 5_000_000n)
    for (let seq = 1; seq <= 5; seq++) {
      const pairId = await insertCampaignPair(memberId, seq)
      await accrueCampaignPairBonus(makeAccrualEvent(pairId, memberId))
    }

    const counts = await accrualCounts(memberId)
    expect(counts.released).toBe(4)  // max tier = 4
    expect(counts.pending).toBe(1)   // over-cap stays pending forever

    // CampaignEligibilityReached at ₹50k → headroom = 0, nothing changes
    await releasePendingCampaignBonuses(makeEligibilityEvent(memberId))
    const countsAfter = await accrualCounts(memberId)
    expect(countsAfter.released).toBe(4)
    expect(countsAfter.pending).toBe(1)
  })

  it('idempotency: replaying CampaignEligibilityReached does not double-release', async () => {
    await ensureCutoffExists()
    const ts = (Date.now() + 5).toString().slice(-6)
    const { memberId } = await registerAnchor(`CLTIdem${ts}`)

    await setPackage(memberId, 5_000_000n)
    for (let seq = 1; seq <= 2; seq++) {
      const pairId = await insertCampaignPair(memberId, seq)
      await accrueCampaignPairBonus(makeAccrualEvent(pairId, memberId))
    }
    expect((await accrualCounts(memberId)).released).toBe(2)

    // Replay the same event — processed_events guard should deduplicate
    const ev = makeEligibilityEvent(memberId)
    await releasePendingCampaignBonuses(ev)
    await releasePendingCampaignBonuses(ev) // exact same event_id

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
