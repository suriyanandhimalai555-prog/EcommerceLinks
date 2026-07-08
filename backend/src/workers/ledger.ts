import { withTxn } from '../lib/db.js'
import { startConsumer } from '../lib/streams.js'
import { txnUuid } from '../lib/ids.js'
import { toPaise, fromPaise } from '../lib/money.js'
import { TOPICS } from '../events/topics.js'
import { CFG } from '../config.js'
import type { AvgEvent, PairMatched, DeferredSweepRequested } from '../events/types.js'
import type pg from 'pg'

const GROUP = 'avg-ledger'

interface LedgerLeg {
  accountId: bigint
  direction: 'D' | 'C'
  amountPaise: bigint
}

// Returns false if idempotencyKey already exists (skip). Enforces sum(D)=sum(C)>0.
export async function postLedgerTxn(
  c: pg.PoolClient,
  idempotencyKey: string,
  referenceType: string,
  referenceId: bigint | null,
  legs: LedgerLeg[]
): Promise<boolean> {
  const txnId = txnUuid(idempotencyKey)

  // Idempotency
  const { rows: existing } = await c.query(
    'SELECT 1 FROM ledger_txns WHERE idempotency_key=$1',
    [idempotencyKey]
  )
  if (existing.length > 0) return false

  // Validate: sum of debits === sum of credits
  const debitTotal  = legs.filter((l) => l.direction === 'D').reduce((s, l) => s + l.amountPaise, 0n)
  const creditTotal = legs.filter((l) => l.direction === 'C').reduce((s, l) => s + l.amountPaise, 0n)
  if (debitTotal !== creditTotal || debitTotal === 0n) {
    throw new Error(`Ledger imbalance: D=${debitTotal} C=${creditTotal}`)
  }

  await c.query(
    `INSERT INTO ledger_txns (txn_id, idempotency_key, reference_type, reference_id)
     VALUES ($1,$2,$3,$4)`,
    [txnId, idempotencyKey, referenceType, referenceId]
  )

  for (const leg of legs) {
    await c.query(
      `INSERT INTO ledger_entries (txn_id, account_id, direction, amount) VALUES ($1,$2,$3,$4)`,
      [txnId, leg.accountId, leg.direction, fromPaise(leg.amountPaise)]
    )
    // Update wallet_balances for wallet/deferred accounts
    const { rows: acRows } = await c.query<{ kind: string }>(
      'SELECT kind FROM accounts WHERE id=$1',
      [leg.accountId]
    )
    const kind = acRows[0]?.kind
    if (kind === 'wallet' || kind === 'deferred_bonus') {
      const signed = leg.direction === 'C'
        ? fromPaise(leg.amountPaise)
        : '-' + fromPaise(leg.amountPaise)
      await c.query(
        `UPDATE wallet_balances SET balance = balance + $1::numeric, updated_at = now() WHERE account_id = $2`,
        [signed, leg.accountId]
      )
    }
  }

  return true
}

export async function creditPairBonus(e: PairMatched): Promise<void> {
  await withTxn(async (c) => {
    // Idempotency check
    const { rows: done } = await c.query(
      'SELECT 1 FROM processed_events WHERE consumer_group=$1 AND event_id=$2',
      [GROUP, e.event_id]
    )
    if (done.length > 0) return

    const memberId  = BigInt(e.member_id)
    const bonusPaise = BigInt(CFG.PAIR_BONUS_PAISE)

    // Get member's wallet + deferred accounts
    const { rows: accs } = await c.query<{ id: string; kind: string }>(
      `SELECT id, kind FROM accounts WHERE owner_id=$1 AND kind IN ('wallet','deferred_bonus')`,
      [memberId]
    )
    const walletAccId   = BigInt(accs.find((a) => a.kind === 'wallet')!.id)
    const deferredAccId = BigInt(accs.find((a) => a.kind === 'deferred_bonus')!.id)

    // System bonus_expense account
    const { rows: sysAcc } = await c.query<{ id: string }>(
      `SELECT id FROM accounts WHERE owner_type='system' AND kind='bonus_expense'`
    )
    const expenseAccId = BigInt(sysAcc[0].id)

    // Get or create cutoff_earnings for open cutoff
    const { rows: cutoffRows } = await c.query<{ id: string }>(
      `SELECT id FROM cutoffs WHERE status='open' LIMIT 1`
    )
    if (!cutoffRows[0]) throw new Error('No open cutoff window')
    const cutoffId = BigInt(cutoffRows[0].id)

    // Lock cutoff_earnings row FOR UPDATE (insert if missing)
    await c.query(
      `INSERT INTO cutoff_earnings (member_id, cutoff_id) VALUES ($1,$2)
       ON CONFLICT DO NOTHING`,
      [memberId, cutoffId]
    )
    const { rows: ceRows } = await c.query<{ earned: string }>(
      `SELECT earned FROM cutoff_earnings WHERE member_id=$1 AND cutoff_id=$2 FOR UPDATE`,
      [memberId, cutoffId]
    )
    const alreadyEarned = toPaise(ceRows[0].earned)
    const cap = BigInt(CFG.CUTOFF_CAP_PAISE)
    const walletAmt  = bonusPaise < cap - alreadyEarned
      ? bonusPaise
      : (cap - alreadyEarned > 0n ? cap - alreadyEarned : 0n)
    const defAmt = bonusPaise - walletAmt

    const legs: LedgerLeg[] = [
      { accountId: expenseAccId, direction: 'D', amountPaise: bonusPaise },
    ]
    if (walletAmt > 0n) legs.push({ accountId: walletAccId,   direction: 'C', amountPaise: walletAmt })
    if (defAmt   > 0n) legs.push({ accountId: deferredAccId, direction: 'C', amountPaise: defAmt   })

    await postLedgerTxn(c, `pair:${e.pair_id}`, 'pair', BigInt(e.pair_id), legs)

    await c.query(
      `UPDATE cutoff_earnings
         SET earned   = earned   + $1,
             deferred = deferred + $2
       WHERE member_id=$3 AND cutoff_id=$4`,
      [fromPaise(walletAmt), fromPaise(defAmt), memberId, cutoffId]
    )

    await c.query(
      'INSERT INTO processed_events (consumer_group, event_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [GROUP, e.event_id]
    )
  })
}

