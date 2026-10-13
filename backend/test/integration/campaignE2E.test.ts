/**
 * End-to-end integration test: campaign pair-matching, upgrade → 3/5 units → wallet.
 *
 * Closes the un-joined seam between the three existing campaign test files:
 *   campaignEligibilityEmit.test.ts  — drives confirmOrder but stops at outbox
 *   campaignCounter.test.ts          — starts from synthetic CampaignUnitsAdded events
 *   campaignLedger.test.ts           — starts from synthetically-inserted campaign_pairs
 *
 * This file connects all three:
 *   real confirmOrder → real CampaignUnitsAdded payload (outbox)
 *     → applyCampaignUnits (counter worker, no Redis)
 *       → real CampaignPairBonusAccrued payload (outbox)
 *         → accrueCampaignPairBonus (ledger worker, no Redis)
 *           → wallet credit (₹1,000 per campaign pair)
 *
 * Design notes:
 *   - `confirmOrder` ratchets `members.package_value_paise` BEFORE emitting
 *     `CampaignUnitsAdded`. By the time any drain call processes an event,
 *     all members' package values are already at their final tiers.
 *   - Minting requires u_self ≥ 3 (no 2-unit tier; ₹10k→1 ⇒ T' ≤ B ⇒ surplus=0).
 *     Every minted pair's beneficiary is already ≥₹30k → immediate release.
 *     The CampaignEligibilityReached / releasePendingCampaignBonuses path is
 *     defensive-only and is a no-op here (tested separately in campaignLedger.test.ts).
 *   - Wallet assertion = surplus × ₹1,000, NOT T' × ₹1,000. The B live-engine pairs
 *     are standard pairs that stay pending in this isolated test (never qualified).
 *
 * Requires: Postgres 16, migrations applied, root seeded (npm run seed).
 * No Redis required — worker functions are called directly.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { pool } from '../../src/lib/db.js'
import { CFG } from '../../src/config.js'
import { registerAnchor, uniqueEmail, uniquePhone } from './helpers.js'
import { registerMember } from '../../src/services/placement.js'
import {
  createOrder,
  createUpgradeOrder,
  confirmOrder,
} from '../../src/services/orderService.js'
import { applyCampaignUnits } from '../../src/workers/campaignCounter.js'
import { accrueCampaignPairBonus } from '../../src/workers/campaignLedger.js'
import { ensureCutoffExists } from '../../src/workers/cutoff.js'
import type {
  CampaignUnitsAdded,
  CampaignPairBonusAccrued,
} from '../../src/events/types.js'
import { toPaise } from '../../src/lib/money.js'

// ── Campaign window override ───────────────────────────────────────────────────
// isWithinCampaign() reads CFG.CAMPAIGN_START_ISO / CAMPAIGN_END_ISO at call time.
// Widening to a far-future window makes every test run pass regardless of calendar date.
const origWindow = {
  CAMPAIGN_START_ISO: CFG.CAMPAIGN_START_ISO,
  CAMPAIGN_END_ISO: CFG.CAMPAIGN_END_ISO,
}

// ── Scenario member IDs (populated in beforeAll) ──────────────────────────────
// Scenario 1: 3-node ₹50k tree (YOU + ML + MR)
let s1You: bigint, s1Ml: bigint, s1Mr: bigint
// Scenario 2: 3-node ₹30k tree (YOU2 + ML2 + MR2)
let s2You: bigint, s2Ml: bigint, s2Mr: bigint
// Scenario 3: Image #6 tree (YOU3 + M1–M6)
let s3You: bigint, s3M1: bigint, s3M2: bigint, s3M3: bigint
let s3M4: bigint, s3M5: bigint, s3M6: bigint

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Register a member under a sponsor (identified by code) without retry logic.
 * The first call = L slot; the second = R slot. Beyond two raises 409.
 */
async function registerUnder(
  sponsorCode: string,
  name: string,
): Promise<{ memberId: bigint; memberCode: string }> {
  return registerMember({
    sponsorCode,
    name,
    phone: uniquePhone(),
    email: uniqueEmail('e2e-camp'),
    password: 'Test@12345',
  })
}

/**
 * Activate a member by creating a standard ₹10k order and confirming it.
 * product_id=1 is the standard ₹10k product created by the seed script.
 */
async function activate(memberId: bigint): Promise<void> {
  const { orderId, idempotencyKey } = await createOrder(String(memberId), 1)
  await confirmOrder(idempotencyKey, BigInt(orderId), `payref-act-${orderId}`)
}

/**
 * Upgrade a member to a new tier (₹30k or ₹50k).
 */
