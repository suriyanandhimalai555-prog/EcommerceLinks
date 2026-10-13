/**
 * Integration tests for campaignCounter.applyCampaignUnits — DB-level.
 *
 * Exercises the SQL that executes inside applyCampaignUnits against a real
 * Postgres connection.  The worker uses WHOLE-LEG unit matching with earner self-cap:
 *   T' = LEAST(ΣuL, ΣuR, u_self × LEAST(Lh, Rh))
 *   B  = LEAST(Lh, Rh)   — what the live engine already paid
 * Matches the official campaign poster (Image #7): "total package value" whole-leg matching.
 * A ₹10k earner: u_self=1 → T' ≤ B → surplus=0 (no campaign pairs).
 *
 * Isolation strategy: each test anchor is a real registered member.  Children are
 * inserted with placement_path referencing the anchor (the new SQL does not compute depth
 * from placement_path, but valid paths are kept for FK integrity and uq_placement_slot).
 * Intermediate chain nodes are also real members (they satisfy FK and uq_placement_slot).
 * leg_activations rows are seeded directly (normally written by counterPair.ts).
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
 * Insert a test-only member with a FULL placement_path encoding real depth.
 *
 * placementPath: bigint[] — [anchorId, ..., immediate_parent] (self not included).
 *   Length = depth below anchor.  The first element MUST be anchorId so that
 *   array_position(placement_path, ancestorId) works correctly.
 * placementSides: ('L'|'R')[] — one entry per placement_path element.
 * parentId: binary-tree parent (must hold one L and one R slot).
 * side: which slot under parentId this member occupies.
 * packageValuePaise: tier value.
 *
 * The caller is responsible for ensuring parentId has room (uq_placement_slot).
 * All inserted members have name='IsolatedChild' for afterAll scoping.
 */
