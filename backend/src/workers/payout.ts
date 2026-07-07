import { writeFile, mkdir } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'
import { DateTime } from 'luxon'
import { pool, withTxn } from '../lib/db.js'
import { writeOutbox } from '../events/outbox.js'
import { postLedgerTxn } from './ledger.js'
import { toPaise, fromPaise, pctRoundUp } from '../lib/money.js'
import { CFG } from '../config.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR   = join(__dirname, '..', '..', 'out', 'payouts')

export async function buildBatch(saturday: DateTime): Promise<bigint> {
  const dateStr = saturday.toISODate()!
  return withTxn(async (c) => {
    // Idempotent: one batch per date
    const { rows: existing } = await c.query<{ id: string }>(
      `INSERT INTO payout_batches (scheduled_for, status) VALUES ($1,'building')
       ON CONFLICT (scheduled_for) DO NOTHING RETURNING id`,
      [dateStr]
    )
    let batchId: bigint
    if (existing[0]) {
      batchId = BigInt(existing[0].id)
    } else {
      const { rows } = await c.query<{ id: string }>(
        'SELECT id FROM payout_batches WHERE scheduled_for=$1', [dateStr]
      )
      batchId = BigInt(rows[0].id)
    }

    // Get system accounts
    const { rows: sysAccs } = await c.query<{ id: string; kind: string }>(
      `SELECT id, kind FROM accounts WHERE owner_type='system'`
    )
    const payoutClearingId = BigInt(sysAccs.find((a) => a.kind === 'payout_clearing')!.id)
    const tdsPayableId     = BigInt(sysAccs.find((a) => a.kind === 'tds_payable')!.id)

    // Eligible members: kyc+bank verified, wallet ≥ MIN
    const minRupees = fromPaise(BigInt(CFG.MIN_PAYOUT_PAISE))
    const { rows: eligible } = await c.query<{
      member_id: string; member_code: string; name: string; wallet_account_id: string; balance: string
    }>(
      `SELECT m.id AS member_id, m.member_code, m.name,
              a.id AS wallet_account_id, wb.balance
       FROM members m
       JOIN accounts a ON a.owner_id = m.id AND a.kind='wallet'
       JOIN wallet_balances wb ON wb.account_id = a.id
       WHERE m.kyc_status='verified'
         AND m.bank_status='verified'
         AND wb.balance >= $1`,
      [minRupees]
    )

    const csvLines: string[] = ['member_code,name,gross,tds,net']
    let totalNetPaise = 0n

    for (const row of eligible) {
      const memberId    = BigInt(row.member_id)
      const walletAccId = BigInt(row.wallet_account_id)
      const grossPaise  = toPaise(row.balance)
      const tdsPaise    = pctRoundUp(grossPaise, CFG.TDS_PCT)
      const netPaise    = grossPaise - tdsPaise

      // Insert payout_item (idempotent on batch+member)
      const { rows: itemIns } = await c.query<{ id: string }>(
        `INSERT INTO payout_items (batch_id, member_id, gross, tds, net)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (batch_id, member_id) DO NOTHING RETURNING id`,
        [batchId, memberId, fromPaise(grossPaise), fromPaise(tdsPaise), fromPaise(netPaise)]
      )
      if (!itemIns[0]) continue // already built

      const itemId = BigInt(itemIns[0].id)

      await postLedgerTxn(c, `payout:${batchId}:${memberId}`, 'payout_item', itemId, [
        { accountId: walletAccId,      direction: 'D', amountPaise: grossPaise },
        { accountId: payoutClearingId, direction: 'C', amountPaise: netPaise   },
        { accountId: tdsPayableId,     direction: 'C', amountPaise: tdsPaise   },
      ])

      csvLines.push(`${row.member_code},${row.name},${fromPaise(grossPaise)},${fromPaise(tdsPaise)},${fromPaise(netPaise)}`)
      totalNetPaise += netPaise
    }

    // Write CSV bank file
    await mkdir(OUT_DIR, { recursive: true })
    const csvPath = join(OUT_DIR, `${dateStr}.csv`)
    await writeFile(csvPath, csvLines.join('\n'), 'utf-8')

    // Mark batch as sent + record file ref
    await c.query(
      `UPDATE payout_batches SET status='sent', bank_file_ref=$1 WHERE id=$2`,
      [csvPath, batchId]
    )

    await writeOutbox(c, {
      event_id:        randomUUID(),
      event_type:      'PayoutBatchCreated',
      occurred_at:     new Date().toISOString(),
      schema_version:  1,
      batch_id:        Number(batchId),
      scheduled_for:   dateStr,
      item_count:      eligible.length,
      total_net_paise: Number(totalNetPaise),
    })

    return batchId
  })
}

