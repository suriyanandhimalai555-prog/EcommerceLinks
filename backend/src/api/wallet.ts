import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pool } from '../lib/db.js'
import { toPaise, fromPaise } from '../lib/money.js'
import { CFG } from '../config.js'

const WithdrawalBody = z.object({ amount: z.number().positive().min(500) })

export async function walletRoutes(app: FastifyInstance) {
  app.get('/wallet', {
    preHandler: [app.authenticate],
  }, async (req) => {
    const user = req.user as { sub: string }
    const { rows } = await pool().query<{ balance: string }>(
      `SELECT wb.balance FROM wallet_balances wb
       JOIN accounts a ON a.id = wb.account_id
       WHERE a.owner_id = $1 AND a.kind = 'wallet'`,
      [user.sub]
    )
    const { rows: def } = await pool().query<{ balance: string }>(
      `SELECT wb.balance FROM wallet_balances wb
       JOIN accounts a ON a.id = wb.account_id
       WHERE a.owner_id = $1 AND a.kind = 'deferred_bonus'`,
      [user.sub]
    )
    return {
      balancePaise:  Number(toPaise(rows[0]?.balance ?? '0')),
      deferredPaise: Number(toPaise(def[0]?.balance ?? '0')),
    }
  })

  app.get('/wallet/ledger', {
    preHandler: [app.authenticate],
  }, async (req) => {
    const user = req.user as { sub: string }
    const query = req.query as { cursor?: string; limit?: string }
    const limit = Math.min(100, parseInt(query.limit ?? '20', 10))
    const cursorClause = query.cursor ? 'AND le.id < $3' : ''
    const params: (string | number)[] = [user.sub, limit]
    if (query.cursor) params.push(parseInt(query.cursor))

    const { rows } = await pool().query(
      `SELECT le.id, le.direction, le.amount, le.created_at, lt.reference_type, lt.reference_id
       FROM ledger_entries le
       JOIN ledger_txns lt ON lt.txn_id = le.txn_id
       JOIN accounts a ON a.id = le.account_id
       WHERE a.owner_id = $1 AND a.kind = 'wallet'
       ${cursorClause}
       ORDER BY le.id DESC LIMIT $2`,
      params
    )
    return {
      entries: rows.map((r) => ({
        id:            r.id,
        direction:     r.direction,
        amountPaise:   Number(toPaise(r.amount)),
        referenceType: r.reference_type,
        referenceId:   r.reference_id,
        at:            r.created_at,
      })),
      nextCursor: rows.length === limit ? String(rows[rows.length - 1].id) : null,
    }
  })

  app.post('/withdrawals', {
    preHandler: [app.authenticate],
  }, async (req, reply) => {
    const user = req.user as { sub: string }
    const body = WithdrawalBody.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: body.error.flatten() })

    const amountPaise = toPaise(body.data.amount)
    if (amountPaise < BigInt(CFG.MIN_PAYOUT_PAISE)) {
      return reply.status(400).send({ error: `Minimum withdrawal is ₹${CFG.MIN_PAYOUT_PAISE / 100}` })
    }

    // Check wallet balance
    const { rows } = await pool().query<{ balance: string }>(
      `SELECT wb.balance FROM wallet_balances wb
       JOIN accounts a ON a.id = wb.account_id
       WHERE a.owner_id = $1 AND a.kind = 'wallet'`,
      [user.sub]
    )
    if (!rows[0] || toPaise(rows[0].balance) < amountPaise) {
      return reply.status(400).send({ error: 'Insufficient balance' })
    }

    const { rows: ins } = await pool().query<{ id: string }>(
      `INSERT INTO withdrawals (member_id, amount) VALUES ($1,$2) RETURNING id`,
      [user.sub, fromPaise(amountPaise)]
    )
    return reply.status(201).send({ withdrawalId: ins[0].id })
  })

  app.get('/withdrawals', {
    preHandler: [app.authenticate],
  }, async (req) => {
    const user = req.user as { sub: string }
    const { rows } = await pool().query(
      'SELECT id, amount, status, requested_at, processed_at FROM withdrawals WHERE member_id = $1 ORDER BY id DESC LIMIT 50',
      [user.sub]
    )
    return rows.map((r) => ({
      id:           r.id,
      amountPaise:  Number(toPaise(r.amount)),
      status:       r.status,
      requestedAt:  r.requested_at,
      processedAt:  r.processed_at,
    }))
  })
}
