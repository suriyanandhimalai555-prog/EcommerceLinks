/**
 * Integration tests for campaignCounter.applyCampaignUnits — DB-level.
 *
 * Exercises the SQL that executes inside applyCampaignUnits against a real
 * Postgres connection.  Unit tests cover the formula in pure TypeScript;
 * these tests verify the actual UPDATE / INSERT statements, the processed_events
 * idempotency gate, and the old-format event crash guard.
 *
 * Isolation strategy: children are manually INSERTed with a TRUNCATED
 * placement_path = ARRAY[anchorId] (stops at the test anchor).  This means
 * applyCampaignUnits only fans up to the test anchor — real tree ancestors
 * above the anchor are never touched, preventing dev-DB pollution.
 *
 * Requires: migrations applied (npm run migrate), root seeded (npm run seed).
 */
import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { pool } from '../../src/lib/db.js'
import { registerAnchor, uniqueEmail } from './helpers.js'
import { applyCampaignUnits } from '../../src/workers/campaignCounter.js'
import type { CampaignUnitsAdded } from '../../src/events/types.js'

// ── helpers ───────────────────────────────────────────────────────────────────

function makeEvent(
  memberId: bigint,
  memberDelta: number,
  unitDelta: number,
  valuePaise = 5_000_000,
): CampaignUnitsAdded {
  return {
    event_id: randomUUID(),
    event_type: 'CampaignUnitsAdded',
    occurred_at: new Date().toISOString(),
    schema_version: 1,
    member_id: Number(memberId),
    member_delta: memberDelta,
    unit_delta: unitDelta,
    new_value_paise: valuePaise,
  }
}

/**
 * Insert a test-only member whose placement_path is TRUNCATED to [parentId].
 * This confines applyCampaignUnits fan-up to just that one ancestor so that
 * no real tree members above the anchor are touched.
 */
async function insertIsolatedChild(
  parentId: bigint,
  side: 'L' | 'R',
): Promise<bigint> {
  const code = 'T' + randomUUID().replace(/-/g, '').slice(0, 9).toUpperCase()
  const email = uniqueEmail('ccnt-iso')
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO members
       (member_code, name, phone, email, password_hash,
        sponsor_id, parent_id, position,
        placement_path, placement_sides)
     VALUES ($1, 'IsolatedChild', '0000000000', $2, 'x',
             $3, $3, $4,
             ARRAY[$3::bigint], ARRAY[$5])
     RETURNING id`,
    [code, email, parentId, side, side],
  )
  return BigInt(rows[0].id)
}

async function getCounters(memberId: bigint) {
  const { rows } = await pool().query<{
    left_members: string; right_members: string
    left_units: string;   right_units:   string
    campaign_pairs_matched: string
  }>(
    `SELECT left_members, right_members, left_units, right_units, campaign_pairs_matched
       FROM campaign_member_counters WHERE member_id = $1`,
    [memberId],
  )
  if (!rows[0]) return null
  return {
    leftMembers:  BigInt(rows[0].left_members),
    rightMembers: BigInt(rows[0].right_members),
    leftUnits:    BigInt(rows[0].left_units),
    rightUnits:   BigInt(rows[0].right_units),
    pairsMatched: BigInt(rows[0].campaign_pairs_matched),
  }
}

async function countCampaignPairs(memberId: bigint): Promise<bigint> {
  const { rows } = await pool().query<{ cnt: string }>(
    'SELECT COUNT(*) AS cnt FROM campaign_pairs WHERE member_id = $1',
    [memberId],
  )
  return BigInt(rows[0]?.cnt ?? '0')
}

async function countOutboxAccruals(beneficiaryId: bigint): Promise<bigint> {
  const { rows } = await pool().query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt FROM events_outbox
      WHERE event_type = 'CampaignPairBonusAccrued'
        AND (payload->>'beneficiary_id')::bigint = $1`,
    [beneficiaryId],
  )
  return BigInt(rows[0]?.cnt ?? '0')
}

// ── fixtures ──────────────────────────────────────────────────────────────────

let anchorAId: bigint   // for asymmetric + idempotency tests
let childLId:  bigint   // isolated L-side child of anchorA
let anchorBId: bigint   // for ₹10k-only test
let childBLId: bigint   // isolated L-side child of anchorB

let test1Event: CampaignUnitsAdded  // saved to verify idempotency in Test 2

beforeAll(async () => {
  await (await import('../../src/api/server.js')).app.ready()

  // ── Anchor A: receives campaign pairs from 1×₹50k left vs 5×₹10k right ──
  const anchorA = await registerAnchor('CCntAnchorA')
  anchorAId = anchorA.memberId

  // Insert an isolated child with placement_path = [anchorAId] ONLY.
  // applyCampaignUnits fans up to placement_path; stopping at anchorAId means
  // no real tree ancestors above the anchor are touched.
  childLId = await insertIsolatedChild(anchorAId, 'L')

  // Seed anchorA's campaign counters: right side already has 5 headcount-₹10k
  // members (simulates the pre-campaign backfill of those right-side members).
  await pool().query(
    `INSERT INTO campaign_member_counters
       (member_id, left_members, right_members, left_units, right_units, campaign_pairs_matched)
     VALUES ($1, 0, 5, 0, 5, 0)
     ON CONFLICT (member_id) DO UPDATE
       SET left_members=0, right_members=5, left_units=0, right_units=5, campaign_pairs_matched=0`,
    [anchorAId],
  )

  // ── Anchor B: ₹10k-only test (0 campaign pairs expected) ─────────────────
  const anchorB = await registerAnchor('CCntAnchorB')
  anchorBId = anchorB.memberId

  childBLId = await insertIsolatedChild(anchorBId, 'L')

  // Seed anchorB: right side has 3 ₹10k members (units = headcount → campaign = 0)
  await pool().query(
    `INSERT INTO campaign_member_counters
       (member_id, left_members, right_members, left_units, right_units, campaign_pairs_matched)
     VALUES ($1, 0, 3, 0, 3, 0)
     ON CONFLICT (member_id) DO UPDATE
       SET left_members=0, right_members=3, left_units=0, right_units=3, campaign_pairs_matched=0`,
    [anchorBId],
  )
}, 120_000)

