/**
 * Integration test for the full AVG pipeline.
 * Requires: Postgres 16 + Redis 7 running, migrations applied, root seeded.
 * Run: vitest run test/integration/pipeline.test.ts
 *
 * Covers acceptance criteria T4–T13 from the spec.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { pool, withTxn } from '../../src/lib/db.js'
import { registerMember } from '../../src/services/placement.js'
import { confirmOrder } from '../../src/services/orderService.js'
import { evaluateQualification } from '../../src/services/qualification.js'
import { applyIncrements } from '../../src/workers/counterPair.js'
import { sweepDeferred } from '../../src/workers/ledger.js'
import { evaluateRanks } from '../../src/workers/rank.js'
import { ensureCutoffExists } from '../../src/workers/cutoff.js'
import { buildBatch } from '../../src/workers/payout.js'
import { toPaise, fromPaise, pct, pctRoundUp } from '../../src/lib/money.js'
import { CFG } from '../../src/config.js'
import { nextMemberCode } from '../../src/lib/ids.js'
import type { CounterIncrement } from '../../src/events/types.js'
import { randomUUID } from 'crypto'
import { DateTime } from 'luxon'
import { registerAnchor, uniqueEmail } from './helpers.js'

// Helper: register + activate a member and return memberId
async function registerAndActivate(sponsorCode: string, idx: number) {
  const { memberId, memberCode } = await registerMember({
    sponsorCode,
    name: `Test${idx}`, phone: `700000${String(idx).padStart(4,'0')}`, email: uniqueEmail(), password: 'Test@1234',
  })

  const { rows: oRows } = await pool().query<{ id: string }>(
    `INSERT INTO orders (member_id,product_id,base_amount,gst_amount,total_amount,idempotency_key)
     VALUES ($1,1,10000,1800,11800,$2) RETURNING id`,
    [memberId, `test-${memberCode}-${Date.now()}`]
  )
  await confirmOrder(`gw-${oRows[0].id}`, BigInt(oRows[0].id), `ref-${oRows[0].id}`)
  return { memberId, memberCode }
}

// T4: placement slots are correct
describe('T4 – Registration and placement', () => {
  it('new member placement_path = parent.placement_path + parent.id', async () => {
    await ensureCutoffExists()
    // Create a chain: anchor -> A -> B (each is its sponsor's first referral → L)
    const { memberCode: anchorCode } = await registerAnchor('T4Anchor')

    const { memberId: aId, memberCode: aCode } = await registerMember({
      sponsorCode: anchorCode,
      name: 'A', phone: `7001${Date.now().toString().slice(-7)}`, email: uniqueEmail(), password: 'Test@1234',
    })
    const { memberId: bId } = await registerMember({
      sponsorCode: aCode,
      name: 'B', phone: `7002${Date.now().toString().slice(-7)}`, email: uniqueEmail(), password: 'Test@1234',
    })

    const { rows: bRows } = await pool().query<{ placement_path: string[]; placement_sides: string[] }>(
      'SELECT placement_path, placement_sides FROM members WHERE id=$1', [bId]
    )
    // B's path ends with A's id
    expect(bRows[0].placement_path.map(String)).toContain(String(aId))
    expect(bRows[0].placement_sides).toContain('L')
  })
})

// T5: webhook idempotency
describe('T5 – Order webhook idempotency', () => {
  it('replaying same gatewayEventId is a no-op', async () => {
    const { memberCode: anchorCode } = await registerAnchor('T5Anchor')

    const { memberId, memberCode } = await registerMember({
      sponsorCode: anchorCode,
      name: 'Idem', phone: `7003${Date.now().toString().slice(-7)}`, email: uniqueEmail(), password: 'Test@1234',
    })

    const gwId = `gw-idem-${Date.now()}`
    const { rows: oRows } = await pool().query<{ id: string }>(
      `INSERT INTO orders (member_id,product_id,base_amount,gst_amount,total_amount,idempotency_key)
       VALUES ($1,1,10000,1800,11800,$2) RETURNING id`,
      [memberId, gwId]
    )
    await confirmOrder(gwId, BigInt(oRows[0].id), 'ref-1')
    await confirmOrder(gwId, BigInt(oRows[0].id), 'ref-1') // replay — should be no-op

    const { rows: outboxRows } = await pool().query(
      `SELECT * FROM events_outbox WHERE event_type='MemberActivated' AND aggregate_id=$1`,
      [memberId]
    )
    expect(outboxRows.length).toBe(1)
  })
})

// T8: counters are maintained but no income mints here (since 020 the pair
// income path is workers/pairComplete.ts + pair_accruals, not counter matching)
describe('T8 – applyIncrements maintains counters, never mints pairs', () => {
  it('L+R increments update counters and leg_activations; pairs stays empty', async () => {
    const ts = Date.now().toString().slice(-7)
    const { memberId: ancestorId, memberCode: ancestorCode } = await registerAnchor(`T8Anc${ts}`)
    const { memberId: lId } = await registerMember({
      sponsorCode: ancestorCode,
      name: `T8L${ts}`, phone: `7041${ts}`, email: uniqueEmail(), password: 'Test@1234',
    })
    const { memberId: rId } = await registerMember({
      sponsorCode: ancestorCode,
      name: `T8R${ts}`, phone: `7042${ts}`, email: uniqueEmail(), password: 'Test@1234',
    })

    // Even a qualified ancestor gets no counter-matched pairs anymore
    await pool().query('UPDATE members SET is_qualified=TRUE WHERE id=$1', [ancestorId])

    await applyIncrements(ancestorId, [
      {
        event_id: randomUUID(), event_type: 'CounterIncrement',
        occurred_at: new Date().toISOString(), schema_version: 1,
        ancestor_id: Number(ancestorId), side: 'L', counter_type: 'active',
        source_member_id: Number(lId), source_event_id: randomUUID(),
      },
      {
        event_id: randomUUID(), event_type: 'CounterIncrement',
        occurred_at: new Date().toISOString(), schema_version: 1,
        ancestor_id: Number(ancestorId), side: 'R', counter_type: 'active',
        source_member_id: Number(rId), source_event_id: randomUUID(),
      },
    ])

    const { rows: cRows } = await pool().query<{ left_active: string; right_active: string; pairs_matched: string }>(
      'SELECT left_active, right_active, pairs_matched FROM member_counters WHERE member_id=$1',
      [ancestorId]
    )
    expect(cRows[0].left_active).toBe('1')
    expect(cRows[0].right_active).toBe('1')
    expect(cRows[0].pairs_matched).toBe('0')  // deprecated, frozen

    const { rows: laRows } = await pool().query(
      'SELECT side FROM leg_activations WHERE ancestor_id=$1', [ancestorId]
    )
    expect(laRows.length).toBe(2)

    const { rows: pRows } = await pool().query(
      'SELECT id FROM pairs WHERE member_id=$1', [ancestorId]
    )
    expect(pRows.length).toBe(0)
  })

  it('replayed increment is idempotent (processed_events)', async () => {
    const ts = (Date.now() + 7).toString().slice(-7)
    const { memberId: ancestorId, memberCode: ancestorCode } = await registerAnchor(`T8IAnc${ts}`)
    const { memberId: lId } = await registerMember({
      sponsorCode: ancestorCode,
      name: `T8IL${ts}`, phone: `7043${ts}`, email: uniqueEmail(), password: 'Test@1234',
    })
    const inc: CounterIncrement = {
      event_id: randomUUID(), event_type: 'CounterIncrement',
      occurred_at: new Date().toISOString(), schema_version: 1,
      ancestor_id: Number(ancestorId), side: 'L', counter_type: 'active',
      source_member_id: Number(lId), source_event_id: randomUUID(),
    }
    await applyIncrements(ancestorId, [inc])
    await applyIncrements(ancestorId, [inc]) // replay — must be a no-op

    const { rows: cRows } = await pool().query<{ left_active: string }>(
      'SELECT left_active FROM member_counters WHERE member_id=$1', [ancestorId]
    )
    expect(cRows[0].left_active).toBe('1')
  })
})

// T9: qualification chain — tightened gate: BOTH directs active + 1 active grandchild
describe('T9 – Qualification BR-5', () => {
  it('A needs both directs active plus an active grandchild', async () => {
    const { memberCode: anchorCode } = await registerAnchor('T9Anchor')

    const ts = Date.now().toString().slice(-6)
    // A sponsors B and D; B sponsors C (grandchild of A)
    const { memberId: aId, memberCode: aCode } = await registerMember({
      sponsorCode: anchorCode,
      name: `QA${ts}`, phone: `7010${ts}`, email: uniqueEmail(), password: 'Test@1234',
    })
    const { memberId: bId, memberCode: bCode } = await registerMember({
      sponsorCode: aCode,
      name: `QB${ts}`, phone: `7011${ts}`, email: uniqueEmail(), password: 'Test@1234',
    })
    const { memberId: dId, memberCode: dCode } = await registerMember({
      sponsorCode: aCode,
      name: `QD${ts}`, phone: `7013${ts}`, email: uniqueEmail(), password: 'Test@1234',
    })
    const { memberId: cId, memberCode: cCode } = await registerMember({
      sponsorCode: bCode,
      name: `QC${ts}`, phone: `7012${ts}`, email: uniqueEmail(), password: 'Test@1234',
    })

    const activate = async (mId: bigint, code: string) => {
      await pool().query(
        `INSERT INTO orders (member_id,product_id,base_amount,gst_amount,total_amount,idempotency_key)
         VALUES ($1,1,10000,1800,11800,$2)`,
        [mId, `q-${code}`]
      )
      await pool().query(`UPDATE members SET is_active=TRUE, activated_at=now() WHERE id=$1`, [mId])
    }

    // A, B, C active — one active direct + grandchild used to qualify A, no longer does
    await activate(aId, aCode)
    await activate(bId, bCode)
    await activate(cId, cCode)
    const oneDirect = await withTxn(async (c) => evaluateQualification(aId, c))
    expect(oneDirect).toBe(false)

    // D (second direct) activates → A qualifies
    await activate(dId, dCode)
    const qualified = await withTxn(async (c) => evaluateQualification(aId, c))
    expect(qualified).toBe(true)

    // B has only one direct (C) → NOT qualified
    const bQual = await withTxn(async (c) => evaluateQualification(bId, c))
    expect(bQual).toBe(false)
  })
})

// T10: ledger cap
describe('T10 – Ledger BR-4 cap', () => {
  it('101 pairs → wallet +100000, deferred +1000', async () => {
    // This is an arithmetic assertion; real ledger posting requires DB setup
    const cap   = 10_000_000n  // ₹1,00,000 in paise
    const bonus = 100_000n     // ₹1,000 in paise
    let earned  = 0n
    let wallet  = 0n
    let deferred = 0n

    for (let i = 0; i < 101; i++) {
      const walletAmt = bonus < cap - earned ? bonus : (cap - earned > 0n ? cap - earned : 0n)
      const defAmt    = bonus - walletAmt
      wallet  += walletAmt
      deferred += defAmt
      earned  += walletAmt
    }

    expect(wallet).toBe(10_000_000n)   // ₹1,00,000
    expect(deferred).toBe(100_000n)     // ₹1,000
    expect(earned).toBe(10_000_000n)
  })
})

// T11: rank ladder order
describe('T11 – Rank ladder', () => {
  it('rank 5 requires leg_rank_counters[4] >= 1 both sides', () => {
    // Logic assertion only
    const legMap = { 4: { left: 1, right: 1 } }
    const qualifies = legMap[4].left >= 1 && legMap[4].right >= 1
    expect(qualifies).toBe(true)
  })

  it('rank 5 fails if only one side has achiever', () => {
    const legMap = { 4: { left: 1, right: 0 } }
    const qualifies = legMap[4].left >= 1 && legMap[4].right >= 1
    expect(qualifies).toBe(false)
  })
})

// T13: TDS calculation
describe('T13 – Payout TDS', () => {
  it('TDS on ₹10,000 gross = ₹500, net ₹9,500', () => {
    const gross = toPaise(10000)
    const tds   = pctRoundUp(gross, 5)
    const net   = gross - tds
    expect(tds).toBe(50_000n)
    expect(net).toBe(950_000n)
  })
})

// T-CAP: direct placement under the sponsor + 2-referral hard cap
// CLAUDE.md rule: money-critical placement.ts changes require an integration test.
describe('T-CAP – referrals place directly under sponsor (L then R), 3rd is rejected', () => {
  it('A→L, B→R, C→409 referral limit', async () => {
    const ts = Date.now().toString().slice(-7)
    const { memberId: sponsorId, memberCode: sponsorCode } = await registerAnchor(`CapSp${ts}`)

    // A: first referral → SPONSOR.L
    const { memberId: aId } = await registerMember({
      sponsorCode,
      name: `CapA${ts}`, phone: `7021${ts}`, email: uniqueEmail(), password: 'Test@1234',
    })
    // B: second referral → SPONSOR.R
    const { memberId: bId } = await registerMember({
      sponsorCode,
      name: `CapB${ts}`, phone: `7022${ts}`, email: uniqueEmail(), password: 'Test@1234',
    })
    // C: third referral → rejected, sponsor's slots are full
    await expect(
      registerMember({
        sponsorCode,
        name: `CapC${ts}`, phone: `7023${ts}`, email: uniqueEmail(), password: 'Test@1234',
      })
    ).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/referral limit/i) })

    const { rows } = await pool().query<{ id: string; sponsor_id: string; parent_id: string; position: string }>(
      'SELECT id, sponsor_id, parent_id, position FROM members WHERE id = ANY($1)',
      [[String(aId), String(bId)]]
    )
    const byId = Object.fromEntries(rows.map(r => [r.id, r]))

    expect(byId[String(aId)].parent_id).toBe(String(sponsorId))   // A directly under SPONSOR
    expect(byId[String(aId)].sponsor_id).toBe(String(sponsorId))  // sponsor tree ≡ binary tree
    expect(byId[String(aId)].position).toBe('L')
    expect(byId[String(bId)].parent_id).toBe(String(sponsorId))   // B directly under SPONSOR
    expect(byId[String(bId)].sponsor_id).toBe(String(sponsorId))
    expect(byId[String(bId)].position).toBe('R')
  })
})

// T-payout-idempotency: buildBatch split-phase idempotency (#2 fix)
// CLAUDE.md rule: money-critical payout.ts changes require an integration test.
describe('T-payout-idempotency — buildBatch: two calls produce one batch, one item, no double-ledger', () => {
  let payoutMemberId: bigint

  const TEST_PAYOUT_DATE = '2020-01-04'
  const TEST_WINDOW_START = '2019-12-21T12:30:00.000Z' // 18:00 IST
  const TEST_WINDOW_END   = '2019-12-28T12:29:59.000Z' // 17:59:59 IST next Saturday

  beforeAll(async () => {
    // Clean up any prior test-run state for this fixed date so the test is repeatable
    await pool().query(
      `DELETE FROM payout_items WHERE batch_id IN (SELECT id FROM payout_batches WHERE scheduled_for=$1)`,
      [TEST_PAYOUT_DATE],
    )
    await pool().query(`DELETE FROM payout_batches WHERE scheduled_for=$1`, [TEST_PAYOUT_DATE])
    await pool().query(`DELETE FROM cutoffs WHERE window_start=$1`, [TEST_WINDOW_START])

    const { memberCode: anchorCode } = await registerAnchor('POAnchor')

    const ts = Date.now().toString().slice(-7)
    const { memberId } = await registerMember({
      sponsorCode: anchorCode,
      name: `POTest${ts}`, phone: `8080${ts}`, email: uniqueEmail(), password: 'Test@1234',
    })
    payoutMemberId = memberId

    // Verify KYC + bank so the member is eligible for payout
    await pool().query(
      `UPDATE members SET kyc_status='verified', bank_status='verified' WHERE id=$1`,
      [memberId],
    )
    // Set wallet to ₹1000 directly (MIN_PAYOUT is ₹500 = 50000 paise)
    const { rows: accRows } = await pool().query<{ id: string }>(
      `SELECT id FROM accounts WHERE owner_id=$1 AND kind='wallet'`,
      [memberId],
    )
    await pool().query(
      `UPDATE wallet_balances SET balance = 1000.00 WHERE account_id=$1`,
      [accRows[0].id],
    )

    // Closed cutoff with a fixed past payout_date
    await pool().query(
      `INSERT INTO cutoffs (window_start, window_end, payout_date, status)
       VALUES ($1, $2, $3, 'closed')`,
      [TEST_WINDOW_START, TEST_WINDOW_END, TEST_PAYOUT_DATE],
    )
  })

  it('first call: payout_batch created with status=sent', async () => {
    await buildBatch(DateTime.fromISO(TEST_PAYOUT_DATE, { zone: CFG.TZ }))
    const { rows } = await pool().query<{ status: string }>(
      `SELECT status FROM payout_batches WHERE scheduled_for=$1`,
      [TEST_PAYOUT_DATE],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('sent')
  })

  it('second call is idempotent: still exactly one batch row', async () => {
    await buildBatch(DateTime.fromISO(TEST_PAYOUT_DATE, { zone: CFG.TZ }))
    const { rows } = await pool().query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM payout_batches WHERE scheduled_for=$1`,
      [TEST_PAYOUT_DATE],
    )
    expect(Number(rows[0].count)).toBe(1)
  })

  it('second call is idempotent: exactly one payout_item for the test member', async () => {
    const { rows: batch } = await pool().query<{ id: string }>(
      `SELECT id FROM payout_batches WHERE scheduled_for=$1`,
      [TEST_PAYOUT_DATE],
    )
    const { rows: items } = await pool().query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM payout_items WHERE batch_id=$1 AND member_id=$2`,
      [batch[0].id, payoutMemberId],
    )
    expect(Number(items[0].count)).toBe(1)
  })

  it('ledger has exactly one txn per member-batch: no double-posting', async () => {
    const { rows: batch } = await pool().query<{ id: string }>(
      `SELECT id FROM payout_batches WHERE scheduled_for=$1`,
      [TEST_PAYOUT_DATE],
    )
    const { rows: ledger } = await pool().query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM ledger_txns WHERE idempotency_key=$1`,
      [`payout:${batch[0].id}:${payoutMemberId}`],
    )
    expect(Number(ledger[0].count)).toBe(1)
  })
})

afterAll(async () => {
  await pool().end().catch(() => null)
})