export async function sweepDeferred(e: DeferredSweepRequested): Promise<void> {
  await withTxn(async (c) => {
    const { rows: done } = await c.query(
      'SELECT 1 FROM processed_events WHERE consumer_group=$1 AND event_id=$2',
      [GROUP, e.event_id]
    )
    if (done.length > 0) return

    const memberId  = BigInt(e.member_id)
    const newCutoff = BigInt(e.new_cutoff_id)

    const { rows: accs } = await c.query<{ id: string; kind: string }>(
      `SELECT id, kind FROM accounts WHERE owner_id=$1 AND kind IN ('wallet','deferred_bonus')`,
      [memberId]
    )
    const walletAccId   = BigInt(accs.find((a) => a.kind === 'wallet')!.id)
    const deferredAccId = BigInt(accs.find((a) => a.kind === 'deferred_bonus')!.id)

    // Check deferred balance
    const { rows: defBal } = await c.query<{ balance: string }>(
      'SELECT balance FROM wallet_balances WHERE account_id=$1 FOR UPDATE',
      [deferredAccId]
    )
    const deferred = toPaise(defBal[0]?.balance ?? '0')
    if (deferred === 0n) {
      await c.query(
        'INSERT INTO processed_events (consumer_group, event_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [GROUP, e.event_id]
      )
      return
    }

    // Get new window's earnings
    await c.query(
      `INSERT INTO cutoff_earnings (member_id, cutoff_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [memberId, newCutoff]
    )
    const { rows: newCE } = await c.query<{ earned: string }>(
      `SELECT earned FROM cutoff_earnings WHERE member_id=$1 AND cutoff_id=$2 FOR UPDATE`,
      [memberId, newCutoff]
    )
    const cap         = BigInt(CFG.CUTOFF_CAP_PAISE)
    const newEarned   = toPaise(newCE[0].earned)
    const moveAmt     = deferred < cap - newEarned ? deferred : (cap - newEarned > 0n ? cap - newEarned : 0n)

    if (moveAmt > 0n) {
      await postLedgerTxn(
        c,
        `sweep:${e.new_cutoff_id}:${memberId}`,
        'sweep',
        null,
        [
          { accountId: deferredAccId, direction: 'D', amountPaise: moveAmt },
          { accountId: walletAccId,   direction: 'C', amountPaise: moveAmt },
        ]
      )
      await c.query(
        `UPDATE cutoff_earnings SET earned = earned + $1 WHERE member_id=$2 AND cutoff_id=$3`,
        [fromPaise(moveAmt), memberId, newCutoff]
      )
    }

    await c.query(
      'INSERT INTO processed_events (consumer_group, event_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [GROUP, e.event_id]
    )
  })
}

export async function run() {
  await startConsumer({
    stream: TOPICS.ledger.name,
    group:  GROUP,
    mode:   'message',
    onMessage: async (value) => {
      const e = JSON.parse(value) as AvgEvent
      if (e.event_type === 'PairMatched')            await creditPairBonus(e)
      if (e.event_type === 'DeferredSweepRequested') await sweepDeferred(e)
    },
  })
}

const _argv1 = process.argv[1] ?? ''
if (_argv1.endsWith('ledger.ts') || _argv1.endsWith('ledger.js')) {
  run().catch((err) => {
    console.error('[ledger] fatal', err)
    process.exit(1)
  })
}