async function upgrade(memberId: bigint, targetPaise: number): Promise<void> {
  const { orderId, idempotencyKey } = await createUpgradeOrder(
    String(memberId),
    targetPaise,
  )
  await confirmOrder(idempotencyKey, BigInt(orderId), `payref-upg-${orderId}`)
}

/**
 * Seed a leg_activations row for an ancestor node.
 * leg_activations records which members sit in which leg of a given ancestor.
 * Normally written by the counterPair worker (standard engine); seeded here
 * because the standard engine is not run in this test.
 * The campaign recompute SQL reads: leg_activations JOIN members (for package_value_paise),
 * so the unit values are always current from members — no re-seeding needed after upgrade.
 */
async function seedLeg(
  ancestorId: bigint,
  side: 'L' | 'R',
  seq: bigint,
  memberId: bigint,
): Promise<void> {
  await pool().query(
    `INSERT INTO leg_activations (ancestor_id, side, seq, member_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING`,
    [ancestorId, side, seq, memberId],
  )
}

/**
 * Drain all CampaignUnitsAdded events from events_outbox whose aggregate_id
 * (= the emitting member_id) is in `memberIds`, ordered by insertion.
 * Routes each through applyCampaignUnits (the real counter worker; no Redis).
 * Safe to call multiple times — worker's processed_events guard deduplicates.
 */
async function drainUnits(memberIds: bigint[]): Promise<void> {
  const { rows } = await pool().query<{ payload: CampaignUnitsAdded }>(
    `SELECT payload FROM events_outbox
     WHERE event_type = 'CampaignUnitsAdded'
       AND aggregate_id = ANY($1::bigint[])
     ORDER BY id`,
    [memberIds.map(String)],
  )
  for (const row of rows) {
    await applyCampaignUnits(row.payload)
  }
}

/**
 * Drain all CampaignPairBonusAccrued events from events_outbox for a given
 * beneficiary, routing each through accrueCampaignPairBonus.
 * These events are written to outbox by applyCampaignUnits during drainUnits().
 */
async function drainAccruals(beneficiaryId: bigint): Promise<void> {
  const { rows } = await pool().query<{ payload: CampaignPairBonusAccrued }>(
    `SELECT payload FROM events_outbox
     WHERE event_type = 'CampaignPairBonusAccrued'
       AND aggregate_id = $1
     ORDER BY id`,
    [beneficiaryId],
  )
  for (const row of rows) {
    await accrueCampaignPairBonus(row.payload)
  }
}

/** Count campaign_pairs minted for a member. */
async function campaignPairCount(memberId: bigint): Promise<bigint> {
  const { rows } = await pool().query<{ cnt: string }>(
    'SELECT COUNT(*) AS cnt FROM campaign_pairs WHERE member_id = $1',
    [memberId],
  )
  return BigInt(rows[0].cnt)
}

/** Count released campaign_pair_accruals for a beneficiary. */
async function releasedAccruals(beneficiaryId: bigint): Promise<bigint> {
  const { rows } = await pool().query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt FROM campaign_pair_accruals
     WHERE beneficiary_id = $1 AND status = 'released'`,
    [beneficiaryId],
  )
  return BigInt(rows[0].cnt)
}

/** Wallet balance in paise for a member. */
async function walletPaise(memberId: bigint): Promise<bigint> {
  const { rows } = await pool().query<{ balance: string }>(
    `SELECT wb.balance FROM wallet_balances wb
       JOIN accounts a ON a.id = wb.account_id
      WHERE a.owner_id = $1 AND a.kind = 'wallet'`,
    [memberId],
  )
  return toPaise(rows[0]?.balance ?? '0')
}

/**
 * Assert no standard pair_accruals were released for a member.
 * Ensures the wallet figure is unambiguously the campaign contribution alone
 * and that the two engines (standard + campaign) do not bleed into each other.
 */
async function assertNoStandardAccrualReleased(memberId: bigint): Promise<void> {
  const { rows } = await pool().query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt FROM pair_accruals
     WHERE beneficiary_id = $1 AND status = 'released'`,
    [memberId],
  )
  expect(BigInt(rows[0].cnt)).toBe(0n)
}

// ── beforeAll: build all tree fixtures ───────────────────────────────────────