export async function ingestSettlement(
  batchId: bigint,
  results: { memberId: bigint; ok: boolean; bankRef?: string; reason?: string }[]
): Promise<void> {
  const { rows: sysAccs } = await pool().query<{ id: string; kind: string }>(
    `SELECT id, kind FROM accounts WHERE owner_type='system'`
  )
  const payoutClearingId = BigInt(sysAccs.find((a) => a.kind === 'payout_clearing')!.id)
  const bankAccId        = BigInt(sysAccs.find((a) => a.kind === 'bank')!.id)

  for (const result of results) {
    await withTxn(async (c) => {
      const { rows: item } = await c.query<{
        id: string; net: string; member_id: string; status: string
      }>(
        `SELECT id, net, member_id, status FROM payout_items
         WHERE batch_id=$1 AND member_id=$2`,
        [batchId, result.memberId]
      )
      if (!item[0] || item[0].status !== 'pending') return

      const itemId   = BigInt(item[0].id)
      const netPaise = toPaise(item[0].net)

      if (result.ok) {
        await postLedgerTxn(c, `settle:${itemId}`, 'payout_item', itemId, [
          { accountId: payoutClearingId, direction: 'D', amountPaise: netPaise },
          { accountId: bankAccId,        direction: 'C', amountPaise: netPaise },
        ])
        await c.query(
          `UPDATE payout_items SET status='settled', bank_ref=$1 WHERE id=$2`,
          [result.bankRef ?? null, itemId]
        )
        await writeOutbox(c, {
          event_id:        randomUUID(),
          event_type:      'PayoutItemSettled',
          occurred_at:     new Date().toISOString(),
          schema_version:  1,
          payout_item_id:  Number(itemId),
          member_id:       Number(result.memberId),
          net_paise:       Number(netPaise),
          bank_ref:        result.bankRef ?? '',
        })
      } else {
        // Re-credit wallet
        const { rows: accs } = await c.query<{ id: string }>(
          `SELECT id FROM accounts WHERE owner_id=$1 AND kind='wallet'`,
          [result.memberId]
        )
        const walletAccId = BigInt(accs[0].id)
        await postLedgerTxn(c, `payoutfail:${itemId}`, 'payout_item', itemId, [
          { accountId: payoutClearingId, direction: 'D', amountPaise: netPaise },
          { accountId: walletAccId,      direction: 'C', amountPaise: netPaise },
        ])
        await c.query(
          `UPDATE payout_items SET status='failed', failure_reason=$1 WHERE id=$2`,
          [result.reason ?? 'unknown', itemId]
        )
        await writeOutbox(c, {
          event_id:        randomUUID(),
          event_type:      'PayoutItemFailed',
          occurred_at:     new Date().toISOString(),
          schema_version:  1,
          payout_item_id:  Number(itemId),
          member_id:       Number(result.memberId),
          net_paise:       Number(netPaise),
          reason:          result.reason ?? 'unknown',
        })
      }
    })
  }
}

// Cron: Saturday 18:30 IST
async function run() {
  console.log('[payout] started')
  setInterval(async () => {
    try {
      const now = DateTime.now().setZone(CFG.TZ)
      if (now.weekday === 6 && now.hour === 18 && now.minute === 30 && now.second < 60) {
        console.log('[payout] building batch for', now.toISODate())
        await buildBatch(now)
        console.log('[payout] batch built')
      }
    } catch (err) {
      console.error('[payout] error in tick', err)
    }
  }, 60_000)
}

run().catch((err) => {
  console.error('[payout] fatal', err)
  process.exit(1)
})
