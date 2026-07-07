import type { FastifyInstance } from 'fastify'
import { pool } from '../lib/db.js'

export async function adminRoutes(app: FastifyInstance) {
  // All admin routes require JWT for now; in prod, add role check.
  const auth = { preHandler: [app.authenticate] }

  app.get('/ranks', auth, async (req) => {
    const query = req.query as { status?: string }
    const status = query.status ?? 'pending'
    const { rows } = await pool().query(
      `SELECT ra.id, ra.member_id, m.member_code, m.name, ra.rank_level,
              ra.achieved_at, ra.verification_status, ra.fulfilled_at, ra.fulfillment_notes
       FROM rank_achievements ra
       JOIN members m ON m.id = ra.member_id
       WHERE ra.verification_status = $1
       ORDER BY ra.achieved_at ASC`,
      [status]
    )
    return rows
  })

  app.post('/ranks/:id/approve', auth, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as { notes?: string }
    const { rowCount } = await pool().query(
      `UPDATE rank_achievements
         SET verification_status = 'approved', fulfilled_at = now(), fulfillment_notes = $1
       WHERE id = $2 AND verification_status = 'pending'`,
      [body?.notes ?? null, id]
    )
    if (!rowCount || rowCount === 0) return reply.status(404).send({ error: 'Not found or already processed' })
    return { ok: true }
  })

  app.post('/ranks/:id/reject', auth, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as { notes?: string }
    const { rowCount } = await pool().query(
      `UPDATE rank_achievements
         SET verification_status = 'rejected', fulfillment_notes = $1
       WHERE id = $2 AND verification_status = 'pending'`,
      [body?.notes ?? null, id]
    )
    if (!rowCount || rowCount === 0) return reply.status(404).send({ error: 'Not found or already processed' })
    return { ok: true }
  })

  app.get('/withdrawals', auth, async () => {
    const { rows } = await pool().query(
      `SELECT w.id, m.member_code, m.name, w.amount, w.status, w.requested_at
       FROM withdrawals w JOIN members m ON m.id = w.member_id
       WHERE w.status = 'requested' ORDER BY w.requested_at ASC`
    )
    return rows
  })

  app.post('/withdrawals/:id/approve', auth, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { rowCount } = await pool().query(
      `UPDATE withdrawals SET status = 'approved', processed_at = now()
       WHERE id = $1 AND status = 'requested'`,
      [id]
    )
    if (!rowCount || rowCount === 0) return reply.status(404).send({ error: 'Not found' })
    return { ok: true }
  })

  app.post('/withdrawals/:id/reject', auth, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { rowCount } = await pool().query(
      `UPDATE withdrawals SET status = 'rejected', processed_at = now()
       WHERE id = $1 AND status = 'requested'`,
      [id]
    )
    if (!rowCount || rowCount === 0) return reply.status(404).send({ error: 'Not found' })
    return { ok: true }
  })
}