beforeAll(async () => {
  // 1. Widen campaign window so isWithinCampaign() returns true regardless of clock.
  Object.assign(CFG, {
    CAMPAIGN_START_ISO: '2000-01-01T00:00:00Z',
    CAMPAIGN_END_ISO: '2099-12-31T23:59:59Z',
  })

  // 2. Ensure a cutoff window exists (required by creditBonusWithCap in the ledger worker).
  await ensureCutoffExists()

  // ── Scenario 1: 3-node ₹50k tree ──────────────────────────────────────────
  // YOU (₹50k earner) with ML (L) and MR (R) each ₹50k.
  // T' = LEAST(ΣuL, ΣuR, u_self × LEAST(Lh, Rh)) = LEAST(5,5,5×1) = 5
  // B  = LEAST(Lh, Rh) = LEAST(1,1) = 1
  // surplus = 4 → wallet ₹4,000 (4 × ₹1,000)
  const s1 = await registerAnchor('E2EYou50k')
  s1You = s1.memberId
  const s1MlReg = await registerUnder(s1.memberCode, 'E2EML50k')
  s1Ml = s1MlReg.memberId
  const s1MrReg = await registerUnder(s1.memberCode, 'E2EMR50k')
  s1Mr = s1MrReg.memberId
  // Seed leg_activations: ML in L leg, MR in R leg (relative to YOU as ancestor).
  await seedLeg(s1You, 'L', 1n, s1Ml)
  await seedLeg(s1You, 'R', 1n, s1Mr)

  // ── Scenario 2: 3-node ₹30k tree ──────────────────────────────────────────
  // Same shape; upgrade target is ₹30k (3 units each).
  // T' = LEAST(3,3,3×1) = 3, B = 1, surplus = 2 → wallet ₹2,000
  const s2 = await registerAnchor('E2EYou30k')
  s2You = s2.memberId
  const s2MlReg = await registerUnder(s2.memberCode, 'E2EML30k')
  s2Ml = s2MlReg.memberId
  const s2MrReg = await registerUnder(s2.memberCode, 'E2EMR30k')
  s2Mr = s2MrReg.memberId
  await seedLeg(s2You, 'L', 1n, s2Ml)
  await seedLeg(s2You, 'R', 1n, s2Mr)

  // ── Scenario 3: Image #6 canonical tree ────────────────────────────────────
  // YOU (₹50k); left: M1₅₀, M2₁₀, M3₁₀, M6₁₀ (4 heads, 8u);
  //             right: M4₅₀, M5₅₀             (2 heads, 10u)
  // T' = LEAST(8,10,5×LEAST(4,2)) = 8, B = 2, surplus = 6 → wallet ₹6,000
  //
  // Binary placement (2-referral cap):
  //   YOU → M1 (L),  M4 (R)
  //   M1  → M2 (L),  M3 (R)
  //   M2  → M6 (L)
  //   M4  → M5 (L)
  const s3 = await registerAnchor('E2EYouImg6')
  s3You = s3.memberId
  const s3M1Reg = await registerUnder(s3.memberCode, 'E2EM1Img6')
  s3M1 = s3M1Reg.memberId
  const s3M4Reg = await registerUnder(s3.memberCode, 'E2EM4Img6')
  s3M4 = s3M4Reg.memberId
  const s3M2Reg = await registerUnder(s3M1Reg.memberCode, 'E2EM2Img6')
  s3M2 = s3M2Reg.memberId
  const s3M3Reg = await registerUnder(s3M1Reg.memberCode, 'E2EM3Img6')
  s3M3 = s3M3Reg.memberId
  const s3M5Reg = await registerUnder(s3M4Reg.memberCode, 'E2EM5Img6')
  s3M5 = s3M5Reg.memberId
  const s3M6Reg = await registerUnder(s3M2Reg.memberCode, 'E2EM6Img6')
  s3M6 = s3M6Reg.memberId

  // Seed leg_activations for s3You as ancestor:
  //   Left leg: M1, M2, M3, M6
  //   Right leg: M4, M5
  await seedLeg(s3You, 'L', 1n, s3M1)
  await seedLeg(s3You, 'L', 2n, s3M2)
  await seedLeg(s3You, 'L', 3n, s3M3)
  await seedLeg(s3You, 'L', 4n, s3M6)
  await seedLeg(s3You, 'R', 1n, s3M4)
  await seedLeg(s3You, 'R', 2n, s3M5)
}, 120_000)

