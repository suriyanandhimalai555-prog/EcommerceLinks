import type { FastifyInstance } from "fastify";
import { DateTime } from "luxon";
import { CFG } from "../config.js";
import { pool } from "../lib/db.js";
import { buildBatch } from "../workers/payout.js";

export async function adminRoutes(app: FastifyInstance) {
	const auth = { preHandler: [app.requireAdmin] };

	// ===== ranks =====
	app.get("/ranks", auth, async (req) => {
		const query = req.query as { status?: string };
		const status = query.status ?? "pending";
		const { rows } = await pool().query(
			`SELECT ra.id, ra.member_id, m.member_code, m.name, ra.rank_level,
              ra.achieved_at, ra.verification_status, ra.fulfilled_at, ra.fulfillment_notes
       FROM rank_achievements ra
       JOIN members m ON m.id = ra.member_id
       WHERE ra.verification_status = $1
       ORDER BY ra.achieved_at ASC`,
			[status],
		);
		return rows;
	});

	app.post("/ranks/:id/approve", auth, async (req, reply) => {
		const { id } = req.params as { id: string };
		const body = req.body as { notes?: string };
		const { rowCount } = await pool().query(
			`UPDATE rank_achievements
         SET verification_status = 'approved', fulfilled_at = now(), fulfillment_notes = $1
       WHERE id = $2 AND verification_status = 'pending'`,
			[body?.notes ?? null, id],
		);
		if (!rowCount || rowCount === 0)
			return reply
				.status(404)
				.send({ error: "Not found or already processed" });
		return { ok: true };
	});

	app.post("/ranks/:id/reject", auth, async (req, reply) => {
		const { id } = req.params as { id: string };
		const body = req.body as { notes?: string };
		const { rowCount } = await pool().query(
			`UPDATE rank_achievements
         SET verification_status = 'rejected', fulfillment_notes = $1
       WHERE id = $2 AND verification_status = 'pending'`,
			[body?.notes ?? null, id],
		);
		if (!rowCount || rowCount === 0)
			return reply
				.status(404)
				.send({ error: "Not found or already processed" });
		return { ok: true };
	});

	// ===== payouts =====
	// Manual trigger for the admin to kick off a payout batch for today.
	app.post("/payouts/trigger", auth, async (_req, reply) => {
		const now = DateTime.now().setZone(CFG.TZ);
		const batchId = await buildBatch(now);
		return reply.send({ ok: true, batchId: String(batchId) });
	});
}
