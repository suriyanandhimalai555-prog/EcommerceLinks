import { randomUUID } from "node:crypto";
import argon2 from "argon2";
import type { FastifyInstance } from "fastify";
import { DateTime } from "luxon";
import { z } from "zod";
import { CFG } from "../config.js";
import { pool, withTxn } from "../lib/db.js";
import { fromPaise } from "../lib/money.js";
import { postLedgerTxn } from "../workers/ledger.js";
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
		const actor = req.user as { sub: string };
		let updated = false;
		await withTxn(async (c) => {
			const { rowCount } = await c.query(
				`UPDATE rank_achievements
           SET verification_status = 'approved', fulfilled_at = now(), fulfillment_notes = $1
         WHERE id = $2 AND verification_status = 'pending'`,
				[body?.notes ?? null, id],
			);
			updated = (rowCount ?? 0) > 0;
			if (updated) {
				await c.query(
					`INSERT INTO admin_audit_log
             (actor_id, action, target_type, target_id, before_state, after_state)
           VALUES ($1,'rank_approve','rank_achievement',$2,NULL,$3)`,
					[actor.sub, id, { notes: body?.notes ?? null }],
				);
			}
		});
		if (!updated)
			return reply.status(404).send({ error: "Not found or already processed" });
		return { ok: true };
	});

	app.post("/ranks/:id/reject", auth, async (req, reply) => {
		const { id } = req.params as { id: string };
		const body = req.body as { notes?: string };
		const actor = req.user as { sub: string };
		let updated = false;
		await withTxn(async (c) => {
			const { rowCount } = await c.query(
				`UPDATE rank_achievements
           SET verification_status = 'rejected', fulfillment_notes = $1
         WHERE id = $2 AND verification_status = 'pending'`,
				[body?.notes ?? null, id],
			);
			updated = (rowCount ?? 0) > 0;
			if (updated) {
				await c.query(
					`INSERT INTO admin_audit_log
             (actor_id, action, target_type, target_id, before_state, after_state)
           VALUES ($1,'rank_reject','rank_achievement',$2,NULL,$3)`,
					[actor.sub, id, { notes: body?.notes ?? null }],
				);
			}
		});
		if (!updated)
			return reply.status(404).send({ error: "Not found or already processed" });
		return { ok: true };
	});

	// ===== payouts =====
	// buildBatch manages its own transaction; audit row is best-effort in a separate txn.
	app.post("/payouts/trigger", auth, async (req, reply) => {
		const now = DateTime.now().setZone(CFG.TZ);
		const actor = req.user as { sub: string };
		const batchId = await buildBatch(now);
		await pool().query(
			`INSERT INTO admin_audit_log
         (actor_id, action, target_type, target_id, before_state, after_state)
       VALUES ($1,'payout_trigger','payout_batch',$2,NULL,NULL)`,
			[actor.sub, String(batchId)],
		);
		return reply.send({ ok: true, batchId: String(batchId) });
	});

	// ===== member search =====
	app.get("/members", auth, async (req) => {
		const query = req.query as { q?: string; limit?: string };
		const q = query.q ?? "";
		const limit = Math.min(Number(query.limit ?? "50"), 200);
		const { rows } = await pool().query<{
			id: string;
			member_code: string;
			name: string;
			phone: string;
			email: string | null;
			is_active: boolean;
			is_qualified: boolean;
			role: string;
			kyc_status: string;
			bank_status: string;
			created_at: string;
		}>(
			`SELECT id, member_code, name, phone, email,
              is_active, is_qualified, role, kyc_status, bank_status, created_at
       FROM members
       WHERE name ILIKE $1 OR phone LIKE $2 OR member_code ILIKE $3
       ORDER BY created_at DESC
       LIMIT $4`,
			[`%${q}%`, `%${q}%`, `%${q}%`, limit],
		);
		return rows.map((m) => ({
			id: String(m.id),
			memberCode: m.member_code,
			name: m.name,
			phone: m.phone,
			email: m.email,
			isActive: m.is_active,
			isQualified: m.is_qualified,
			role: m.role,
			kycStatus: m.kyc_status,
			bankStatus: m.bank_status,
			createdAt: m.created_at,
		}));
	});

	// ===== member update (name/email/phone only — BR-11) =====
	const PatchMemberBody = z.object({
		name: z.string().min(1).optional(),
		email: z.string().email().nullable().optional(),
		phone: z.string().min(10).optional(),
	});

	app.patch("/members/:id", auth, async (req, reply) => {
		const { id } = req.params as { id: string };
		const body = PatchMemberBody.safeParse(req.body);
		if (!body.success)
			return reply.status(400).send({ error: body.error.flatten() });

		const actor = req.user as { sub: string };
		const d = body.data;

		const setClauses: string[] = [];
		const values: unknown[] = [];
		if (d.name !== undefined) setClauses.push(`name=$${values.push(d.name)}`);
		if (d.email !== undefined) setClauses.push(`email=$${values.push(d.email)}`);
		if (d.phone !== undefined) setClauses.push(`phone=$${values.push(d.phone)}`);

		if (setClauses.length === 0)
			return reply.status(400).send({ error: "No fields to update" });

		await withTxn(async (c) => {
			const { rows: before } = await c.query<{
				name: string;
				email: string | null;
				phone: string;
			}>(
				"SELECT name, email, phone FROM members WHERE id=$1 FOR UPDATE",
				[id],
			);
			if (!before[0])
				throw Object.assign(new Error("Member not found"), { statusCode: 404 });

			values.push(id);
			await c.query(
				`UPDATE members SET ${setClauses.join(", ")} WHERE id=$${values.length}`,
				values,
			);

			await c.query(
				`INSERT INTO admin_audit_log
           (actor_id, action, target_type, target_id, before_state, after_state)
         VALUES ($1,'patch_member','member',$2,$3,$4)`,
				[actor.sub, id, before[0], d],
			);
		});
		return { ok: true };
	});

	// ===== KYC status =====
	// kyc_status CHECK: ('pending','verified','rejected')
	const KycBody = z.object({
		status: z.enum(["pending", "verified", "rejected"]),
		notes: z.string().optional(),
	});

	app.post("/members/:id/kyc", auth, async (req, reply) => {
		const { id } = req.params as { id: string };
		const body = KycBody.safeParse(req.body);
		if (!body.success)
			return reply.status(400).send({ error: body.error.flatten() });

		const actor = req.user as { sub: string };

		await withTxn(async (c) => {
			const { rows: before } = await c.query<{ kyc_status: string }>(
				"SELECT kyc_status FROM members WHERE id=$1 FOR UPDATE",
				[id],
			);
			if (!before[0])
				throw Object.assign(new Error("Member not found"), { statusCode: 404 });

			await c.query("UPDATE members SET kyc_status=$1 WHERE id=$2", [
				body.data.status,
				id,
			]);

			await c.query(
				`INSERT INTO admin_audit_log
           (actor_id, action, target_type, target_id, before_state, after_state)
         VALUES ($1,'kyc_update','member',$2,$3,$4)`,
				[
					actor.sub,
					id,
					{ kyc_status: before[0].kyc_status },
					{ kyc_status: body.data.status, notes: body.data.notes },
				],
			);
		});
		return { ok: true };
	});

	// ===== Bank status =====
	// bank_status CHECK: ('pending','verified')
	const BankBody = z.object({
		status: z.enum(["pending", "verified"]),
		notes: z.string().optional(),
	});

	app.post("/members/:id/bank", auth, async (req, reply) => {
		const { id } = req.params as { id: string };
		const body = BankBody.safeParse(req.body);
		if (!body.success)
			return reply.status(400).send({ error: body.error.flatten() });

		const actor = req.user as { sub: string };

		await withTxn(async (c) => {
			const { rows: before } = await c.query<{ bank_status: string }>(
				"SELECT bank_status FROM members WHERE id=$1 FOR UPDATE",
				[id],
			);
			if (!before[0])
				throw Object.assign(new Error("Member not found"), { statusCode: 404 });

			await c.query("UPDATE members SET bank_status=$1 WHERE id=$2", [
				body.data.status,
				id,
			]);

			await c.query(
				`INSERT INTO admin_audit_log
           (actor_id, action, target_type, target_id, before_state, after_state)
         VALUES ($1,'bank_update','member',$2,$3,$4)`,
				[
					actor.sub,
					id,
					{ bank_status: before[0].bank_status },
					{ bank_status: body.data.status, notes: body.data.notes },
				],
			);
		});
		return { ok: true };
	});

	// ===== Wallet adjustment (BR-11: no direct wallet_balances write; use postLedgerTxn) =====
	const AdjustmentBody = z.object({
		amountPaise: z.number().int().positive(),
		direction: z.enum(["credit", "debit"]),
		notes: z.string().min(1),
	});

	app.post("/members/:id/adjustment", auth, async (req, reply) => {
		const { id } = req.params as { id: string };
		const body = AdjustmentBody.safeParse(req.body);
		if (!body.success)
			return reply.status(400).send({ error: body.error.flatten() });

		const actor = req.user as { sub: string };
		const { amountPaise, direction, notes } = body.data;
		const memberId = BigInt(id);
		const amt = BigInt(amountPaise);

		await withTxn(async (c) => {
			const { rows: accs } = await c.query<{ id: string }>(
				`SELECT id FROM accounts WHERE owner_id=$1 AND kind='wallet'`,
				[memberId],
			);
			if (!accs[0])
				throw Object.assign(new Error("Member wallet not found"), {
					statusCode: 404,
				});
			const walletAccId = BigInt(accs[0].id);

			const { rows: adjAcc } = await c.query<{ id: string }>(
				`SELECT id FROM accounts WHERE owner_type='system' AND kind='adjustment'`,
			);
			if (!adjAcc[0]) throw new Error("System adjustment account not found");
			const adjAccId = BigInt(adjAcc[0].id);

			const idemKey = `adj:${actor.sub}:${id}:${randomUUID()}`;

			const legs =
				direction === "credit"
					? [
							{
								accountId: adjAccId,
								direction: "D" as const,
								amountPaise: amt,
							},
							{
								accountId: walletAccId,
								direction: "C" as const,
								amountPaise: amt,
							},
						]
					: [
							{
								accountId: walletAccId,
								direction: "D" as const,
								amountPaise: amt,
							},
							{
								accountId: adjAccId,
								direction: "C" as const,
								amountPaise: amt,
							},
						];

			await postLedgerTxn(c, idemKey, "adjustment", memberId, legs);

			await c.query(
				`INSERT INTO admin_audit_log
           (actor_id, action, target_type, target_id, before_state, after_state)
         VALUES ($1,'adjustment','member',$2,NULL,$3)`,
				[actor.sub, id, { amountPaise, direction, notes }],
			);
		});
		return { ok: true };
	});

	// ===== Reset password =====
	const ResetPwBody = z.object({
		newPassword: z.string().min(8),
	});

	app.post("/members/:id/reset-password", auth, async (req, reply) => {
		const { id } = req.params as { id: string };
		const body = ResetPwBody.safeParse(req.body);
		if (!body.success)
			return reply.status(400).send({ error: body.error.flatten() });

		const actor = req.user as { sub: string };
		const hash = await argon2.hash(body.data.newPassword);

		await withTxn(async (c) => {
			const { rowCount } = await c.query(
				"UPDATE members SET password_hash=$1 WHERE id=$2",
				[hash, id],
			);
			if (!rowCount || rowCount === 0)
				throw Object.assign(new Error("Member not found"), { statusCode: 404 });

			await c.query(
				`INSERT INTO admin_audit_log
           (actor_id, action, target_type, target_id, before_state, after_state)
         VALUES ($1,'reset_password','member',$2,NULL,NULL)`,
				[actor.sub, id],
			);
		});
		return { ok: true };
	});

	// ===== Role change (root only — actor must have parent_id IS NULL) =====
	const RoleBody = z.object({
		role: z.enum(["member", "admin"]),
	});

	app.post("/members/:id/role", auth, async (req, reply) => {
		const { id } = req.params as { id: string };
		const body = RoleBody.safeParse(req.body);
		if (!body.success)
			return reply.status(400).send({ error: body.error.flatten() });

		const actor = req.user as { sub: string };

		const { rows: actorRows } = await pool().query<{ parent_id: string | null }>(
			"SELECT parent_id FROM members WHERE id=$1",
			[actor.sub],
		);
		if (!actorRows[0] || actorRows[0].parent_id !== null)
			return reply.status(403).send({ error: "Root only" });

		await withTxn(async (c) => {
			const { rows: before } = await c.query<{ role: string }>(
				"SELECT role FROM members WHERE id=$1 FOR UPDATE",
				[id],
			);
			if (!before[0])
				throw Object.assign(new Error("Member not found"), { statusCode: 404 });

			await c.query("UPDATE members SET role=$1 WHERE id=$2", [
				body.data.role,
				id,
			]);

			await c.query(
				`INSERT INTO admin_audit_log
           (actor_id, action, target_type, target_id, before_state, after_state)
         VALUES ($1,'role_change','member',$2,$3,$4)`,
				[
					actor.sub,
					id,
					{ role: before[0].role },
					{ role: body.data.role },
				],
			);
		});
		return { ok: true };
	});

	// ===== Audit log =====
	app.get("/audit-log", auth, async (req) => {
		const query = req.query as {
			target_id?: string;
			limit?: string;
			offset?: string;
		};
		const limit = Math.min(Number(query.limit ?? "50"), 200);
		const offset = Number(query.offset ?? "0");

		const conditions: string[] = [];
		const values: unknown[] = [];
		if (query.target_id)
			conditions.push(`al.target_id=$${values.push(query.target_id)}`);

		const where = conditions.length
			? `WHERE ${conditions.join(" AND ")}`
			: "";
		values.push(limit);
		values.push(offset);

		const { rows } = await pool().query(
			`SELECT al.id, al.actor_id, m.name AS actor_name, al.action,
              al.target_type, al.target_id, al.before_state, al.after_state, al.created_at
       FROM admin_audit_log al
       JOIN members m ON m.id = al.actor_id
       ${where}
       ORDER BY al.created_at DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
			values,
		);
		return rows.map((r) => ({
			id: String(r.id),
			actorId: String(r.actor_id),
			actorName: r.actor_name,
			action: r.action,
			targetType: r.target_type,
			targetId: r.target_id ? String(r.target_id) : null,
			beforeState: r.before_state,
			afterState: r.after_state,
			createdAt: r.created_at,
		}));
	});
}
