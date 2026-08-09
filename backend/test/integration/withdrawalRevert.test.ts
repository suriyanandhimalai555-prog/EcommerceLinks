/**
 * Money-critical: reverting a PAID withdrawal back to PENDING.
 * Requires: Postgres 16 + Redis 7, migrations applied, root seeded.
 *
 * Proves the accounting stays exact across approve → revert → re-approve:
 *   - approve posts wdpay:<id>:0 (bank/tds credited, hold released)
 *   - revert posts the exact inverse wdrevert:<id>:0, restores the hold,
 *     clears tds/net/bank_ref/processed_*, bumps payout_seq (proofs are kept)
 *   - re-approve posts a FRESH wdpay:<id>:1 (no idempotency-key collision) so
 *     the money moves again
 *   - per-withdrawal ledger is always balanced (SUM(D)=SUM(C)); payout_clearing
 *     nets to zero across the full cycle.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { app } from '../../src/api/server.js'
import { pool, withTxn } from '../../src/lib/db.js'
import { postLedgerTxn } from '../../src/workers/ledger.js'
import { registerAnchor, uniqueEmail, uniquePhone } from './helpers.js'

let mgmtToken: string
let memberId: string
let memberCode: string
let withdrawalId: string
const GROSS_PAISE = 100000n // ₹1000

async function sysAcc(kind: string): Promise<bigint> {
  const { rows } = await pool().query<{ id: string }>(
    `SELECT id FROM accounts WHERE owner_type='system' AND kind=$1`, [kind],
  )
  return BigInt(rows[0].id)
}
async function memberAcc(id: string, kind: string): Promise<bigint> {
  const { rows } = await pool().query<{ id: string }>(
    `SELECT id FROM accounts WHERE owner_id=$1 AND kind=$2`, [id, kind],
  )
  return BigInt(rows[0].id)
}
/** Balance of a system account contributed by txns referencing this withdrawal. */
async function paidWithdrawalRefBalance(kind: string): Promise<bigint> {
  const { rows } = await pool().query<{ bal: string }>(
    `SELECT COALESCE(SUM(CASE WHEN le.direction='C' THEN le.amount ELSE -le.amount END),0) AS bal
       FROM ledger_entries le
       JOIN ledger_txns t ON t.txn_id = le.txn_id
       JOIN accounts a ON a.id = le.account_id
      WHERE a.owner_type='system' AND a.kind=$1
        AND t.reference_type='withdrawal' AND t.reference_id=$2`,
    [kind, withdrawalId],
  )
  // paise
  return BigInt(Math.round(Number(rows[0].bal) * 100))
}

beforeAll(async () => {
  await app.ready()

  const argon2 = (await import('argon2')).default
  const mgmtEmail = uniqueEmail('mgmtwdrev')
  await pool().query(
    `INSERT INTO members
       (member_code, name, phone, email, password_hash,
        sponsor_id, parent_id, position, placement_path, placement_sides, is_active, role)
     VALUES ($1,'WdRev Mgmt',$2,$3,$4,NULL,NULL,NULL,'{}','{}',TRUE,'management')`,
    [`TSTWR${Date.now().toString().slice(-6)}`, uniquePhone('9'), mgmtEmail,
     await argon2.hash('Mgmt@12345')],
  )
  mgmtToken = JSON.parse((await app.inject({
    method: 'POST', url: '/auth/login',
    payload: { email: mgmtEmail, password: 'Mgmt@12345' },
  })).body).accessToken

  // Member who will hold a pending payout; KYC + bank verified so approve passes.
  const anchor = await registerAnchor('WdRevMember')
  memberId = String(anchor.memberId)
  memberCode = anchor.memberCode
  await pool().query(
    `UPDATE members SET kyc_status='verified', bank_status='verified' WHERE id=$1`,
    [memberId],
  )

  // Build the pending state exactly like the auto-payout sweep:
  //   fund withdrawable (D adjustment / C withdrawable), then hold it
  //   (D withdrawable / C payout_clearing), then insert the pending row.
  const adjustment = await sysAcc('adjustment')
  const payoutClearing = await sysAcc('payout_clearing')
  const withdrawable = await memberAcc(memberId, 'withdrawable')
  const { rows: wd } = await pool().query<{ id: string }>(
    `INSERT INTO withdrawals (member_id, amount, status) VALUES ($1,$2,'pending') RETURNING id`,
    [memberId, (Number(GROSS_PAISE) / 100).toFixed(2)],
  )
  withdrawalId = wd[0].id

  await withTxn(async (c) => {
    await postLedgerTxn(c, `test-fund:${withdrawalId}`, 'test-setup', null, [
      { accountId: adjustment, direction: 'D', amountPaise: GROSS_PAISE },
      { accountId: withdrawable, direction: 'C', amountPaise: GROSS_PAISE },
    ])
    await postLedgerTxn(c, `test-hold:${withdrawalId}`, 'withdrawal', BigInt(withdrawalId), [
      { accountId: withdrawable, direction: 'D', amountPaise: GROSS_PAISE },
      { accountId: payoutClearing, direction: 'C', amountPaise: GROSS_PAISE },
    ])
  })
})

afterAll(async () => {
  await app.close()
  await pool().end().catch(() => null)
})

async function approve() {
  return app.inject({
    method: 'POST', url: `/admin/withdrawals/${withdrawalId}/approve`,
    headers: { authorization: `Bearer ${mgmtToken}` },
    payload: { bankRef: 'UTR-TEST' },
  })
}