async function insertDepthMember(
  placementPath: bigint[],
  placementSides: ('L' | 'R')[],
  parentId: bigint,
  side: 'L' | 'R',
  packageValuePaise = 1_000_000,
): Promise<bigint> {
  const anchorId = placementPath[0]
  const code = 'T' + randomUUID().replace(/-/g, '').slice(0, 9).toUpperCase()
  const email = uniqueEmail('ccnt-dep')
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO members
       (member_code, name, phone, email, password_hash,
        sponsor_id, parent_id, position,
        placement_path, placement_sides,
        package_value_paise)
     VALUES ($1, 'IsolatedChild', '0000000000', $2, 'x',
             $3, $4, $5,
             $6::bigint[], $7::text[],
             $8)
     RETURNING id`,
    [
      code, email,
      anchorId,   // sponsor_id (used for 3-gen qualification gate, doesn't affect campaign)
      parentId, side,
      `{${placementPath.join(',')}}`,
      `{${placementSides.join(',')}}`,
      packageValuePaise,
    ],
  )
  return BigInt(rows[0].id)
}

/**
 * Seed a leg_activations row (normally written by the live counterPair.ts).
 * seq only needs to be unique per (ancestor_id, side) — the SQL uses the whole-leg
 * aggregate and does not depend on seq ordering or depth position.
 */
async function seedLegActivation(
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

async function seedCampaignCounters(
  memberId: bigint,
  leftMembers: number,
  rightMembers: number,
  leftUnits: number,
  rightUnits: number,
  pairsMatched = 0,
): Promise<void> {
  await pool().query(
    `INSERT INTO campaign_member_counters
       (member_id, left_members, right_members, left_units, right_units, campaign_pairs_matched)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (member_id) DO UPDATE
       SET left_members=$2, right_members=$3, left_units=$4, right_units=$5,
           campaign_pairs_matched=$6`,
    [memberId, leftMembers, rightMembers, leftUnits, rightUnits, pairsMatched],
  )
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

// Anchor A: Image #2 — 1×₹50k left vs 5×₹10k right → 4 campaign pairs.
// Whole-leg: T'=LEAST(5,5,5×1)=5, B=LEAST(1,5)=1, surplus=4 = ₹5,000 total.
// (Under the old line/depth formula this was surplus=0; the poster gives 4.)
let anchorAId: bigint
let chainAL1Id: bigint   // ₹50k @d1 (left)
// right chain: rChain[0]@d1, rChain[1]@d2, …, rChain[4]@d5 (each ₹10k)
const chainAR: bigint[] = []
let test1Event: CampaignUnitsAdded  // saved for idempotency test

// Anchor B: ₹10k-only both sides → 0 campaign pairs (base case)
let anchorBId: bigint
let chainBL1Id: bigint

// Anchor Sym: ₹50k earner, ₹50k↔₹50k @d1 → surplus 4
let anchorSymId: bigint
let childSymLId: bigint
let childSymRId: bigint

// Anchor 30K: ₹30k earner, ₹30k↔₹30k @d1 → surplus 2
let anchor30KId: bigint
let childL30Id: bigint
let childR30Id: bigint

// Anchor Image6: Image #6 tree — the exact reported bug.
// YOU ₹50k earner.
//   Left:  M1₅₀@d1,  M2₁₀@d2, M3₁₀@d2  (M2 parent=M1, M3 parent=M1),  M6₁₀@d3
//   Right: M4₅₀@d1,  M5₅₀@d2  (M5 parent=M4)
// Line1: min(5,5)=5  Line2: min(2,5)=2  Line3: min(1,0)=0  T'=7
// B = LEAST(4,2)=2  surplus=5  campaign_pairs_matched=5
let anchorImg6Id: bigint
let m1Id: bigint, m2Id: bigint, m3Id: bigint, m4Id: bigint, m5Id: bigint, m6Id: bigint

// Anchor BushyChain: discriminating bushy-vs-chain B check (advisor's test).
// ₹50k earner.
//   Left:  ₹50k@d1, ₹10k@d2, ₹10k@d2  (bushy: 2 siblings under d1 node)
//   Right: ₹50k@d1 → ₹50k@d2 → ₹50k@d3  (chain)
// d1: min(5,5)=5  d2: min(2,5)=2  d3: min(0,5)=0  T'=7
// B = LEAST(3,3)=3  surplus=4  (old b_eff formula would have given 5 — this guards it)
let anchorBCId: bigint
let bcL1Id: bigint
let bcL2aId: bigint, bcL2bId: bigint  // two ₹10k siblings at d2
let bcR1Id: bigint, bcR2Id: bigint, bcR3Id: bigint  // chain

// Anchor SelfUp: self-upgrade ₹10k → ₹30k with ₹50k↔₹50k downline
let anchorSelfUpId: bigint
let childSelfUpLId: bigint
let childSelfUpRId: bigint

// Anchor Cap30: ₹30k earner, 1×₹50k↔₹50k @d1 → surplus 2 (per-pair self-cap)
let anchorCap30Id: bigint
let childCap30LId: bigint
let childCap30RId: bigint

// Anchor Cap30x2: ₹30k earner, 2×(₹50k@d1/₹50k@d2) → surplus 4
let anchorCap30x2Id: bigint
let childCap30x2L1Id: bigint, childCap30x2R1Id: bigint
let childCap30x2L2Id: bigint, childCap30x2R2Id: bigint

// Anchor Cap50x2: ₹50k earner, 2×(₹50k@d1/₹50k@d2) → surplus 8
let anchorCap50x2Id: bigint
let childCap50x2L1Id: bigint, childCap50x2R1Id: bigint
let childCap50x2L2Id: bigint, childCap50x2R2Id: bigint

beforeAll(async () => {
  await (await import('../../src/api/server.js')).app.ready()

  // ── Anchor A: Image #2 — 1×₹50k@d1 left vs 5×₹10k chain right ──
  // Whole-leg: Lu=5, Ru=5, Lh=1, Rh=5.  u_self=5 (₹50k earner).
  // T' = LEAST(5,5,5×min(1,5)) = 5.  B = LEAST(1,5) = 1.  surplus = 4.
  // Total = 1 live + 4 campaign = ₹5,000 (poster's intended result).
  const anchorA = await registerAnchor('CCntAnchorA')
  anchorAId = anchorA.memberId
  await pool().query(`UPDATE members SET package_value_paise=5000000 WHERE id=$1`, [anchorAId])

  // Right chain: each member's placement_path grows by one hop.
  let prevRId = anchorAId
  let prevRPath: bigint[] = [anchorAId]
  let prevRSides: ('L' | 'R')[] = ['R']
  for (let i = 0; i < 5; i++) {
    const path = i === 0 ? [anchorAId] : [...prevRPath, prevRId]
    const sides = i === 0 ? (['R'] as ('L'|'R')[]) : [...prevRSides, 'L' as 'L'|'R']
    // Each subsequent right-chain member sits in the 'L' slot of the previous
    // (right chain deepens as L children to avoid placement conflicts; their
    // leg_activations side='R' is what matters for campaign matching).
    const actualSide = i === 0 ? 'R' : 'L'
    const rId = await insertDepthMember(path as bigint[], sides as ('L'|'R')[], prevRId, actualSide, 1_000_000)
    chainAR.push(rId)
    await seedLegActivation(anchorAId, 'R', BigInt(i + 1), rId)
    prevRId = rId
    prevRPath = path as bigint[]
    prevRSides = sides as ('L'|'R')[]
  }

  // Left: one ₹50k at d1
  chainAL1Id = await insertDepthMember([anchorAId], ['L'], anchorAId, 'L', 5_000_000)
  await seedLegActivation(anchorAId, 'L', 1n, chainAL1Id)

  // Pre-seed counter: right side already has 5 ₹10k members counted.
  await seedCampaignCounters(anchorAId, 0, 5, 0, 5, 0)

  // ── Anchor B: ₹10k-only both sides ────────────────────────────────────────
  const anchorB = await registerAnchor('CCntAnchorB')
  anchorBId = anchorB.memberId

  chainBL1Id = await insertDepthMember([anchorBId], ['L'], anchorBId, 'L', 1_000_000)
  await seedLegActivation(anchorBId, 'L', 1n, chainBL1Id)

  // 3 right-side ₹10k members chained at depths 1-3.
  let prevBId = anchorBId
  let prevBPath: bigint[] = [anchorBId]
  let prevBSides: ('L'|'R')[] = ['R']
  for (let i = 0; i < 3; i++) {
    const path = i === 0 ? [anchorBId] : [...prevBPath, prevBId]
    const sides = i === 0 ? (['R'] as ('L'|'R')[]) : [...prevBSides, 'L' as 'L'|'R']
    const actualSide = i === 0 ? 'R' : 'L'
    const rId = await insertDepthMember(path as bigint[], sides as ('L'|'R')[], prevBId, actualSide, 1_000_000)
    await seedLegActivation(anchorBId, 'R', BigInt(i + 1), rId)
    prevBId = rId
    prevBPath = path as bigint[]
    prevBSides = sides as ('L'|'R')[]
  }
  await seedCampaignCounters(anchorBId, 0, 3, 0, 3, 0)

  // ── Anchor Sym: ₹50k earner, ₹50k↔₹50k @d1 → surplus 4 ─────────────────
  const anchorSym = await registerAnchor('CCntAnchorSym')
  anchorSymId = anchorSym.memberId
  await pool().query(`UPDATE members SET package_value_paise=5000000 WHERE id=$1`, [anchorSymId])

  childSymLId = await insertDepthMember([anchorSymId], ['L'], anchorSymId, 'L', 5_000_000)
  childSymRId = await insertDepthMember([anchorSymId], ['R'], anchorSymId, 'R', 5_000_000)
  await seedLegActivation(anchorSymId, 'L', 1n, childSymLId)
  await seedLegActivation(anchorSymId, 'R', 1n, childSymRId)
  await seedCampaignCounters(anchorSymId, 0, 1, 0, 5, 0)

  // ── Anchor 30K: ₹30k earner, ₹30k↔₹30k @d1 → surplus 2 ─────────────────
  const anchor30K = await registerAnchor('CCntAnchor30K')
  anchor30KId = anchor30K.memberId
  await pool().query(`UPDATE members SET package_value_paise=3000000 WHERE id=$1`, [anchor30KId])

  childL30Id = await insertDepthMember([anchor30KId], ['L'], anchor30KId, 'L', 3_000_000)
  childR30Id = await insertDepthMember([anchor30KId], ['R'], anchor30KId, 'R', 3_000_000)
  await seedLegActivation(anchor30KId, 'L', 1n, childL30Id)
  await seedLegActivation(anchor30KId, 'R', 1n, childR30Id)
  await seedCampaignCounters(anchor30KId, 0, 1, 0, 3, 0)

  // ── Anchor Image6: Image #6 tree ─────────────────────────────────────────
  //   Left:  M1₅₀(d1), M2₁₀(d2,parent=M1), M3₁₀(d2,parent=M1), M6₁₀(d3,parent=M2)
  //   Right: M4₅₀(d1), M5₅₀(d2,parent=M4)
  //   YOU ₹50k earner
  //   Whole-leg: Lu=8, Ru=10, Lh=4, Rh=2, u_self=5
  //   T'=LEAST(8,10,5×LEAST(4,2))=LEAST(8,10,10)=8  B=LEAST(4,2)=2  surplus=6
  const anchorImg6 = await registerAnchor('CCntImg6')
  anchorImg6Id = anchorImg6.memberId
  await pool().query(`UPDATE members SET package_value_paise=5000000 WHERE id=$1`, [anchorImg6Id])

  // M1: d1 left
  m1Id = await insertDepthMember([anchorImg6Id], ['L'], anchorImg6Id, 'L', 5_000_000)
  // M4: d1 right
  m4Id = await insertDepthMember([anchorImg6Id], ['R'], anchorImg6Id, 'R', 5_000_000)
  // M2: d2 left (parent=M1, left slot of M1)
  m2Id = await insertDepthMember([anchorImg6Id, m1Id], ['L','L'], m1Id, 'L', 1_000_000)
  // M3: d2 left (parent=M1, right slot of M1)
  m3Id = await insertDepthMember([anchorImg6Id, m1Id], ['L','R'], m1Id, 'R', 1_000_000)
  // M5: d2 right (parent=M4, left slot of M4)
  m5Id = await insertDepthMember([anchorImg6Id, m4Id], ['R','L'], m4Id, 'L', 5_000_000)
  // M6: d3 left (parent=M2, left slot of M2)
  m6Id = await insertDepthMember([anchorImg6Id, m1Id, m2Id], ['L','L','L'], m2Id, 'L', 1_000_000)

  // leg_activations: side is which leg of anchorImg6 each member sits in
  await seedLegActivation(anchorImg6Id, 'L', 1n, m1Id)
  await seedLegActivation(anchorImg6Id, 'L', 2n, m2Id)
  await seedLegActivation(anchorImg6Id, 'L', 3n, m3Id)
  await seedLegActivation(anchorImg6Id, 'L', 4n, m6Id)
  await seedLegActivation(anchorImg6Id, 'R', 1n, m4Id)
  await seedLegActivation(anchorImg6Id, 'R', 2n, m5Id)

  // Pre-seed: all except M3 and M6 (the triggering event will be M3 activating)
  await seedCampaignCounters(anchorImg6Id, 1, 2, 5, 10, 0)  // M1+M4+M5 pre-counted

  // ── Anchor BushyChain: discriminating B-fix test ──────────────────────────
  //   Left:  ₹50k@d1,  ₹10k@d2 sibling-a (parent=L1),  ₹10k@d2 sibling-b (parent=L1)
  //   Right: ₹50k@d1 → ₹50k@d2 → ₹50k@d3  (chain)
  //   ₹50k earner
  //   d1: min(5,5,5)=5  d2: min(2,5,5)=2  d3: min(0,5,5)=0  T'=7
  //   B = LEAST(3,3)=3  surplus=4
  //   OLD formula: b_eff = Σ_d min(h_d) = 1+1+0=2, surplus=5 — WRONG. This test guards it.
  const anchorBC = await registerAnchor('CCntBushyChain')
  anchorBCId = anchorBC.memberId
  await pool().query(`UPDATE members SET package_value_paise=5000000 WHERE id=$1`, [anchorBCId])

  // Left leg: L1@d1, L2a@d2(parent=L1 L-slot), L2b@d2(parent=L1 R-slot)
  bcL1Id  = await insertDepthMember([anchorBCId], ['L'], anchorBCId, 'L', 5_000_000)
  bcL2aId = await insertDepthMember([anchorBCId, bcL1Id], ['L','L'], bcL1Id, 'L', 1_000_000)
  bcL2bId = await insertDepthMember([anchorBCId, bcL1Id], ['L','R'], bcL1Id, 'R', 1_000_000)
  // Right leg: R1@d1, R2@d2(parent=R1 L-slot), R3@d3(parent=R2 L-slot)
  bcR1Id = await insertDepthMember([anchorBCId], ['R'], anchorBCId, 'R', 5_000_000)
  bcR2Id = await insertDepthMember([anchorBCId, bcR1Id], ['R','L'], bcR1Id, 'L', 5_000_000)
  bcR3Id = await insertDepthMember([anchorBCId, bcR1Id, bcR2Id], ['R','L','L'], bcR2Id, 'L', 5_000_000)

  await seedLegActivation(anchorBCId, 'L', 1n, bcL1Id)
  await seedLegActivation(anchorBCId, 'L', 2n, bcL2aId)
  await seedLegActivation(anchorBCId, 'L', 3n, bcL2bId)
  await seedLegActivation(anchorBCId, 'R', 1n, bcR1Id)
  await seedLegActivation(anchorBCId, 'R', 2n, bcR2Id)
  await seedLegActivation(anchorBCId, 'R', 3n, bcR3Id)

  // Pre-seed: all except bcL2b (the triggering event)
  await seedCampaignCounters(anchorBCId, 2, 3, 6, 15, 0)  // L1+L2a+R1+R2+R3 pre-counted

  // ── Anchor Cap30: ₹30k earner, 1×₹50k↔₹50k @d1 → surplus 2 ─────────────
  const anchorCap30 = await registerAnchor('CCntCap30')
  anchorCap30Id = anchorCap30.memberId
  await pool().query(`UPDATE members SET package_value_paise=3000000 WHERE id=$1`, [anchorCap30Id])

  childCap30LId = await insertDepthMember([anchorCap30Id], ['L'], anchorCap30Id, 'L', 5_000_000)
  childCap30RId = await insertDepthMember([anchorCap30Id], ['R'], anchorCap30Id, 'R', 5_000_000)
  await seedLegActivation(anchorCap30Id, 'L', 1n, childCap30LId)
  await seedLegActivation(anchorCap30Id, 'R', 1n, childCap30RId)
  await seedCampaignCounters(anchorCap30Id, 0, 1, 0, 5, 0)

  // ── Anchor Cap30x2: ₹30k earner, 2×(₹50k@d1 / ₹50k@d2) → surplus 4 ─────
  const anchorCap30x2 = await registerAnchor('CCntCap30x2')
  anchorCap30x2Id = anchorCap30x2.memberId
  await pool().query(`UPDATE members SET package_value_paise=3000000 WHERE id=$1`, [anchorCap30x2Id])

  childCap30x2L1Id = await insertDepthMember([anchorCap30x2Id], ['L'], anchorCap30x2Id, 'L', 5_000_000)
  childCap30x2R1Id = await insertDepthMember([anchorCap30x2Id], ['R'], anchorCap30x2Id, 'R', 5_000_000)
  // d2: L2 under L1's L-slot, R2 under R1's L-slot
  childCap30x2L2Id = await insertDepthMember([anchorCap30x2Id, childCap30x2L1Id], ['L','L'], childCap30x2L1Id, 'L', 5_000_000)
  childCap30x2R2Id = await insertDepthMember([anchorCap30x2Id, childCap30x2R1Id], ['R','L'], childCap30x2R1Id, 'L', 5_000_000)

  await seedLegActivation(anchorCap30x2Id, 'L', 1n, childCap30x2L1Id)
  await seedLegActivation(anchorCap30x2Id, 'R', 1n, childCap30x2R1Id)
  await seedLegActivation(anchorCap30x2Id, 'L', 2n, childCap30x2L2Id)
  await seedLegActivation(anchorCap30x2Id, 'R', 2n, childCap30x2R2Id)
  // Pre-seed: L1, R1, R2 already counted; L2 event fires below.
  await seedCampaignCounters(anchorCap30x2Id, 1, 2, 5, 10, 0)

  // ── Anchor Cap50x2: ₹50k earner, 2×(₹50k@d1 / ₹50k@d2) → surplus 8 ─────
  const anchorCap50x2 = await registerAnchor('CCntCap50x2')
  anchorCap50x2Id = anchorCap50x2.memberId
  await pool().query(`UPDATE members SET package_value_paise=5000000 WHERE id=$1`, [anchorCap50x2Id])

  childCap50x2L1Id = await insertDepthMember([anchorCap50x2Id], ['L'], anchorCap50x2Id, 'L', 5_000_000)
  childCap50x2R1Id = await insertDepthMember([anchorCap50x2Id], ['R'], anchorCap50x2Id, 'R', 5_000_000)
  childCap50x2L2Id = await insertDepthMember([anchorCap50x2Id, childCap50x2L1Id], ['L','L'], childCap50x2L1Id, 'L', 5_000_000)
  childCap50x2R2Id = await insertDepthMember([anchorCap50x2Id, childCap50x2R1Id], ['R','L'], childCap50x2R1Id, 'L', 5_000_000)

  await seedLegActivation(anchorCap50x2Id, 'L', 1n, childCap50x2L1Id)
  await seedLegActivation(anchorCap50x2Id, 'R', 1n, childCap50x2R1Id)
  await seedLegActivation(anchorCap50x2Id, 'L', 2n, childCap50x2L2Id)
  await seedLegActivation(anchorCap50x2Id, 'R', 2n, childCap50x2R2Id)
  await seedCampaignCounters(anchorCap50x2Id, 1, 2, 5, 10, 0)

  // ── Anchor SelfUp: self-upgrade ₹10k → ₹30k with ₹50k↔₹50k downline ─────
  const anchorSelfUp = await registerAnchor('CCntSelfUp')
  anchorSelfUpId = anchorSelfUp.memberId
  // Earner starts ₹10k (default package_value_paise=1000000)

  childSelfUpLId = await insertDepthMember([anchorSelfUpId], ['L'], anchorSelfUpId, 'L', 5_000_000)
  childSelfUpRId = await insertDepthMember([anchorSelfUpId], ['R'], anchorSelfUpId, 'R', 5_000_000)
  await seedLegActivation(anchorSelfUpId, 'L', 1n, childSelfUpLId)
  await seedLegActivation(anchorSelfUpId, 'R', 1n, childSelfUpRId)
  await seedCampaignCounters(anchorSelfUpId, 0, 1, 0, 5, 0)
}, 120_000)

afterAll(async () => {
  // Cleanup many rows against Railway dev DB (~3s/query × many deletes = >30s).
  // Explicit 120s timeout below.
  const c = pool()
  const allAnchors = [
    anchorAId, anchorBId, anchorSymId, anchor30KId, anchorImg6Id, anchorBCId,
    anchorCap30Id, anchorCap30x2Id, anchorCap50x2Id, anchorSelfUpId,
  ].filter(Boolean)

  for (const aId of allAnchors) {
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
    await c.query(`DELETE FROM leg_activations WHERE ancestor_id = $1`, [aId])
  }

  // Delete isolated child members bottom-up (descending id = deepest first).
  // The self-recompute pass may create campaign_member_counters for children,
  // so delete those first.
  const childIds = await c.query<{ id: string }>(
    `SELECT id FROM members
      WHERE name='IsolatedChild'
        AND placement_path[1] = ANY($1::bigint[])
      ORDER BY id DESC`,
    [allAnchors.map(String)],
  )
  for (const row of childIds.rows) {
    await c.query(`DELETE FROM campaign_member_counters WHERE member_id=$1`, [row.id])
    await c.query(`DELETE FROM members WHERE id=$1`, [row.id])
  }

  await c.query(
    `DELETE FROM processed_events WHERE consumer_group='avg-campaign-counter'`,
  )

  await pool().end().catch(() => null)
}, 120_000)

// ── tests ─────────────────────────────────────────────────────────────────────

describe('applyCampaignUnits — whole-leg unit matching', () => {

  // ── Test 1: Image #2 — 1×₹50k left vs 5×₹10k right, ₹50k earner → 4 campaign pairs ──
  // Whole-leg: Lu=5, Ru=5 (5×1u), Lh=1, Rh=5, u_self=5.
  // T' = LEAST(5,5,5×min(1,5)) = LEAST(5,5,5) = 5.  B = LEAST(1,5) = 1.  surplus = 4.
  // Total = 1 live + 4 campaign = ₹5,000 — matches the official poster.
  it('1. Image #2: 1×₹50k vs 5×₹10k right, ₹50k earner → 4 campaign pairs (₹5,000 total)', async () => {
    test1Event = makeEvent(chainAL1Id, 1, 5, 5_000_000)
    await applyCampaignUnits(test1Event)

    const ctr = await getCounters(anchorAId)
    expect(ctr).not.toBeNull()
    expect(ctr!.leftMembers).toBe(1n)
    expect(ctr!.leftUnits).toBe(5n)
    expect(ctr!.rightMembers).toBe(5n)
    expect(ctr!.rightUnits).toBe(5n)
    // T'=LEAST(5,5,5×1)=5; B=LEAST(1,5)=1; surplus=4
    expect(ctr!.pairsMatched).toBe(4n)
    expect(await countCampaignPairs(anchorAId)).toBe(4n)
    expect(await countOutboxAccruals(anchorAId)).toBe(4n)
  }, 30_000)

  // ── Test 2: idempotency ────────────────────────────────────────────────────
  it('2. replaying the exact same event_id is a no-op', async () => {
    await applyCampaignUnits(test1Event)

    const ctr = await getCounters(anchorAId)
    expect(ctr!.pairsMatched).toBe(4n)
    expect(await countCampaignPairs(anchorAId)).toBe(4n)
  }, 30_000)

  // ── Test 3: ₹10k-only both sides → 0 campaign pairs ─────────────────────
  it('3. ₹10k-only legs → 0 campaign pairs (live base covers them)', async () => {
    const event = makeEvent(chainBL1Id, 1, 1, 1_000_000)
    await applyCampaignUnits(event)

    const ctr = await getCounters(anchorBId)
    expect(ctr).not.toBeNull()
    expect(ctr!.leftMembers).toBe(1n)
    expect(ctr!.leftUnits).toBe(1n)
    expect(ctr!.pairsMatched).toBe(0n)
    expect(await countCampaignPairs(anchorBId)).toBe(0n)
  }, 30_000)

  // ── Test 4: old-format event guard — skip without crashing ────────────────
  it('4. old-format event (extra_units_delta field) is skipped without crashing', async () => {
    const oldEvent = {
      event_id: randomUUID(),
      event_type: 'CampaignUnitsAdded',
      occurred_at: new Date().toISOString(),
      schema_version: 1,
      member_id: Number(chainAL1Id),
      extra_units_delta: 4,
      new_value_paise: 5_000_000,
    } as unknown as CampaignUnitsAdded

    await expect(applyCampaignUnits(oldEvent)).resolves.not.toThrow()

    const ctr = await getCounters(anchorAId)
    // pairsMatched is 4n from test 1 — skip event must not alter it
    expect(ctr!.pairsMatched).toBe(4n)

    const { rows } = await pool().query(
      `SELECT 1 FROM processed_events
        WHERE consumer_group = 'avg-campaign-counter' AND event_id = $1`,
      [oldEvent.event_id],
    )
    expect(rows.length).toBe(1)
  }, 30_000)

  // ── Test 5: symmetric ₹50k↔₹50k @d1 → surplus 4 ─────────────────────────
  it('5. symmetric ₹50k↔₹50k → 4 campaign pairs (₹5,000 total)', async () => {
    const event = makeEvent(childSymLId, 1, 5, 5_000_000)
    await applyCampaignUnits(event)

    const ctr = await getCounters(anchorSymId)
    expect(ctr).not.toBeNull()
    expect(ctr!.leftUnits).toBe(5n)
    expect(ctr!.rightUnits).toBe(5n)
    // d1: min(5,5,5)=5  B=1  surplus=4
    expect(ctr!.pairsMatched).toBe(4n)
    expect(await countCampaignPairs(anchorSymId)).toBe(4n)
    expect(await countOutboxAccruals(anchorSymId)).toBe(4n)
  }, 30_000)

  // ── Test 6: ₹30k↔₹30k @d1 → surplus 2 ───────────────────────────────────
  it('6. symmetric ₹30k↔₹30k → 2 campaign pairs', async () => {
    const event = makeEvent(childL30Id, 1, 3, 3_000_000)
    await applyCampaignUnits(event)

    const ctr = await getCounters(anchor30KId)
    expect(ctr).not.toBeNull()
    expect(ctr!.pairsMatched).toBe(2n)
    expect(await countCampaignPairs(anchor30KId)).toBe(2n)
  }, 30_000)

  // ── Test 7: Image #6 tree ─────────────────────────────────────────────────
  // YOU ₹50k earner.
  //   Left:  M1₅₀, M2₁₀, M3₁₀, M6₁₀  (4 heads, Lu=8u)
  //   Right: M4₅₀, M5₅₀               (2 heads, Ru=10u)
  // Whole-leg: T' = LEAST(8,10,5×LEAST(4,2)) = LEAST(8,10,10) = 8
  // B = LEAST(4,2) = 2   surplus = 8−2 = 6   total = ₹8,000.
  it('7. Image #6 tree: ₹50k earner, 4L vs 2R → surplus 6 (₹8,000 total)', async () => {
    // Fire event for M3 (the last un-pre-seeded left member)
    const event = makeEvent(m3Id, 1, 1, 1_000_000)
    await applyCampaignUnits(event)

    const ctr = await getCounters(anchorImg6Id)
    expect(ctr).not.toBeNull()
    // Counter columns now store the SQL-computed true totals from leg_activations ⋈ members
    // (not delta-accumulated values from events processed so far).  This means M2 and M6
    // — which are in leg_activations but had no events fired through this worker — ARE
    // reflected in left_members and left_units.
    // Left leg total (M1₅₀, M2₁₀, M3₁₀, M6₁₀): 4 heads, 8 units
    expect(ctr!.leftMembers).toBe(4n)
    expect(ctr!.leftUnits).toBe(8n)
    // Right leg total (M4₅₀, M5₅₀): 2 heads, 10 units (pre-seeded — unchanged)
    expect(ctr!.rightMembers).toBe(2n)
    expect(ctr!.rightUnits).toBe(10n)
    // T' = LEAST(8,10,5×LEAST(4,2)) = LEAST(8,10,10) = 8, B=LEAST(4,2)=2, surplus=6
    expect(ctr!.pairsMatched).toBe(6n)
    expect(await countCampaignPairs(anchorImg6Id)).toBe(6n)
    expect(await countOutboxAccruals(anchorImg6Id)).toBe(6n)
  }, 30_000)

  // ── Test 8: bushy-left vs chain-right ────────────────────────────────────
  // Left:  ₹50k@d1, ₹10k@d2, ₹10k@d2 (bushy): Lu=7, Lh=3
  // Right: ₹50k@d1 → ₹50k@d2 → ₹50k@d3 (chain): Ru=15, Rh=3
  // ₹50k earner: T'=LEAST(7,15,5×min(3,3))=LEAST(7,15,15)=7  B=LEAST(3,3)=3  surplus=4
  it('8. bushy-left vs chain-right: T\'=7, B=3 → surplus 4', async () => {
    const event = makeEvent(bcL2bId, 1, 1, 1_000_000)
    await applyCampaignUnits(event)

    const ctr = await getCounters(anchorBCId)
    expect(ctr).not.toBeNull()
    expect(ctr!.leftMembers).toBe(3n)
    expect(ctr!.rightMembers).toBe(3n)
    // T'=7  B=LEAST(3,3)=3  surplus=4
    expect(ctr!.pairsMatched).toBe(4n)
    expect(await countCampaignPairs(anchorBCId)).toBe(4n)
    expect(await countOutboxAccruals(anchorBCId)).toBe(4n)
  }, 30_000)

  // ── Test 9: ₹30k earner, 1×₹50k↔₹50k @d1 → surplus 2 ───────────────────
  // Line cap: min(5,5,3×1)=3; B=1; surplus=2.
  it('9. line-cap: ₹30k earner over ₹50k↔₹50k → 2 campaign pairs (not 4)', async () => {
    const event = makeEvent(childCap30LId, 1, 5, 5_000_000)
    await applyCampaignUnits(event)

    const ctr = await getCounters(anchorCap30Id)
    expect(ctr).not.toBeNull()
    // min(5,5,3×1)=3  B=1  surplus=2
    expect(ctr!.pairsMatched).toBe(2n)
    expect(await countCampaignPairs(anchorCap30Id)).toBe(2n)
  }, 30_000)

  // ── Test 10: ₹30k earner, 2×(₹50k@d1/₹50k@d2) → surplus 4 ─────────────
  // Lu=10, Ru=10, Lh=2, Rh=2, u_self=3.
  // T'=LEAST(10,10,3×2)=6  B=LEAST(2,2)=2  surplus=4.
  // Proves the u_self cap is not a lifetime cap: with 2 head-pairs, u_self×min(Lh,Rh)=6.
  it('10. ₹30k earner, 2×(₹50k@d1/₹50k@d2) → 4 campaign pairs', async () => {
    const event = makeEvent(childCap30x2L2Id, 1, 5, 5_000_000)
    await applyCampaignUnits(event)

    const ctr = await getCounters(anchorCap30x2Id)
    expect(ctr).not.toBeNull()
    expect(ctr!.leftMembers).toBe(2n)
    expect(ctr!.rightMembers).toBe(2n)
    // d1: min(5,5,3)=3  d2: min(5,5,3)=3  T'=6  B=2  surplus=4
    expect(ctr!.pairsMatched).toBe(4n)
    expect(await countCampaignPairs(anchorCap30x2Id)).toBe(4n)
    expect(await countOutboxAccruals(anchorCap30x2Id)).toBe(4n)
  }, 30_000)

  // ── Test 11: ₹50k earner, 2 depth lines of ₹50k↔₹50k → surplus 8 ─────────
  it('11. ₹50k earner, 2 depth lines → 8 campaign pairs', async () => {
    const event = makeEvent(childCap50x2L2Id, 1, 5, 5_000_000)
    await applyCampaignUnits(event)

    const ctr = await getCounters(anchorCap50x2Id)
    expect(ctr).not.toBeNull()
    // d1: min(5,5,5)=5  d2: min(5,5,5)=5  T'=10  B=2  surplus=8
    expect(ctr!.pairsMatched).toBe(8n)
    expect(await countCampaignPairs(anchorCap50x2Id)).toBe(8n)
    expect(await countOutboxAccruals(anchorCap50x2Id)).toBe(8n)
  }, 30_000)

  // ── Test 12: self-upgrade ₹10k → ₹30k ────────────────────────────────────
  // Part A: ₹10k earner, ₹50k↔₹50k @d1 → u_self=1 → T'=min(5,5,1)=1=B → surplus=0.
  // Part B: upgrade to ₹30k → self-recompute: T'=min(5,5,3)=3, B=1, surplus=2.
  it('12. self-upgrade ₹10k→₹30k earner: own node gains 2 campaign pairs', async () => {
    // Part A
    const eventA = makeEvent(childSelfUpLId, 1, 5, 5_000_000)
    await applyCampaignUnits(eventA)

    const ctrA = await getCounters(anchorSelfUpId)
    expect(ctrA).not.toBeNull()
    expect(ctrA!.pairsMatched).toBe(0n)
    expect(await countCampaignPairs(anchorSelfUpId)).toBe(0n)

    // Part B: ratchet DB tier to ₹30k then fire upgrade event
    await pool().query(
      `UPDATE members SET package_value_paise=3000000 WHERE id=$1`,
      [anchorSelfUpId],
    )
    const eventB = makeEvent(anchorSelfUpId, 0, 2, 3_000_000)
    await applyCampaignUnits(eventB)

    const ctrB = await getCounters(anchorSelfUpId)
    expect(ctrB).not.toBeNull()
    // self-node: T'=min(5,5,3)=3  B=LEAST(1,1)=1  surplus=2
    expect(ctrB!.pairsMatched).toBe(2n)
    expect(await countCampaignPairs(anchorSelfUpId)).toBe(2n)
    expect(await countOutboxAccruals(anchorSelfUpId)).toBe(2n)
  }, 30_000)
})