afterAll(async () => {
  Object.assign(CFG, origWindow)

  const c = pool()
  const allEarners = [s1You, s2You, s3You].filter(Boolean)
  const allMembers = [
    s1You, s1Ml, s1Mr,
    s2You, s2Ml, s2Mr,
    s3You, s3M1, s3M2, s3M3, s3M4, s3M5, s3M6,
  ].filter(Boolean)

  for (const id of allEarners) {
    await c.query(
      `DELETE FROM campaign_pair_accruals WHERE campaign_pair_id IN
         (SELECT id FROM campaign_pairs WHERE member_id = $1)`,
      [id],
    )
    await c.query('DELETE FROM campaign_pairs WHERE member_id = $1', [id])
    await c.query(
      `DELETE FROM events_outbox
       WHERE event_type = 'CampaignPairBonusAccrued' AND aggregate_id = $1`,
      [id],
    )
    await c.query('DELETE FROM campaign_member_counters WHERE member_id = $1', [id])
  }

  // Clean up leg_activations seeded for our earners
  for (const id of allEarners) {
    await c.query('DELETE FROM leg_activations WHERE ancestor_id = $1', [id])
  }

  // Clean up outbox CampaignUnitsAdded for our members
  for (const id of allMembers) {
    await c.query(
      `DELETE FROM events_outbox WHERE event_type = 'CampaignUnitsAdded' AND aggregate_id = $1`,
      [id],
    )
    await c.query(
      `DELETE FROM processed_events WHERE consumer_group = 'avg-campaign-counter' AND event_id IN
         (SELECT event_id FROM events_outbox WHERE aggregate_id = $1)`,
      [id],
    )
    await c.query('DELETE FROM campaign_member_counters WHERE member_id = $1', [id])
  }

  // Clean up processed_events for campaign consumer groups (keyed by UUID event_id).
  // Use events_outbox as the index — delete processed_events whose event_id appears
  // in outbox rows for our members (aggregate_id matches).
  await c.query(
    `DELETE FROM processed_events
      WHERE consumer_group IN ('avg-campaign-counter','avg-campaign-ledger')
        AND event_id IN (
          SELECT event_id FROM events_outbox
           WHERE aggregate_id = ANY($1::bigint[])
        )`,
    [allMembers.map(String)],
  )

  // NOTE: registered members (via registerAnchor/registerMember) are intentionally
  // NOT deleted — they have FK dependencies on member_counters, orders, accounts, etc.
  // created at registration time.  Leaving them in the dev DB is the standard pattern
  // in this test suite (see campaignCounter.test.ts afterAll — only IsolatedChild
  // rows with no such dependencies are deleted there).  Each test run uses unique
  // emails and member codes so the accumulation never causes collisions.

  await pool().end().catch(() => null)
}, 120_000)

// ── Scenario 1 — ₹50k / 5-unit ────────────────────────────────────────────────

describe('Scenario 1 — ₹50k upgrade: 5-unit earner → 4 campaign pairs → ₹4,000 wallet', () => {
  it('Step A: ₹10k baseline — 0 campaign pairs (₹10k earner, u_self=1 ⇒ surplus=0)', async () => {
    // Activate all three at ₹10k
    await activate(s1Ml)
    await activate(s1Mr)
    await activate(s1You)

    // Drain all CampaignUnitsAdded events for these members.
    // After drain: confirmOrder has updated package_value_paise=1_000_000 for all three.
    // Recompute for s1You: ΣuL=1, ΣuR=1, u_self=1 → T'=LEAST(1,1,1×1)=1, B=1, surplus=0.
    await drainUnits([s1You, s1Ml, s1Mr])

    expect(await campaignPairCount(s1You)).toBe(0n)
    expect(await walletPaise(s1You)).toBe(0n)
  }, 60_000)

  it('Step B: upgrade to ₹50k — 4 campaign pairs minted, all released, wallet = ₹4,000', async () => {
    // Upgrade all three to ₹50k.
    // confirmOrder ratchets package_value_paise → 5_000_000 for each BEFORE emitting.
    // So by the time we drain, all package values are already at ₹50k in the DB.
    await upgrade(s1Ml, 5_000_000)
    await upgrade(s1Mr, 5_000_000)
    await upgrade(s1You, 5_000_000)

    // Drain CampaignUnitsAdded (unit_delta events for the upgrades).
    // Recompute for s1You: ΣuL=5(ML₅₀), ΣuR=5(MR₅₀), u_self=5(YOU₅₀)
    // T' = LEAST(5,5,5×LEAST(1,1)) = 5, B=1, surplus=4
    // Self-recompute pass (YOU's own node via member_delta=0): same result.
    await drainUnits([s1You, s1Ml, s1Mr])

    // At this point, campaignCounter has minted 4 campaign_pairs for s1You
    // and written 4 CampaignPairBonusAccrued events to events_outbox.
    expect(await campaignPairCount(s1You)).toBe(4n)

    // Drain CampaignPairBonusAccrued → accrueCampaignPairBonus.
    // Binary gate: s1You.package_value_paise=5_000_000 ≥ ₹30k → IMMEDIATE release.
    await drainAccruals(s1You)

    expect(await releasedAccruals(s1You)).toBe(4n)
    // wallet = 4 × ₹1,000 = ₹4,000 = 400_000 paise
    expect(await walletPaise(s1You)).toBe(400_000n)

    // Guard: no standard pair_accruals were released — wallet is purely campaign.
    await assertNoStandardAccrualReleased(s1You)
  }, 60_000)
})

