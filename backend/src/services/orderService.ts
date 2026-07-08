import { randomUUID } from 'crypto'
import { withTxn } from '../lib/db.js'
import { toPaise } from '../lib/money.js'
import { writeOutbox } from '../events/outbox.js'

/**
 * confirmOrder — confirm a payment gateway callback and, if this is the member's
 * first confirmed order, activate the member and emit MemberActivated.
 *
 * Idempotent: calling twice with the same gatewayEventId is safe (second call is a no-op).
 */
export async function confirmOrder(
  gatewayEventId: string,
  orderId: bigint,
  paymentRef: string,
): Promise<void> {
  await withTxn(async (c) => {
    const { rowCount, rows } = await c.query<{
      member_id: string; product_id: string; base_amount: string; status: string
    }>(
      `UPDATE orders SET status = 'confirmed', confirmed_at = now(), payment_ref = $1
       WHERE id = $2 AND idempotency_key = $3 AND status IN ('created','paid')
       RETURNING member_id, product_id, base_amount, status`,
      [paymentRef, orderId, gatewayEventId],
    )
    if (!rowCount || rowCount === 0) return // already confirmed or not found

    const { member_id, base_amount } = rows[0]
    const memberId = BigInt(member_id)
    const bvPaise = toPaise(base_amount)

    // Check if this is the member's first confirmed order
    const { rows: existingOrders } = await c.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM orders
       WHERE member_id = $1 AND status = 'confirmed' AND id != $2`,
      [memberId, orderId],
    )
    const isFirst = existingOrders[0].cnt === '0'

    if (isFirst) {
      await c.query(
        `UPDATE members SET is_active = TRUE, activated_at = now() WHERE id = $1`,
        [memberId],
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
