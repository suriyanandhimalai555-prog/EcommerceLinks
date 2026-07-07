import { randomUUID } from 'crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pool, withTxn } from '../lib/db.js'
import { toPaise, fromPaise, pct } from '../lib/money.js'
import { writeOutbox } from '../events/outbox.js'
import { CFG } from '../config.js'

const CreateOrderBody = z.object({ productId: z.number().int().positive() })

const WebhookBody = z.object({
  gatewayEventId: z.string(),
  orderId:        z.number().int().positive(),
  paymentRef:     z.string(),
  status:         z.enum(['success', 'failed']),
})

export async function confirmOrder(
  gatewayEventId: string,
  orderId: bigint,
  paymentRef: string
): Promise<void> {
  await withTxn(async (c) => {
    // Idempotency: try to mark as confirmed; if already done, 0 rows → skip
    const { rowCount, rows } = await c.query<{
      member_id: string; product_id: string; base_amount: string; status: string
    }>(
      `UPDATE orders SET status = 'confirmed', confirmed_at = now(), payment_ref = $1
       WHERE id = $2 AND idempotency_key = $3 AND status IN ('created','paid')
       RETURNING member_id, product_id, base_amount, status`,
      [paymentRef, orderId, gatewayEventId]
    )
    if (!rowCount || rowCount === 0) return // already confirmed or not found

    const { member_id, base_amount } = rows[0]
    const memberId = BigInt(member_id)
    const bvPaise = toPaise(base_amount)

    // Check if this is the member's first confirmed order
    const { rows: existingOrders } = await c.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM orders
       WHERE member_id = $1 AND status = 'confirmed' AND id != $2`,
      [memberId, orderId]
    )
    const isFirst = existingOrders[0].cnt === '0'

    if (isFirst) {
      await c.query(
        `UPDATE members SET is_active = TRUE, activated_at = now() WHERE id = $1`,
        [memberId]
      )
      await writeOutbox(c, {
        event_id:       randomUUID(),
        event_type:     'MemberActivated',
        occurred_at:    new Date().toISOString(),
        schema_version: 1,
        member_id:      Number(memberId),
        order_id:       Number(orderId),
        bv_paise:       Number(bvPaise),
      })
    }
  })
}

export async function orderRoutes(app: FastifyInstance) {
  app.get('/products', async () => {
    const { rows } = await pool().query(
      'SELECT id, name, base_price FROM products WHERE active = TRUE ORDER BY id'
    )
    return rows.map((p) => ({
      id:          p.id,
      name:        p.name,
      basePaise:   Number(toPaise(p.base_price)),
      gstPaise:    Number(pct(toPaise(p.base_price), CFG.GST_PCT)),
      totalPaise:  Number(toPaise(p.base_price) + pct(toPaise(p.base_price), CFG.GST_PCT)),
    }))
  })

  app.post('/orders', {
    preHandler: [app.authenticate],
  }, async (req, reply) => {
    const user = req.user as { sub: string }
    const body = CreateOrderBody.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: body.error.flatten() })

    const { rows: pRows } = await pool().query<{ base_price: string }>(
      'SELECT base_price FROM products WHERE id = $1 AND active = TRUE',
      [body.data.productId]
    )
    if (!pRows[0]) return reply.status(404).send({ error: 'Product not found' })

    const basePaise  = toPaise(pRows[0].base_price)
    const gstPaise   = pct(basePaise, CFG.GST_PCT)
    const totalPaise = basePaise + gstPaise

    const idempotencyKey = randomUUID()

    const { rows } = await pool().query<{ id: string }>(
      `INSERT INTO orders (member_id, product_id, base_amount, gst_amount, total_amount, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [user.sub, body.data.productId, fromPaise(basePaise), fromPaise(gstPaise), fromPaise(totalPaise), idempotencyKey]
    )

    return reply.status(201).send({
      orderId:       rows[0].id,
      totalAmount:   fromPaise(totalPaise),
      paymentIntent: idempotencyKey,
    })
  })

  // PaymentProvider webhook — NOT authenticated (gateway calls this)
  app.post('/webhooks/payment', async (req, reply) => {
    const body = WebhookBody.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: body.error.flatten() })

    if (body.data.status === 'failed') {
      await pool().query(
        `UPDATE orders SET status = 'paid' WHERE id = $1 AND status = 'created'`,
        [body.data.orderId]
      )
      return { ok: true }
    }

    await confirmOrder(body.data.gatewayEventId, BigInt(body.data.orderId), body.data.paymentRef)
    return { ok: true }
  })
}
