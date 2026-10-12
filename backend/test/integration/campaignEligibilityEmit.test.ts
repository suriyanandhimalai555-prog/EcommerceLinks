/**
 * Integration test: confirmOrder → CampaignEligibilityReached emission.
 *
 * Verifies that confirmOrder (services/orderService.ts) writes a
 * CampaignEligibilityReached row to events_outbox exactly when a package
 * upgrade crosses a tier boundary that raises campaignExtraUnits:
 *
 *   ₹10k → ₹30k : extraUnits 0→2 → emit
 *   ₹30k → ₹50k : extraUnits 2→4 → emit again (the case the old first-crossing
 *                  predicate would have MISSED; the new code must catch it)
 *   same-tier re-confirm : unchanged      → no emit
 *   plain ₹10k activation: extraUnits 0→0 → no emit
 *
 * No workers required — functions are called directly.
 * The campaign window is widened in beforeAll so the test is calendar-independent.
 *
 * Requires: Postgres 16, migrations applied, root seeded (npm run seed).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { pool } from '../../src/lib/db.js'
import { CFG } from '../../src/config.js'
import { registerAnchor } from './helpers.js'
import { ensureCutoffExists } from '../../src/workers/cutoff.js'
import {
  confirmOrder,
  createOrder,
  createUpgradeOrder,
} from '../../src/services/orderService.js'

// ── campaign window override ──────────────────────────────────────────────────
// isWithinCampaign() reads CFG.CAMPAIGN_START_ISO / CAMPAIGN_END_ISO at call
// time; widening to a far-future window makes every test run pass regardless of
// the real calendar date (e.g. after the Nov 2026 campaign closes).
// Object.assign bypasses TypeScript's const-inferred readonly on CFG properties.

const origCampaignWindow = {
  CAMPAIGN_START_ISO: CFG.CAMPAIGN_START_ISO,
  CAMPAIGN_END_ISO:   CFG.CAMPAIGN_END_ISO,
}

beforeAll(async () => {
  Object.assign(CFG, {
    CAMPAIGN_START_ISO: '2000-01-01T00:00:00Z',
    CAMPAIGN_END_ISO:   '2099-12-31T23:59:59Z',
  })
  await ensureCutoffExists()
})

afterAll(async () => {
  Object.assign(CFG, origCampaignWindow)
  await pool().end().catch(() => null)
})

// ── helpers ───────────────────────────────────────────────────────────────────

/** Count CampaignEligibilityReached events written to events_outbox for a member.
 *  events/outbox.ts routes this event type with aggregate_id = member_id.
 */
async function eligibilityEvents(memberId: bigint): Promise<number> {
  const { rows } = await pool().query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM events_outbox
      WHERE event_type = 'CampaignEligibilityReached'
        AND aggregate_id = $1`,
    [memberId],
  )
  return Number(rows[0].n)
}

/**
 * Register a fresh anchor, create a standard ₹10k order via createOrder, and
 * confirm it so the member is activated at ₹10k (package_value_paise = 1_000_000).
 */
async function registerAndActivate(
  name: string,
): Promise<{ memberId: bigint }> {
  const { memberId } = await registerAnchor(name)
  // product_id=1 is the standard ₹10k product inserted by the seed.
  const { orderId, idempotencyKey } = await createOrder(String(memberId), 1)
  await confirmOrder(idempotencyKey, BigInt(orderId), `payref-act-${orderId}`)
  return { memberId }
}

/**
 * Create an upgrade order to targetPaise and confirm it.
 * createUpgradeOrder returns the correct idempotencyKey to pass to confirmOrder.
 */
async function doUpgrade(memberId: bigint, targetPaise: number): Promise<void> {
  const { orderId, idempotencyKey } = await createUpgradeOrder(
    String(memberId),
    targetPaise,
  )
  await confirmOrder(idempotencyKey, BigInt(orderId), `payref-upg-${orderId}`)
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('campaignEligibilityEmit: confirmOrder writes CampaignEligibilityReached on tier upgrade', () => {
  it('₹10k → ₹30k upgrade emits one CampaignEligibilityReached (extraUnits 0 → 2)', async () => {
    const { memberId } = await registerAndActivate(
      `CEE30k${Date.now().toString().slice(-6)}`,
    )

    // No event before the upgrade
    expect(await eligibilityEvents(memberId)).toBe(0)

    // Upgrade to ₹30k: campaignExtraUnits crosses from 0 → 2 — must emit
    await doUpgrade(memberId, 3_000_000)

    expect(await eligibilityEvents(memberId)).toBe(1)
  })

  it('₹30k → ₹50k upgrade emits a second CampaignEligibilityReached (extraUnits 2 → 4)', async () => {
    // This is the critical test: the old first-crossing predicate would have
    // emitted only on 0→2 but not on 2→4. The new predicate
    //   campaignExtraUnits(new) > campaignExtraUnits(old)
    // must catch both crossings independently.
    const { memberId } = await registerAndActivate(
      `CEE50k${Date.now().toString().slice(-6)}`,
    )

    // ₹10k → ₹30k (first crossing)
    await doUpgrade(memberId, 3_000_000)
    expect(await eligibilityEvents(memberId)).toBe(1)

    // ₹30k → ₹50k (second crossing — must emit again)
    await doUpgrade(memberId, 5_000_000)
    expect(await eligibilityEvents(memberId)).toBe(2)
  })

  it('Negative: same-tier order confirm does not emit CampaignEligibilityReached', async () => {
    // Member at ₹50k. Confirm a plain ₹10k order: package stays at ₹50k
    // via GREATEST(5_000_000, 1_000_000) — campaignExtraUnits unchanged → no emit.
    const { memberId } = await registerAndActivate(
      `CEENeg${Date.now().toString().slice(-6)}`,
    )

    // Upgrade to ₹50k (emits one event)
    await doUpgrade(memberId, 5_000_000)
    const countAfterUpgrade = await eligibilityEvents(memberId)
    expect(countAfterUpgrade).toBe(1)

    // Confirm a fresh ₹10k order — package ratchet: GREATEST(₹50k, ₹10k) = ₹50k
    // campaignExtraUnits(₹50k) = 4 = campaignExtraUnits(₹50k) → predicate false
    const { orderId, idempotencyKey } = await createOrder(String(memberId), 1)
    await confirmOrder(idempotencyKey, BigInt(orderId), `payref-reconfirm-${orderId}`)

    // Event count must be unchanged
    expect(await eligibilityEvents(memberId)).toBe(countAfterUpgrade)
  })

  it('Negative: plain ₹10k activation does not emit CampaignEligibilityReached', async () => {
    // campaignExtraUnits(₹10k) = 0; old package was 0; 0 > 0 is false → no emit.
    const { memberId } = await registerAndActivate(
      `CEEPlain${Date.now().toString().slice(-6)}`,
    )

    expect(await eligibilityEvents(memberId)).toBe(0)
  })
})