describe('withdrawal revert (paid → pending)', () => {
  it('approve marks paid and posts wdpay:<id>:0', async () => {
    const res = await approve()
    expect(res.statusCode).toBe(200)
    const { rows } = await pool().query<{ status: string; tds: string; net: string; payout_seq: number }>(
      `SELECT status, tds, net, payout_seq FROM withdrawals WHERE id=$1`, [withdrawalId],
    )
    expect(rows[0].status).toBe('paid')
    expect(rows[0].payout_seq).toBe(0)
    // tds = 10% of gross, net = gross - tds
    expect(Number(rows[0].tds)).toBeCloseTo(100, 2)
    expect(Number(rows[0].net)).toBeCloseTo(900, 2)
    const { rows: k } = await pool().query(
      `SELECT 1 FROM ledger_txns WHERE idempotency_key=$1`, [`wdpay:${withdrawalId}:0`],
    )
    expect(k.length).toBe(1)
  })

  it('revert returns it to pending, clears fields, bumps seq, restores hold', async () => {
    const res = await app.inject({
      method: 'POST', url: `/admin/withdrawals/${withdrawalId}/revert`,
      headers: { authorization: `Bearer ${mgmtToken}` },
      payload: { notes: 'marked paid by mistake' },
    })
    expect(res.statusCode).toBe(200)
    const { rows } = await pool().query<{
      status: string; tds: string | null; net: string | null; bank_ref: string | null;
      processed_by: string | null; processed_at: string | null; payout_seq: number
    }>(`SELECT status, tds, net, bank_ref, processed_by, processed_at, payout_seq FROM withdrawals WHERE id=$1`, [withdrawalId])
    expect(rows[0].status).toBe('pending')
    expect(rows[0].tds).toBeNull()
    expect(rows[0].net).toBeNull()
    expect(rows[0].bank_ref).toBeNull()
    expect(rows[0].processed_by).toBeNull()
    expect(rows[0].processed_at).toBeNull()
    expect(rows[0].payout_seq).toBe(1)
    const { rows: k } = await pool().query(
      `SELECT 1 FROM ledger_txns WHERE idempotency_key=$1`, [`wdrevert:${withdrawalId}:0`],
    )
    expect(k.length).toBe(1)
    // Cannot revert twice (409 — no longer paid).
    const again = await app.inject({
      method: 'POST', url: `/admin/withdrawals/${withdrawalId}/revert`,
      headers: { authorization: `Bearer ${mgmtToken}` }, payload: {},
    })
    expect(again.statusCode).toBe(409)
  })

  it('re-approve posts a FRESH wdpay:<id>:1 and pays again', async () => {
    const res = await approve()
    expect(res.statusCode).toBe(200)
    const { rows } = await pool().query<{ status: string; payout_seq: number }>(
      `SELECT status, payout_seq FROM withdrawals WHERE id=$1`, [withdrawalId],
    )
    expect(rows[0].status).toBe('paid')
    expect(rows[0].payout_seq).toBe(1)
    const { rows: k } = await pool().query(
      `SELECT 1 FROM ledger_txns WHERE idempotency_key=$1`, [`wdpay:${withdrawalId}:1`],
    )
    expect(k.length).toBe(1)
  })

  it('ledger stays balanced: payout_clearing nets to zero, bank/tds hold net/tds', async () => {
    // Per-withdrawal double-entry must balance.
    const { rows: bal } = await pool().query<{ d: string; cr: string }>(
      `SELECT COALESCE(SUM(le.amount) FILTER (WHERE le.direction='D'),0) AS d,
              COALESCE(SUM(le.amount) FILTER (WHERE le.direction='C'),0) AS cr
         FROM ledger_entries le
         JOIN ledger_txns t ON t.txn_id = le.txn_id
        WHERE t.reference_type='withdrawal' AND t.reference_id=$1`,
      [withdrawalId],
    )
    expect(Number(bal[0].d)).toBeCloseTo(Number(bal[0].cr), 2)

    // hold(+g) → approve(-g) → revert(+g) → approve(-g) = 0
    expect(await paidWithdrawalRefBalance('payout_clearing')).toBe(0n)
    // bank recorded once (net), tds once (tds) after the final approve
    expect(await paidWithdrawalRefBalance('bank')).toBe(90000n)
    expect(await paidWithdrawalRefBalance('tds_payable')).toBe(10000n)

    // Member withdrawable back to 0 (money sits in the recorded-paid state).
    const wAcc = await memberAcc(memberId, 'withdrawable')
    const { rows: wb } = await pool().query<{ balance: string }>(
      `SELECT balance FROM wallet_balances WHERE account_id=$1`, [wAcc],
    )
    expect(Number(wb[0].balance)).toBeCloseTo(0, 2)
  })

  it('shows only the current attempt proof after revert+re-approve (payout_seq scoping)', async () => {
    // The withdrawal is paid at payout_seq=1 (approve→revert→re-approve above).
    // Seed one stale proof from attempt 0 and one from the current attempt 1.
    await pool().query(
      `INSERT INTO withdrawal_payment_proofs (withdrawal_id, s3_key, payout_seq)
       VALUES ($1,'proofs/old-seq0.jpg',0), ($1,'proofs/new-seq1.jpg',1)`,
      [withdrawalId],
    )

    const res = await app.inject({
      method: 'GET',
      url: `/admin/withdrawals?status=paid&q=${memberCode}&page=1&limit=20`,
      headers: { authorization: `Bearer ${mgmtToken}` },
    })
    expect(res.statusCode).toBe(200)
    const row = JSON.parse(res.body).items.find((i: { id: string }) => i.id === withdrawalId)
    expect(row).toBeTruthy()
    // Only the seq-1 proof is surfaced; the seq-0 one is hidden, not deleted.
    expect(row.proofUrls.length).toBe(1)

    const { rows: cnt } = await pool().query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM withdrawal_payment_proofs WHERE withdrawal_id=$1`,
      [withdrawalId],
    )
    expect(cnt[0].n).toBe(2) // both retained in the DB
  })
})