afterAll(async () => {
  const c = pool()
  // Clean up in FK-safe order: accruals → pairs → outbox → counters → members.
  for (const aId of [anchorAId, anchorBId].filter(Boolean)) {
    await c.query(
      `DELETE FROM campaign_pair_accruals WHERE campaign_pair_id IN
         (SELECT id FROM campaign_pairs WHERE member_id = $1)`,
      [aId],
    )
    await c.query(`DELETE FROM campaign_pairs WHERE member_id = $1`, [aId])
    await c.query(
      `DELETE FROM events_outbox
        WHERE event_type = 'CampaignPairBonusAccrued'
          AND (payload->>'beneficiary_id')::bigint = $1`,
      [aId],
    )
    await c.query(`DELETE FROM campaign_member_counters WHERE member_id = $1`, [aId])
  }
  // Delete isolated test children (they have no orders/accruals)
  for (const cId of [childLId, childBLId].filter(Boolean)) {
    await c.query(`DELETE FROM members WHERE id = $1`, [cId])
  }
  await pool().end().catch(() => null)
})

// ── tests ─────────────────────────────────────────────────────────────────────

describe('applyCampaignUnits — DB integration', () => {

  // ── Test 1: asymmetric 1×₹50k left, 5×₹10k right (pre-seeded) → 4 pairs ───
  // anchorA pre-seeded: right_members=5, right_units=5, campaign_pairs_matched=0
  // Event: childL activates at ₹50k (member_delta=1, unit_delta=5)
  // T = LEAST(5,5) = 5, B = LEAST(1,5) = 1, campaign target = 4
  it('1. mints 4 campaign pairs for 1×₹50k left vs 5×₹10k right', async () => {
    test1Event = makeEvent(childLId, 1, 5, 5_000_000)
    await applyCampaignUnits(test1Event)

    const ctr = await getCounters(anchorAId)
    expect(ctr).not.toBeNull()
    expect(ctr!.leftMembers).toBe(1n)
    expect(ctr!.leftUnits).toBe(5n)
    expect(ctr!.rightMembers).toBe(5n)
    expect(ctr!.rightUnits).toBe(5n)
    expect(ctr!.pairsMatched).toBe(4n)

    expect(await countCampaignPairs(anchorAId)).toBe(4n)
    expect(await countOutboxAccruals(anchorAId)).toBe(4n)
  }, 30_000)

  // ── Test 2: idempotency — re-deliver the exact same event_id ────────────────
  // processed_events gate must fire; counters and pair count must stay at 4.
  it('2. replaying the exact same event_id is a no-op (idempotent)', async () => {
    await applyCampaignUnits(test1Event)

    const ctr = await getCounters(anchorAId)
    expect(ctr!.pairsMatched).toBe(4n)
    expect(await countCampaignPairs(anchorAId)).toBe(4n)
    expect(await countOutboxAccruals(anchorAId)).toBe(4n)
  }, 30_000)

  // ── Test 3: ₹10k-only both sides → 0 campaign pairs ─────────────────────────
  // anchorB pre-seeded: right_members=3, right_units=3, campaign_pairs_matched=0
  // Event: childBL activates at ₹10k (member_delta=1, unit_delta=1)
  // T = LEAST(1,3) = 1, B = LEAST(1,3) = 1, surplus = 0 → campaign_pairs = 0
  it('3. ₹10k-only legs produce 0 campaign pairs (live base covers them)', async () => {
    const event = makeEvent(childBLId, 1, 1, 1_000_000)
    await applyCampaignUnits(event)

    const ctr = await getCounters(anchorBId)
    expect(ctr).not.toBeNull()
    expect(ctr!.leftMembers).toBe(1n)
    expect(ctr!.leftUnits).toBe(1n)
    expect(ctr!.rightMembers).toBe(3n)
    expect(ctr!.rightUnits).toBe(3n)
    expect(ctr!.pairsMatched).toBe(0n)

    expect(await countCampaignPairs(anchorBId)).toBe(0n)
  }, 30_000)

  // ── Test 4: old-format event guard — skip without crashing ──────────────────
  // An event with extra_units_delta (pre-migration-048 format) must not crash
  // the worker and must be recorded in processed_events.
  it('4. old-format event (extra_units_delta field) is skipped without crashing', async () => {
    const oldEvent = {
      event_id: randomUUID(),
      event_type: 'CampaignUnitsAdded',
      occurred_at: new Date().toISOString(),
      schema_version: 1,
      member_id: Number(childLId),
      extra_units_delta: 4,     // old field — member_delta / unit_delta absent
      new_value_paise: 5_000_000,
    } as unknown as CampaignUnitsAdded

    await expect(applyCampaignUnits(oldEvent)).resolves.not.toThrow()

    // anchorA's counters must be unchanged from Test 1
    const ctr = await getCounters(anchorAId)
    expect(ctr!.pairsMatched).toBe(4n)
    expect(await countCampaignPairs(anchorAId)).toBe(4n)

    // Event must be in processed_events (prevents poison-message re-delivery loop)
    const { rows } = await pool().query(
      `SELECT 1 FROM processed_events
        WHERE consumer_group = 'avg-campaign-counter' AND event_id = $1`,
      [oldEvent.event_id],
    )
    expect(rows.length).toBe(1)
  }, 30_000)
})
