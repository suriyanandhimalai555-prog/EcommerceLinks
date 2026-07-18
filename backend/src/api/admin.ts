import { randomUUID } from "node:crypto";
import argon2 from "argon2";
import type { FastifyInstance } from "fastify";
import { DateTime } from "luxon";
import { z } from "zod";
import { CFG } from "../config.js";
import { pool, withTxn } from "../lib/db.js";
import { getAllSettings, setSetting } from "../services/settings.js";
import { toPaise } from "../lib/money.js";
// DLQ replay is a sanctioned re-delivery of an already-published event — not a
// new producer; consumers stay safe via processed_events idempotency.
import {
	buildKey,
	IMAGE_CONTENT_TYPES,
	MAX_UPLOAD_BYTES,
	presignGet,
	presignUpload,
	s3Configured,
} from "../lib/s3.js";
import { publishToStream } from "../lib/streams.js";
import {
	createProduct,
	listAdminProducts,
	updateProduct,
} from "../services/productService.js";
import { postLedgerTxn } from "../workers/ledger.js";
import { buildBatch } from "../workers/payout.js";
import { confirmOrder } from "../services/orderService.js";

export async function adminRoutes(app: FastifyInstance) {
	const auth = { preHandler: [app.requireAdmin] };

	// Product catalog mutations are reserved for the management master account
	// (same live-lookup pattern as the role-change route below).
	async function isManagement(actorId: string): Promise<boolean> {
		const { rows } = await pool().query<{ role: string }>(
			"SELECT role FROM members WHERE id=$1",
			[actorId],
		);
		return rows[0]?.role === "management";
	}

	// ===== products (catalog managed by management) =====
	app.get("/products", auth, async () => {
		return listAdminProducts();
	});

	const PresignBody = z.object({
		contentType: z.enum(IMAGE_CONTENT_TYPES),
		sizeBytes: z.number().int().positive().max(MAX_UPLOAD_BYTES),
	});

	app.post("/products/images/presign", auth, async (req, reply) => {
		const body = PresignBody.safeParse(req.body);
		if (!body.success)
			return reply.status(400).send({ error: body.error.flatten() });
		const actor = req.user as { sub: string };
		if (!(await isManagement(actor.sub)))
			return reply.status(403).send({ error: "Management only" });
		if (!s3Configured())
			return reply.status(503).send({ error: "S3_NOT_CONFIGURED" });

		const key = buildKey("products", body.data.contentType);
		return presignUpload(key, body.data.contentType);
	});

	const ProductBody = z.object({
		name: z.string().min(1).max(120),
		description: z.string().max(5000).default(""),
		basePricePaise: z.number().int().positive(),
		active: z.boolean().default(true),
		imageKeys: z.array(z.string()).max(8).default([]),
	});

	app.post("/products", auth, async (req, reply) => {
		const body = ProductBody.safeParse(req.body);
		if (!body.success)
			return reply.status(400).send({ error: body.error.flatten() });
		const actor = req.user as { sub: string };
		if (!(await isManagement(actor.sub)))
			return reply.status(403).send({ error: "Management only" });

		const id = await createProduct(actor.sub, body.data);
		return reply.status(201).send({ id });
	});

	app.patch("/products/:id", auth, async (req, reply) => {
		const { id } = req.params as { id: string };
		const body = ProductBody.partial().safeParse(req.body);
		if (!body.success)
			return reply.status(400).send({ error: body.error.flatten() });
		const actor = req.user as { sub: string };
		if (!(await isManagement(actor.sub)))
			return reply.status(403).send({ error: "Management only" });

		await updateProduct(actor.sub, Number(id), body.data);
		return { ok: true };
	});

	// ===== KYC document review (read-only; the status change route audits) =====
	app.get("/members/:id/kyc-documents", auth, async (req) => {
		const { id } = req.params as { id: string };
		const { rows } = await pool().query<{
			id: string;
			doc_type: string;
			s3_key: string;
			original_name: string | null;
			uploaded_at: string;
		}>(
			`SELECT id, doc_type, s3_key, original_name, uploaded_at
       FROM kyc_documents WHERE member_id = $1 ORDER BY uploaded_at DESC`,
			[id],
		);
		return Promise.all(
			rows.map(async (r) => ({
				id: String(r.id),
				docType: r.doc_type,
				originalName: r.original_name,
				uploadedAt: r.uploaded_at,
				url: await presignGet(r.s3_key),
			})),
		);
	});

	// ===== ranks =====
	// "approved" = verified but reward not yet handed over; "received" = fulfilled_at set.
	const RANK_LIST_STATUSES = [
		"pending",
		"approved",
		"received",
		"rejected",
	] as const;

	app.get("/ranks", auth, async (req, reply) => {
		const query = req.query as {
			status?: string;
			rankLevel?: string;
			q?: string;
			limit?: string;
			page?: string;
		};
		const status = query.status ?? "pending";
		if (
			!RANK_LIST_STATUSES.includes(
				status as (typeof RANK_LIST_STATUSES)[number],
			)
		) {
			return reply.status(400).send({
				error: "status must be one of: pending, approved, received, rejected",
			});
		}
		const rankLevel =
			query.rankLevel !== undefined ? Number(query.rankLevel) : undefined;
		if (
			rankLevel !== undefined &&
			(!Number.isInteger(rankLevel) || rankLevel < 1 || rankLevel > 12)
		) {
			return reply
				.status(400)
				.send({ error: "rankLevel must be an integer between 1 and 12" });
		}
		const q = query.q ?? "";
		const limit = Math.min(Math.max(1, Number(query.limit ?? "50")), 100);
		const page = Math.max(1, Number(query.page ?? "1"));
		const offset = (page - 1) * limit;

		const params: unknown[] = [];
		const conds: string[] = [];
		if (status === "approved") {
			conds.push(
				"ra.verification_status = 'approved' AND ra.fulfilled_at IS NULL",
			);
		} else if (status === "received") {
			conds.push(
				"ra.verification_status = 'approved' AND ra.fulfilled_at IS NOT NULL",
			);
		} else {
			params.push(status);
			conds.push(`ra.verification_status = $${params.length}`);
		}
		if (rankLevel !== undefined) {
			params.push(rankLevel);
			conds.push(`ra.rank_level = $${params.length}`);
		}
		if (q) {
			params.push(`%${q}%`);
			conds.push(
				`(m.member_code ILIKE $${params.length} OR m.name ILIKE $${params.length})`,
			);
		}
		const where = `WHERE ${conds.join(" AND ")}`;

		const { rows: countRows } = await pool().query<{ total: string }>(
			`SELECT COUNT(*) AS total
       FROM rank_achievements ra
       JOIN members m ON m.id = ra.member_id
       ${where}`,
			params,
		);
		const total = Number(countRows[0].total);

		const dataParams = [...params, limit, offset];
		const { rows } = await pool().query(
			`SELECT ra.id, ra.member_id, m.member_code, m.name, ra.rank_level,
              ra.achieved_at, ra.verification_status, ra.fulfilled_at, ra.fulfillment_notes
       FROM rank_achievements ra
       JOIN members m ON m.id = ra.member_id
       ${where}
       ORDER BY ra.achieved_at ASC
       LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
			dataParams,
		);
		return { ranks: rows, total, page, limit };
	});

	app.get("/ranks/summary", auth, async () => {
		const { rows } = await pool().query<{
			rank_level: string;
			pending: string;
			approved: string;
			received: string;
			rejected: string;
		}>(
			`SELECT rank_level,
              COUNT(*) FILTER (WHERE verification_status='pending')  AS pending,
              COUNT(*) FILTER (WHERE verification_status='approved' AND fulfilled_at IS NULL)     AS approved,
              COUNT(*) FILTER (WHERE verification_status='approved' AND fulfilled_at IS NOT NULL) AS received,
              COUNT(*) FILTER (WHERE verification_status='rejected') AS rejected
       FROM rank_achievements
       GROUP BY rank_level
       ORDER BY rank_level`,
		);
		return rows.map((r) => ({
			rank_level: Number(r.rank_level),
			pending: Number(r.pending),
			approved: Number(r.approved),
			received: Number(r.received),
			rejected: Number(r.rejected),
		}));
	});

	const MarkReceivedBody = z.object({
		ids: z.array(z.string().regex(/^\d+$/)).min(1).max(100),
		notes: z.string().max(2000).optional(),
	});

	// Reward hand-over is a management-only act, distinct from admin verification.
	app.post("/ranks/mark-received", auth, async (req, reply) => {
		const body = MarkReceivedBody.safeParse(req.body);
		if (!body.success)
			return reply.status(400).send({ error: body.error.flatten() });
		const actor = req.user as { sub: string };
		if (!(await isManagement(actor.sub)))
			return reply.status(403).send({ error: "Management only" });

		let updatedCount = 0;
		await withTxn(async (c) => {
			const { rows } = await c.query<{
				id: string;
				member_id: string;
				rank_level: number;
			}>(
				`UPDATE rank_achievements
           SET fulfilled_at = now(),
               fulfillment_notes = COALESCE($1, fulfillment_notes)
         WHERE id = ANY($2::bigint[])
           AND verification_status = 'approved'
           AND fulfilled_at IS NULL
         RETURNING id, member_id, rank_level`,
				[body.data.notes ?? null, body.data.ids],
			);
			updatedCount = rows.length;
			for (const r of rows) {
				await c.query(
					`INSERT INTO admin_audit_log
             (actor_id, action, target_type, target_id, before_state, after_state)
           VALUES ($1,'rank_reward_received','rank_achievement',$2,NULL,$3)`,
					[
						actor.sub,
						r.id,
						{
							member_id: String(r.member_id),
							rank_level: Number(r.rank_level),
							notes: body.data.notes ?? null,
						},
					],
				);
			}
		});
		return {
			ok: true,
			updated: updatedCount,
			skipped: body.data.ids.length - updatedCount,
		};
	});

	app.post("/ranks/:id/approve", auth, async (req, reply) => {
		const { id } = req.params as { id: string };
		const body = req.body as { notes?: string };
		const actor = req.user as { sub: string };
		let updated = false;
		await withTxn(async (c) => {
			// fulfilled_at stays NULL here — it is set later by /ranks/mark-received
			// when management confirms the physical reward was handed over.
			const { rowCount } = await c.query(
				`UPDATE rank_achievements
           SET verification_status = 'approved', fulfillment_notes = $1
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
			return reply
				.status(404)
				.send({ error: "Not found or already processed" });
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
			return reply
				.status(404)
				.send({ error: "Not found or already processed" });
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
	const VALID_KYC_STATUSES = ["pending", "verified", "rejected"] as const;
	app.get("/members", auth, async (req, reply) => {
		const query = req.query as {
			q?: string;
			limit?: string;
			page?: string;
			kycStatus?: string;
		};
		const q = query.q ?? "";
		const limit = Math.min(Math.max(1, Number(query.limit ?? "20")), 100);
		const page = Math.max(1, Number(query.page ?? "1"));
		const offset = (page - 1) * limit;
		const kycStatus = query.kycStatus;
		if (
			kycStatus !== undefined &&
			!VALID_KYC_STATUSES.includes(
				kycStatus as (typeof VALID_KYC_STATUSES)[number],
			)
		) {
			return reply
				.status(400)
				.send({ error: "kycStatus must be one of: pending, verified, rejected" });
		}
		const baseParams: unknown[] = [`%${q}%`, `%${q}%`, `%${q}%`];
		let where = `WHERE (m.name ILIKE $1 OR m.phone LIKE $2 OR m.member_code ILIKE $3)`;
		if (kycStatus) {
			baseParams.push(kycStatus);
			where += ` AND m.kyc_status = $${baseParams.length} AND m.role <> 'management'`;
		}
		const { rows: countRows } = await pool().query<{ total: string }>(
			`SELECT COUNT(*) AS total FROM members m ${where}`,
			baseParams,
		);
		const total = Number(countRows[0].total);
		const dataParams = [...baseParams, limit, offset];
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
			blocked: boolean;
			created_at: string;
			has_documents: boolean;
		}>(
			`SELECT m.id, m.member_code, m.name, m.phone, m.email,
			        m.is_active, m.is_qualified, m.role, m.kyc_status, m.bank_status, m.blocked, m.created_at,
			        (SELECT COUNT(*) > 0 FROM kyc_documents kd WHERE kd.member_id = m.id) AS has_documents
			 FROM members m
			 ${where}
			 ORDER BY m.created_at DESC
			 LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
			dataParams,
		);
		return {
			items: rows.map((m) => ({
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
				blocked: m.blocked,
				createdAt: m.created_at,
				hasDocuments: m.has_documents,
			})),
			total,
			page,
			limit,
		};
	});

	// ===== member update (name/email/phone only — BR-11) =====
	const PatchMemberBody = z.object({
		name: z.string().min(1).optional(),
		// email must not be nullable — column is NOT NULL since migration 016.
		// Stored and queried lowercase; we normalise here so login always works.
		email: z.string().trim().email().optional(),
		phone: z.string().min(10).optional(),
	});

	app.patch("/members/:id", auth, async (req, reply) => {
		const { id } = req.params as { id: string };
		const body = PatchMemberBody.safeParse(req.body);
		if (!body.success)
			return reply.status(400).send({ error: body.error.flatten() });

		const actor = req.user as { sub: string };
		const d = body.data;

		// Always store emails lowercase so findMemberByEmail (login) can match them.
		const newEmail = d.email?.trim().toLowerCase();

		const setClauses: string[] = [];
		const values: unknown[] = [];
		if (d.name !== undefined) setClauses.push(`name=$${values.push(d.name)}`);
		if (newEmail !== undefined)
			setClauses.push(`email=$${values.push(newEmail)}`);
		if (d.phone !== undefined)
			setClauses.push(`phone=$${values.push(d.phone)}`);

		if (setClauses.length === 0)
			return reply.status(400).send({ error: "No fields to update" });

		try {
			await withTxn(async (c) => {
				const { rows: before } = await c.query<{
					name: string;
					email: string | null;
					phone: string;
				}>("SELECT name, email, phone FROM members WHERE id=$1 FOR UPDATE", [id]);
				if (!before[0])
					throw Object.assign(new Error("Member not found"), { statusCode: 404 });

				// Email changes are management-only — an appointed admin may still edit
				// name and phone, but only the management master account may change a
				// member's login email.
				if (newEmail !== undefined && newEmail !== before[0].email) {
					if (!(await isManagement(actor.sub)))
						throw Object.assign(
							new Error("Only management can change a member's email"),
							{ statusCode: 403 },
						);
				}

				values.push(id);
				await c.query(
					`UPDATE members SET ${setClauses.join(", ")} WHERE id=$${values.length}`,
					values,
				);

				await c.query(
					`INSERT INTO admin_audit_log
           (actor_id, action, target_type, target_id, before_state, after_state)
         VALUES ($1,'patch_member','member',$2,$3,$4)`,
					[actor.sub, id, before[0], { ...d, email: newEmail }],
				);
			});
		} catch (err: unknown) {
			const e = err as { statusCode?: number; message?: string; code?: string; constraint?: string };
			// Duplicate email — surface as 409 rather than a raw 500.
			if (e.code === "23505" && e.constraint === "members_email_key")
				return reply.status(409).send({ error: "Email already in use by another member" });
			if (e.statusCode === 404) return reply.status(404).send({ error: e.message });
			if (e.statusCode === 403) return reply.status(403).send({ error: e.message });
			throw err;
		}
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
		if (!(await isManagement(actor.sub)))
			return reply.status(403).send({ error: "Management only" });

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

	// ===== Role change (management only — the master account appoints/removes admins) =====
	const RoleBody = z.object({
		role: z.enum(["member", "admin"]),
	});

	app.post("/members/:id/role", auth, async (req, reply) => {
		const { id } = req.params as { id: string };
		const body = RoleBody.safeParse(req.body);
		if (!body.success)
			return reply.status(400).send({ error: body.error.flatten() });

		const actor = req.user as { sub: string };

		const { rows: actorRows } = await pool().query<{ role: string }>(
			"SELECT role FROM members WHERE id=$1",
			[actor.sub],
		);
		if (!actorRows[0] || actorRows[0].role !== "management")
			return reply.status(403).send({ error: "Management only" });

		await withTxn(async (c) => {
			const { rows: before } = await c.query<{ role: string }>(
				"SELECT role FROM members WHERE id=$1 FOR UPDATE",
				[id],
			);
			if (!before[0])
				throw Object.assign(new Error("Member not found"), { statusCode: 404 });
			// The management role itself is fixed — never grantable or revocable via API.
			if (before[0].role === "management")
				throw Object.assign(
					new Error("Cannot change a management account's role"),
					{
						statusCode: 403,
					},
				);

			await c.query("UPDATE members SET role=$1 WHERE id=$2", [
				body.data.role,
				id,
			]);

			await c.query(
				`INSERT INTO admin_audit_log
           (actor_id, action, target_type, target_id, before_state, after_state)
         VALUES ($1,'role_change','member',$2,$3,$4)`,
				[actor.sub, id, { role: before[0].role }, { role: body.data.role }],
			);
		});
		return { ok: true };
	});

	// ===== Block / unblock (login suspension — deliberately NOT is_active,
	// which drives counters/qualification through the event pipeline) =====
	const BlockBody = z.object({
		blocked: z.boolean(),
	});

	app.post("/members/:id/block", auth, async (req, reply) => {
		const { id } = req.params as { id: string };
		const body = BlockBody.safeParse(req.body);
		if (!body.success)
			return reply.status(400).send({ error: body.error.flatten() });

		const actor = req.user as { sub: string };
		if (id === actor.sub)
			return reply.status(403).send({ error: "Cannot block yourself" });

		await withTxn(async (c) => {
			const { rows: before } = await c.query<{
				role: string;
				blocked: boolean;
			}>("SELECT role, blocked FROM members WHERE id=$1 FOR UPDATE", [id]);
			if (!before[0])
				throw Object.assign(new Error("Member not found"), { statusCode: 404 });
			if (before[0].role === "management")
				throw Object.assign(new Error("Cannot block a management account"), {
					statusCode: 403,
				});

			await c.query("UPDATE members SET blocked=$1 WHERE id=$2", [
				body.data.blocked,
				id,
			]);

			// Kill the session too: revoking all refresh tokens caps the remaining
			// exposure at the access-token TTL (login and refresh both reject
			// blocked members; app.authenticate deliberately stays DB-free).
			if (body.data.blocked) {
				await c.query(
					`UPDATE refresh_tokens SET revoked_at = now()
           WHERE member_id = $1 AND revoked_at IS NULL`,
					[id],
				);
			}

			await c.query(
				`INSERT INTO admin_audit_log
           (actor_id, action, target_type, target_id, before_state, after_state)
         VALUES ($1,'block_update','member',$2,$3,$4)`,
				[
					actor.sub,
					id,
					{ blocked: before[0].blocked },
					{ blocked: body.data.blocked },
				],
			);
		});
		return { ok: true };
	});

	// ===== System overview (read-only aggregates; one parallel round trip) =====
	app.get("/overview", auth, async () => {
		const [
			membersRes,
			kycRes,
			ranksRes,
			todayRes,
			windowRes,
			outboxRes,
			dlqRes,
		] = await Promise.all([
			pool().query<{ total: string; active: string; blocked: string }>(
				`SELECT COUNT(*) AS total,
                COUNT(*) FILTER (WHERE is_active) AS active,
                COUNT(*) FILTER (WHERE blocked) AS blocked
         FROM members WHERE role <> 'management'`,
			),
			pool().query<{ c: string }>(
				`SELECT COUNT(*) AS c FROM members
         WHERE kyc_status = 'pending' AND role <> 'management'`,
			),
			pool().query<{ c: string }>(
				`SELECT COUNT(*) AS c FROM rank_achievements WHERE verification_status = 'pending'`,
			),
			pool().query<{ pairs: string; total: string }>(
				`SELECT COUNT(*) AS pairs, COALESCE(SUM(bonus_amount),0) AS total
         FROM pairs
         WHERE to_char(created_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD')
             = to_char(now() AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD')`,
			),
			pool().query<{ window_start: string; window_end: string }>(
				`SELECT window_start, window_end FROM cutoffs WHERE status = 'open' LIMIT 1`,
			),
			pool().query<{ c: string }>(
				`SELECT COUNT(*) AS c FROM events_outbox WHERE published_at IS NULL`,
			),
			pool().query<{ c: string }>(`SELECT COUNT(*) AS c FROM dead_letters`),
		]);

		const m = membersRes.rows[0];
		const win = windowRes.rows[0];
		return {
			totalMembers: parseInt(m?.total ?? "0"),
			activeMembers: parseInt(m?.active ?? "0"),
			blockedMembers: parseInt(m?.blocked ?? "0"),
			pendingKyc: parseInt(kycRes.rows[0]?.c ?? "0"),
			pendingRanks: parseInt(ranksRes.rows[0]?.c ?? "0"),
			todayPairs: parseInt(todayRes.rows[0]?.pairs ?? "0"),
			todayBonusPaise: Number(toPaise(todayRes.rows[0]?.total ?? "0")),
			openWindow: win
				? {
						start: new Date(win.window_start).toISOString(),
						end: new Date(win.window_end).toISOString(),
					}
				: null,
			outboxBacklog: parseInt(outboxRes.rows[0]?.c ?? "0"),
			deadLetters: parseInt(dlqRes.rows[0]?.c ?? "0"),
		};
	});

	// ===== Payout batch visibility =====
	app.get("/payouts", auth, async () => {
		const { rows } = await pool().query<{
			id: string;
			scheduled_for: string;
			status: string;
			created_at: string;
			items: string;
			pending: string;
			sent: string;
			settled: string;
			failed: string;
			net_total: string;
		}>(
			`SELECT pb.id, pb.scheduled_for, pb.status, pb.created_at,
              COUNT(pi.id) AS items,
              COUNT(*) FILTER (WHERE pi.status = 'pending') AS pending,
              COUNT(*) FILTER (WHERE pi.status = 'sent') AS sent,
              COUNT(*) FILTER (WHERE pi.status = 'settled') AS settled,
              COUNT(*) FILTER (WHERE pi.status = 'failed') AS failed,
              COALESCE(SUM(pi.net), 0) AS net_total
       FROM payout_batches pb
       LEFT JOIN payout_items pi ON pi.batch_id = pb.id
       GROUP BY pb.id
       ORDER BY pb.scheduled_for DESC
       LIMIT 52`,
		);
		return rows.map((r) => ({
			id: String(r.id),
			scheduledFor: new Date(r.scheduled_for).toISOString(),
			status: r.status,
			createdAt: r.created_at,
			items: parseInt(r.items),
			pending: parseInt(r.pending),
			sent: parseInt(r.sent),
			settled: parseInt(r.settled),
			failed: parseInt(r.failed),
			netTotalPaise: Number(toPaise(r.net_total)),
		}));
	});

	app.get("/payouts/:batchId/items", auth, async (req) => {
		const { batchId } = req.params as { batchId: string };
		const { rows } = await pool().query<{
			id: string;
			member_code: string;
			name: string;
			gross: string;
			tds: string;
			net: string;
			status: string;
			bank_ref: string | null;
			failure_reason: string | null;
		}>(
			`SELECT pi.id, m.member_code, m.name, pi.gross, pi.tds, pi.net,
              pi.status, pi.bank_ref, pi.failure_reason
       FROM payout_items pi
       JOIN members m ON m.id = pi.member_id
       WHERE pi.batch_id = $1
       ORDER BY pi.id`,
			[batchId],
		);
		return rows.map((r) => ({
			id: String(r.id),
			memberCode: r.member_code,
			name: r.name,
			grossPaise: Number(toPaise(r.gross)),
			tdsPaise: Number(toPaise(r.tds)),
			netPaise: Number(toPaise(r.net)),
			status: r.status,
			bankRef: r.bank_ref,
			failureReason: r.failure_reason,
		}));
	});

	// ===== Dead-letter queue =====
	app.get("/dead-letters", auth, async () => {
		const { rows } = await pool().query<{
			id: string;
			stream: string;
			consumer_group: string;
			entry_id: string;
			payload: string;
			delivery_count: number;
			created_at: string;
		}>(
			`SELECT id, stream, consumer_group, entry_id, payload, delivery_count, created_at
       FROM dead_letters ORDER BY created_at DESC LIMIT 100`,
		);
		return rows.map((r) => ({
			id: String(r.id),
			stream: r.stream,
			consumerGroup: r.consumer_group,
			entryId: r.entry_id,
			payload: r.payload,
			deliveryCount: r.delivery_count,
			createdAt: r.created_at,
		}));
	});

	// Replay = re-deliver the original payload to its stream. Consumers are
	// idempotent via processed_events, so a duplicate delivery is harmless.
	app.post("/dead-letters/:id/replay", auth, async (req, reply) => {
		const { id } = req.params as { id: string };
		const actor = req.user as { sub: string };

		const { rows } = await pool().query<{
			stream: string;
			consumer_group: string;
			entry_id: string;
			payload: string;
		}>(
			`SELECT stream, consumer_group, entry_id, payload FROM dead_letters WHERE id = $1`,
			[id],
		);
		if (!rows[0]) return reply.status(404).send({ error: "Not found" });

		// Publish before delete: if the delete fails the row survives and can be
		// replayed again (duplicate delivery is safe — consumers are idempotent).
		await publishToStream(rows[0].stream, rows[0].payload);

		await withTxn(async (c) => {
			const { rowCount } = await c.query(
				"DELETE FROM dead_letters WHERE id = $1",
				[id],
			);
			// A concurrent replay may have deleted the row first — don't record a
			// second audit entry for a replay this request didn't complete.
			if (!rowCount || rowCount === 0) return;
			await c.query(
				`INSERT INTO admin_audit_log
           (actor_id, action, target_type, target_id, before_state, after_state)
         VALUES ($1,'dlq_replay','dead_letter',$2,$3,NULL)`,
				[
					actor.sub,
					id,
					{
						stream: rows[0].stream,
						consumerGroup: rows[0].consumer_group,
						entryId: rows[0].entry_id,
					},
				],
			);
		});
		return { ok: true };
	});

	app.delete("/dead-letters/:id", auth, async (req, reply) => {
		const { id } = req.params as { id: string };
		const actor = req.user as { sub: string };

		let found = false;
		await withTxn(async (c) => {
			const { rows } = await c.query<{
				stream: string;
				consumer_group: string;
				entry_id: string;
				payload: string;
			}>(
				`DELETE FROM dead_letters WHERE id = $1
         RETURNING stream, consumer_group, entry_id, payload`,
				[id],
			);
			found = !!rows[0];
			if (found) {
				await c.query(
					`INSERT INTO admin_audit_log
             (actor_id, action, target_type, target_id, before_state, after_state)
           VALUES ($1,'dlq_discard','dead_letter',$2,$3,NULL)`,
					[
						actor.sub,
						id,
						{
							stream: rows[0].stream,
							consumerGroup: rows[0].consumer_group,
							entryId: rows[0].entry_id,
							payload: rows[0].payload,
						},
					],
				);
			}
		});
		if (!found) return reply.status(404).send({ error: "Not found" });
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

		const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
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

	// ===== Orders (pending payment confirmation) =====

	// GET /orders?status=created|paid|confirmed&limit=50&offset=0  — list orders by status.
	app.get("/orders", auth, async (req) => {
		const query = req.query as {
			status?: string;
			limit?: string;
			offset?: string;
		};
		const status = query.status ?? "paid";
		const limit = Math.min(Number(query.limit ?? "50"), 200);
		const offset = Number(query.offset ?? "0");
		const { rows } = await pool().query<{
			id: string;
			member_code: string;
			member_name: string;
			product_name: string;
			total_amount: string;
			status: string;
			created_at: string;
			payment_ref: string | null;
			confirmed_at: string | null;
			proof_keys: string[] | null;
		}>(
			`SELECT o.id, m.member_code, m.name AS member_name, p.name AS product_name,
			        o.total_amount, o.status, o.created_at,
			        o.payment_ref, o.confirmed_at,
			        array_agg(opp.s3_key ORDER BY opp.uploaded_at)
			          FILTER (WHERE opp.s3_key IS NOT NULL) AS proof_keys
			   FROM orders o
			   JOIN members m  ON m.id  = o.member_id
			   JOIN products p ON p.id  = o.product_id
			   LEFT JOIN order_payment_proofs opp ON opp.order_id = o.id
			  WHERE o.status = $1
			  GROUP BY o.id, m.member_code, m.name, p.name
			  ORDER BY o.created_at DESC
			  LIMIT $2 OFFSET $3`,
			[status, limit, offset],
		);
		return Promise.all(
			rows.map(async (r) => {
				const keys = r.proof_keys ?? [];
				const paymentProofUrls = await Promise.all(keys.map((k) => presignGet(k)));
				return {
					orderId: r.id,
					memberCode: r.member_code,
					memberName: r.member_name,
					productName: r.product_name,
					totalPaise: Number(toPaise(r.total_amount)),
					status: r.status,
					createdAt: r.created_at,
					paymentRef: r.payment_ref ?? undefined,
					confirmedAt: r.confirmed_at ?? undefined,
					paymentProofUrls: paymentProofUrls.length > 0 ? paymentProofUrls : undefined,
				};
			}),
		);
	});

	// POST /orders/:orderId/confirm-payment — admin manually confirms an offline payment.
	const ConfirmPaymentBody = z.object({
		paymentRef: z.string().min(1, "Payment reference is required"),
	});

	app.post("/orders/:orderId/confirm-payment", auth, async (req, reply) => {
		const { orderId } = req.params as { orderId: string };
		const actor = req.user as { sub: string };

		// Payment approval is management-only — it directly activates a member's plan.
		if (!(await isManagement(actor.sub)))
			return reply
				.status(403)
				.send({ error: "Only management can approve payments" });

		const body = ConfirmPaymentBody.safeParse(req.body);
		if (!body.success)
			return reply.status(400).send({ error: body.error.flatten() });

		// Load the order — we need idempotency_key to call confirmOrder.
		const { rows } = await pool().query<{
			idempotency_key: string;
			status: string;
			member_id: string;
		}>(
			"SELECT idempotency_key, status, member_id FROM orders WHERE id = $1",
			[orderId],
		);
		if (!rows[0])
			return reply.status(404).send({ error: "Order not found" });
		// Require the member to have uploaded a payment proof first (status='paid').
		// Confirming a 'created' order (no proof) is blocked.
		if (rows[0].status !== "paid")
			return reply.status(409).send({
				error:
					rows[0].status === "created"
						? "Order has no uploaded payment proof yet"
						: "Order is already confirmed, failed, or refunded",
			});

		// confirmOrder is idempotent and writes MemberActivated inside its own transaction.
		await confirmOrder(rows[0].idempotency_key, BigInt(orderId), body.data.paymentRef);

		// Audit trail — same pattern as /ranks/:id/approve.
		await pool().query(
			`INSERT INTO admin_audit_log
			   (actor_id, action, target_type, target_id, before_state, after_state)
			 VALUES ($1, 'order_confirm', 'order', $2, $3, $4)`,
			[
				actor.sub,
				orderId,
				{ status: rows[0].status },
				{ status: "confirmed", paymentRef: body.data.paymentRef },
			],
		);

		return { ok: true };
	});

	// POST /orders/:orderId/reject-payment — management rejects a payment proof so the member can re-upload.
	const RejectPaymentBody = z.object({
		reason: z.string().trim().max(500).optional(),
	});

	app.post("/orders/:orderId/reject-payment", auth, async (req, reply) => {
		const { orderId } = req.params as { orderId: string };
		const actor = req.user as { sub: string };

		if (!(await isManagement(actor.sub)))
			return reply
				.status(403)
				.send({ error: "Only management can reject payments" });

		const body = RejectPaymentBody.safeParse(req.body);
		if (!body.success)
			return reply.status(400).send({ error: body.error.flatten() });

		const { rows } = await pool().query<{ status: string }>(
			"SELECT status FROM orders WHERE id = $1",
			[orderId],
		);
		if (!rows[0])
			return reply.status(404).send({ error: "Order not found" });
		if (rows[0].status !== "paid")
			return reply
				.status(409)
				.send({ error: "Only orders awaiting review (paid) can be rejected" });

		await withTxn(async (c) => {
			// Clear old proofs so the member uploads fresh screenshots on re-submission.
			await c.query(
				"DELETE FROM order_payment_proofs WHERE order_id = $1",
				[orderId],
			);
			await c.query(
				`UPDATE orders SET status = 'rejected', rejection_reason = $2 WHERE id = $1`,
				[orderId, body.data.reason ?? null],
			);
			await c.query(
				`INSERT INTO admin_audit_log
				   (actor_id, action, target_type, target_id, before_state, after_state)
				 VALUES ($1, 'order_reject', 'order', $2, $3, $4)`,
				[
					actor.sub,
					orderId,
					{ status: "paid" },
					{ status: "rejected", reason: body.data.reason ?? null },
				],
			);
		});

		return { ok: true };
	});

	// ===== System settings (feature flags) =====
	// GET — both admin and management may read.
	app.get("/settings", auth, async () => {
		const raw = await getAllSettings();
		return {
			kycOptional: Boolean(raw["kyc_optional"]),
			welcomeEmailEnabled: Boolean(raw["welcome_email_enabled"]),
			loginOtpEnabled: Boolean(raw["login_otp_enabled"]),
		};
	});

	// PATCH — management only.
	// All fields are optional so callers can update a single toggle at a time.
	const SettingsBody = z.object({
		kycOptional: z.boolean().optional(),
		welcomeEmailEnabled: z.boolean().optional(),
		loginOtpEnabled: z.boolean().optional(),
	});

	app.patch("/settings", auth, async (req, reply) => {
		const actor = req.user as { sub: string };
		if (!(await isManagement(actor.sub)))
			return reply.status(403).send({ error: "Management only" });

		const body = SettingsBody.safeParse(req.body);
		if (!body.success)
			return reply.status(400).send({ error: body.error.flatten() });

		// Collect which fields were actually sent so we only write those.
		const patches: Array<{ dbKey: string; value: boolean }> = [];
		if (body.data.kycOptional !== undefined)
			patches.push({ dbKey: "kyc_optional", value: body.data.kycOptional });
		if (body.data.welcomeEmailEnabled !== undefined)
			patches.push({ dbKey: "welcome_email_enabled", value: body.data.welcomeEmailEnabled });
		if (body.data.loginOtpEnabled !== undefined)
			patches.push({ dbKey: "login_otp_enabled", value: body.data.loginOtpEnabled });

		if (patches.length === 0)
			return reply.status(400).send({ error: "No settings fields provided" });

		// Capture updated values and read the full snapshot inside the same
		// transaction to avoid a stale-read race on the post-commit re-read.
		const snapshot: Record<string, boolean> = {};
		await withTxn(async (c) => {
			for (const patch of patches) {
				const result = await setSetting(c, patch.dbKey, patch.value, actor.sub);
				snapshot[patch.dbKey] = Boolean(result.after);
				// target_id is NULL for system-level settings changes (no member target).
				await c.query(
					`INSERT INTO admin_audit_log
             (actor_id, action, target_type, target_id, before_state, after_state)
           VALUES ($1, 'settings_change', 'system', NULL, $2, $3)`,
					[
						actor.sub,
						{ [patch.dbKey]: result.before },
						{ [patch.dbKey]: result.after },
					],
				);
			}
			// Read un-patched keys so the response is always complete.
			const { rows } = await c.query<{ key: string; value: unknown }>(
				"SELECT key, value FROM system_settings",
			);
			for (const row of rows) {
				if (!(row.key in snapshot)) snapshot[row.key] = Boolean(row.value);
			}
		});
		return {
			kycOptional: snapshot["kyc_optional"] ?? false,
			welcomeEmailEnabled: snapshot["welcome_email_enabled"] ?? false,
			loginOtpEnabled: snapshot["login_otp_enabled"] ?? false,
		};
	});
}