// ── Scenario 2 — ₹30k / 3-unit ────────────────────────────────────────────────

describe('Scenario 2 — ₹30k upgrade: 3-unit earner → 2 campaign pairs → ₹2,000 wallet', () => {
  it('Step A: ₹10k baseline — 0 campaign pairs', async () => {
    await activate(s2Ml)
    await activate(s2Mr)
    await activate(s2You)
    await drainUnits([s2You, s2Ml, s2Mr])
    expect(await campaignPairCount(s2You)).toBe(0n)
    expect(await walletPaise(s2You)).toBe(0n)
  }, 60_000)

  it('Step B: upgrade to ₹30k — 2 campaign pairs, wallet = ₹2,000', async () => {
    // Upgrade to ₹30k (3 units each).
    // Recompute: T' = LEAST(3,3,3×1) = 3, B=1, surplus=2.
    await upgrade(s2Ml, 3_000_000)
    await upgrade(s2Mr, 3_000_000)
    await upgrade(s2You, 3_000_000)

    await drainUnits([s2You, s2Ml, s2Mr])
    expect(await campaignPairCount(s2You)).toBe(2n)

    await drainAccruals(s2You)
    expect(await releasedAccruals(s2You)).toBe(2n)
    // wallet = 2 × ₹1,000 = ₹2,000 = 200_000 paise
    expect(await walletPaise(s2You)).toBe(200_000n)

    await assertNoStandardAccrualReleased(s2You)
  }, 60_000)
})

// ── Scenario 3 — canonical Image #6 ──────────────────────────────────────────

describe('Scenario 3 — Image #6 (asymmetric legs + B guard): ₹50k earner → surplus=6 → ₹6,000 wallet', () => {
  it('Step A: ₹10k baseline — 0 campaign pairs', async () => {
    // Activate all 7 members at ₹10k
    for (const id of [s3M1, s3M2, s3M3, s3M4, s3M5, s3M6, s3You]) {
      await activate(id)
    }
    await drainUnits([s3You, s3M1, s3M2, s3M3, s3M4, s3M5, s3M6])
    expect(await campaignPairCount(s3You)).toBe(0n)
    expect(await walletPaise(s3You)).toBe(0n)
  }, 60_000)

  it('Step B: upgrade YOU, M1, M4, M5 to ₹50k — 6 campaign pairs, wallet = ₹6,000', async () => {
    // M2, M3, M6 stay at ₹10k (1u each).
    // M1→₹50k (5u), M4→₹50k (5u), M5→₹50k (5u), YOU→₹50k (u_self=5).
    await upgrade(s3M1, 5_000_000)
    await upgrade(s3M4, 5_000_000)
    await upgrade(s3M5, 5_000_000)
    await upgrade(s3You, 5_000_000)

    // Drain upgrade events for all 7 (only the upgraded ones emit non-zero unit_delta).
    // Recompute for s3You:
    //   Left leg (M1,M2,M3,M6): ΣuL = 5+1+1+1 = 8u, Lh = 4
    //   Right leg (M4,M5):      ΣuR = 5+5    = 10u, Rh = 2
    //   u_self = 5 (YOU₅₀)
    //   T' = LEAST(8, 10, 5×LEAST(4,2)) = LEAST(8,10,10) = 8
    //   B  = LEAST(4, 2) = 2
    //   surplus = 8 − 2 = 6
    await drainUnits([s3You, s3M1, s3M2, s3M3, s3M4, s3M5, s3M6])
    expect(await campaignPairCount(s3You)).toBe(6n)

    await drainAccruals(s3You)
    expect(await releasedAccruals(s3You)).toBe(6n)
    // wallet = 6 × ₹1,000 = ₹6,000 = 600_000 paise
    // Note: the total value cited in CLAUDE.md is ₹8,000 (T'=8); the wallet
    // credit here is surplus × ₹1,000 = 6 × ₹1,000 = ₹6,000.
    // The B=2 standard pairs belong to the live engine and stay pending (not released here).
    expect(await walletPaise(s3You)).toBe(600_000n)

    // Guard: confirms the ₹6,000 is purely campaign — standard pairs untouched.
    await assertNoStandardAccrualReleased(s3You)
  }, 60_000)
})
