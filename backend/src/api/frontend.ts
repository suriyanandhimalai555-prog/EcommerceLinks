/**
 * frontend.ts — serves the exact API contract defined by
 * frontend/src/mocks/handlers.ts and frontend/src/types/api.ts.
 * Replaces orderRoutes, networkRoutes, walletRoutes, reportRoutes.
 * Keep the webhook here (orders.ts is no longer registered).
 */
import { randomUUID, timingSafeEqual } from "crypto";
import argon2 from "argon2";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CFG } from "../config.js";
import { QUALIFIED_THRESHOLDS } from "../domain/ranks.js";
import { pool } from "../lib/db.js";
import { fromPaise, toPaise } from "../lib/money.js";
import { redis } from "../lib/redis.js";
import {
	buildKey,
	IMAGE_CONTENT_TYPES,
	kycKeyRe,
	paymentProofKeyRe,
	MAX_UPLOAD_BYTES,
	objectExists,
	presignGet,
	presignUpload,
	s3Configured,
} from "../lib/s3.js";
import { confirmOrder, createOrder } from "../services/orderService.js";
import { imagesByProduct } from "../services/productService.js";
import { getSetting } from "../services/settings.js";

// Display names the frontend expects (index 1..12)
const RANK_NAMES: Record<number, string> = {
	1: "Starter Achiever",
	2: "International Achiever",
	3: "Bike Achiever",
	4: "Car Achiever",
	5: "Gold Achiever",
	6: "10L Gold Achiever",
	7: "30L Gold Achiever",
	8: "Villa Achiever",
	9: "Crorepati Gold Achiever",
	10: "Dubai Villa Achiever",
	11: "Global Luxury Achiever",
	12: "Royal Achiever",
};

const PRODUCT_BADGES: Record<number, string[]> = {
	1: ["ENTRY LEVEL"],
	2: ["POPULAR"],
	3: ["BEST VALUE"],
};

type Auth = { sub: string };

// ---------- shared helpers ----------

export async function buildMe(memberId: string) {
	const { rows } = await pool().query<{
		member_code: string;
		name: string;
		phone: string;
		email: string | null;
		kyc_status: string;
		bank_status: string;
		is_active: boolean;
		created_at: string;
		role: string;
		blocked: boolean;
		sponsor_code: string | null;
		pan: string | null;
		aadhaar_last4: string | null;
		bank_account_name: string | null;
		bank_account_number: string | null;
		bank_ifsc: string | null;
		notifications_seen_at: string | null;
	}>(
		`SELECT m.member_code, m.name, m.phone, m.email, m.kyc_status, m.bank_status,
            m.is_active, m.created_at, m.role, m.blocked, s.member_code AS sponsor_code,
            m.pan, m.aadhaar_last4, m.bank_account_name, m.bank_account_number, m.bank_ifsc,
            m.notifications_seen_at
     FROM members m LEFT JOIN members s ON s.id = m.sponsor_id
     WHERE m.id = $1`,
		[memberId],
	);
	if (!rows[0]) return null;
	const m = rows[0];
	const { rows: rk } = await pool().query<{ max: string | null }>(
		"SELECT MAX(rank_level) AS max FROM rank_achievements WHERE member_id = $1",
		[memberId],
	);
	const level = rk[0]?.max ? parseInt(rk[0].max) : 0;
	const kycOptional = await getSetting<boolean>("kyc_optional");
	return {
		memberCode: m.member_code,
		name: m.name,
		phone: m.phone,
		email: m.email ?? undefined,
		sponsorCode: m.sponsor_code ?? "",
		joinedAt: m.created_at,
		isActive: m.is_active,
		kycStatus: m.kyc_status,
		bankStatus: m.bank_status,
		currentRankLevel: level,
		currentRankName: level > 0 ? RANK_NAMES[level] : "Member",
		role: m.role as "member" | "admin" | "management",
		blocked: m.blocked,
		pan: m.pan ?? undefined,
		aadhaarLast4: m.aadhaar_last4 ?? undefined,
		bankAccountName: m.bank_account_name ?? undefined,
		bankAccountNumber: m.bank_account_number ?? undefined,
		bankIfsc: m.bank_ifsc ?? undefined,
		// Tells the frontend whether KYC is required before purchasing.
		// Payout still always requires verified KYC+bank regardless of this flag.
		kycMandatory: !kycOptional,
		// Server-side "notifications seen" timestamp — drives cross-device badge state.
		notificationsSeenAt: m.notifications_seen_at ?? null,
	};
}

function mapRefType(
	referenceType: string,
): "pair" | "payout" | "sweep" | "manual" {
	if (referenceType === "pair") return "pair";
	if (referenceType === "payout_item") return "payout";
	if (referenceType === "sweep") return "sweep";
	return "manual";
}

function describe(refType: string, referenceId: string | null): string {
	if (refType === "pair") return `Pair Match Bonus #${referenceId ?? ""}`;
	if (refType === "payout") return "Payout to bank";
	if (refType === "sweep") return "Weekly cap sweep";
	return "Transaction";
}

async function ledgerItems(
	memberId: string,
	cursor: string | null,
	limit: number,
) {
	const cursorClause = cursor ? "AND le.id < $3" : "";
	const params: (string | number)[] = [memberId, limit];
	if (cursor) params.push(parseInt(cursor));
	const { rows } = await pool().query<{
		id: string;
		direction: string;
		amount: string;
		created_at: string;
		reference_type: string;
		reference_id: string | null;
	}>(
		`SELECT le.id, le.direction, le.amount, le.created_at, lt.reference_type, lt.reference_id
     FROM ledger_entries le
     JOIN ledger_txns lt ON lt.txn_id = le.txn_id
     JOIN accounts a ON a.id = le.account_id
     WHERE a.owner_id = $1 AND a.kind = 'wallet' ${cursorClause}
     ORDER BY le.id DESC LIMIT $2`,
		params,
	);
	const items = rows.map((r) => {
		const refType = mapRefType(r.reference_type);
		return {
			at: r.created_at,
			description: describe(refType, r.reference_id),
			direction: r.direction === "C" ? "credit" : "debit",
			amountPaise: Number(toPaise(r.amount)),
			refType,
		};
	});
	return {
		items,
		nextCursor: rows.length === limit ? String(rows[rows.length - 1].id) : null,
		raw: rows,
	};
}

// ---------- tree helpers (same logic as the old network.ts) ----------

interface TreeRow {
	id: string;
	member_code: string;
	name: string;
	position: string | null;
	is_active: boolean;
	is_qualified: boolean;
	parent_id: string | null;
}

function buildTree(
	rows: TreeRow[],
	rootId: string,
	depthLeft: number,
): Record<string, unknown> | null {
	const node = rows.find((r) => r.id === rootId);
	if (!node) return null;
	const result: Record<string, unknown> = {
		memberCode: node.member_code,
		name: node.name,
		position: node.position,
		isActive: node.is_active,
		isQualified: node.is_qualified,
		left: null,
		right: null,
	};
	if (depthLeft > 0) {
		for (const child of rows.filter((r) => r.parent_id === rootId)) {
			if (child.position === "L")
				result.left = buildTree(rows, child.id, depthLeft - 1);
			if (child.position === "R")
				result.right = buildTree(rows, child.id, depthLeft - 1);
		}
	}
	return result;
}

// ---------- routes ----------

export async function frontendRoutes(app: FastifyInstance) {
	const auth = { preHandler: [app.authenticate] };

	// ===== me =====
	app.get("/me", auth, async (req, reply) => {
		const me = await buildMe((req.user as Auth).sub);
		if (!me)
			return reply
				.status(404)
				.send({ error: { code: "NOT_FOUND", message: "Member not found" } });
		return me;
	});

	const ProfileBody = z.object({
		name: z.string().trim().min(2, "Name required").max(120),
	});

	app.put("/me/profile", auth, async (req, reply) => {
		const body = ProfileBody.safeParse(req.body);
		if (!body.success)
			return reply.status(400).send({ error: body.error.flatten() });
		const memberId = (req.user as Auth).sub;
		await pool().query(`UPDATE members SET name = $2 WHERE id = $1`, [
			memberId,
			body.data.name,
		]);
		return reply.send(await buildMe(memberId));
	});

	// ===== Mark all notifications as seen =====
	// Bumps notifications_seen_at to now() so every existing notification
	// is treated as "read". Cross-device: the timestamp lives on the server,
	// so clearing the bell on one device clears it on all.
	app.post("/me/notifications/seen", auth, async (req) => {
		const memberId = (req.user as Auth).sub;
		await pool().query(
			`UPDATE members SET notifications_seen_at = now() WHERE id = $1`,
			[memberId],
		);
		// Return the updated Me so the client can replace the ['me'] cache entry
		// directly (same pattern as PUT /me/profile).
		return buildMe(memberId);
	});

	// ===== Change own password =====
	const PasswordBody = z.object({
		currentPassword: z.string().min(1, "Current password is required"),
		newPassword: z.string().min(8, "New password must be at least 8 characters"),
	});

	app.put("/me/password", auth, async (req, reply) => {
		const body = PasswordBody.safeParse(req.body);
		if (!body.success)
			return reply.status(400).send({ error: body.error.flatten() });

		const memberId = (req.user as Auth).sub;
		const { rows } = await pool().query<{ password_hash: string }>(
			"SELECT password_hash FROM members WHERE id = $1",
			[memberId],
		);
		if (!rows[0])
			return reply
				.status(404)
				.send({ error: { code: "NOT_FOUND", message: "Member not found" } });

		// Same-password check BEFORE verify so a 400 never reveals whether
		// the supplied currentPassword matched the stored hash.
		if (body.data.newPassword === body.data.currentPassword)
			return reply
				.status(400)
				.send({ error: "New password must be different from the current one" });

		const valid = await argon2.verify(
			rows[0].password_hash,
			body.data.currentPassword,
		);
		if (!valid)
			return reply
				.status(401)
				.send({ error: "Current password is incorrect" });

		// Hash outside any transaction — argon2 is deliberately slow.
		const newHash = await argon2.hash(body.data.newPassword);

		await pool().query(
			"UPDATE members SET password_hash = $2 WHERE id = $1",
			[memberId, newHash],
		);

		// Revoke all live refresh tokens so other-device sessions end immediately.
		await pool().query(
			"UPDATE refresh_tokens SET revoked_at = now() WHERE member_id = $1 AND revoked_at IS NULL",
			[memberId],
		);

		return reply.send({ ok: true });
	});

	const KycBody = z.object({
		pan: z.string().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, "Invalid PAN format"),
		aadhaarLast4: z
			.string()
			.length(4)
			.regex(/^\d{4}$/, "Must be 4 digits"),
	});

	app.put("/me/kyc", auth, async (req, reply) => {
		const body = KycBody.safeParse(req.body);
		if (!body.success)
			return reply.status(400).send({ error: body.error.flatten() });
		const memberId = (req.user as Auth).sub;
		await pool().query(
			`UPDATE members
			    SET pan = $2, aadhaar_last4 = $3,
			        kyc_status = CASE WHEN kyc_status = 'verified' THEN kyc_status ELSE 'pending' END
			  WHERE id = $1`,
			[memberId, body.data.pan, body.data.aadhaarLast4],
		);
		const me = await buildMe(memberId);
		return reply.send(me);
	});

	// ===== KYC document upload (S3 kyc/{memberId}/ — private prefix) =====
	const KycPresignBody = z.object({
		docType: z.enum(["pan", "aadhaar", "other"]),
		contentType: z.enum(IMAGE_CONTENT_TYPES),
		sizeBytes: z.number().int().positive().max(MAX_UPLOAD_BYTES),
	});

	app.post("/me/kyc/presign", auth, async (req, reply) => {
		const body = KycPresignBody.safeParse(req.body);
		if (!body.success)
			return reply.status(400).send({ error: body.error.flatten() });
		if (!s3Configured())
			return reply.status(503).send({ error: "S3_NOT_CONFIGURED" });
		const memberId = (req.user as Auth).sub;
		// Key is minted from the JWT identity — a member can never write
		// outside their own kyc/{id}/ folder.
		const key = buildKey(`kyc/${memberId}`, body.data.contentType);
		return presignUpload(key, body.data.contentType);
	});

	async function listKycDocuments(memberId: string) {
		const { rows } = await pool().query<{
			id: string;
			doc_type: string;
			s3_key: string;
			original_name: string | null;
			uploaded_at: string;
		}>(
			`SELECT id, doc_type, s3_key, original_name, uploaded_at
       FROM kyc_documents WHERE member_id = $1 ORDER BY uploaded_at DESC`,
			[memberId],
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
	}

	const KycDocumentBody = z.object({
		key: z.string(),
		docType: z.enum(["pan", "aadhaar", "other"]),
		originalName: z.string().max(200).optional(),
	});

	app.post("/me/kyc/documents", auth, async (req, reply) => {
		const body = KycDocumentBody.safeParse(req.body);
		if (!body.success)
			return reply.status(400).send({ error: body.error.flatten() });
		const memberId = (req.user as Auth).sub;

		if (!kycKeyRe(memberId).test(body.data.key))
			return reply
				.status(400)
				.send({ error: { code: "BAD_REQUEST", message: "Invalid key" } });
		if (!(await objectExists(body.data.key)))
			return reply.status(400).send({
				error: { code: "BAD_REQUEST", message: "Upload not found in storage" },
			});

		// ON CONFLICT: registering the same uploaded object twice is a no-op.
		await pool().query(
			`INSERT INTO kyc_documents (member_id, doc_type, s3_key, original_name)
       VALUES ($1,$2,$3,$4) ON CONFLICT (s3_key) DO NOTHING`,
			[memberId, body.data.docType, body.data.key, body.data.originalName ?? null],
		);
		// A rejected member re-submitting documents re-enters the review queue.
		await pool().query(
			`UPDATE members SET kyc_status = 'pending' WHERE id = $1 AND kyc_status = 'rejected'`,
			[memberId],
		);
		return reply.status(201).send(await listKycDocuments(memberId));
	});

	app.get("/me/kyc/documents", auth, async (req) => {
		return listKycDocuments((req.user as Auth).sub);
	});

	// Delete a KYC document reference from the DB only (no S3 delete).
	// Scoped to the JWT owner — a member cannot delete another member's document.
	app.delete("/me/kyc/documents/:id", auth, async (req, reply) => {
		const memberId = (req.user as Auth).sub;
		const docId = (req.params as { id: string }).id;
		const { rowCount } = await pool().query(
			`DELETE FROM kyc_documents WHERE id = $1 AND member_id = $2`,
			[docId, memberId],
		);
		if (!rowCount)
			return reply
				.status(404)
				.send({ error: { code: "NOT_FOUND", message: "Document not found" } });
		return reply.send(await listKycDocuments(memberId));
	});

	// ===== Payment-proof upload (S3 payment-proofs-img/{memberId}/ — private prefix) =====
	const PaymentProofPresignBody = z.object({
		contentType: z.enum(IMAGE_CONTENT_TYPES),
		sizeBytes: z.number().int().positive().max(MAX_UPLOAD_BYTES),
	});

	app.post(
		"/me/orders/:orderId/payment-proof/presign",
		auth,
		async (req, reply) => {
			const body = PaymentProofPresignBody.safeParse(req.body);
			if (!body.success)
				return reply.status(400).send({ error: body.error.flatten() });
			if (!s3Configured())
				return reply.status(503).send({ error: "S3_NOT_CONFIGURED" });

			const memberId = (req.user as Auth).sub;
			const { orderId } = req.params as { orderId: string };

			// Verify the order belongs to this member and is still open.
			const { rows } = await pool().query<{ status: string }>(
				"SELECT status FROM orders WHERE id = $1 AND member_id = $2",
				[orderId, memberId],
			);
			if (!rows[0])
				return reply.status(404).send({ error: "Order not found" });
			if (!["created", "paid", "rejected"].includes(rows[0].status))
				return reply
					.status(409)
					.send({ error: "Order is already confirmed or closed" });

			// Key is minted from JWT identity — member cannot write outside their own folder.
			const key = buildKey(
				`payment-proofs-img/${memberId}`,
				body.data.contentType,
			);
			return presignUpload(key, body.data.contentType);
		},
	);

	const PaymentProofBody = z.object({ key: z.string() });

	app.post("/me/orders/:orderId/payment-proof", auth, async (req, reply) => {
		const body = PaymentProofBody.safeParse(req.body);
		if (!body.success)
			return reply.status(400).send({ error: body.error.flatten() });

		const memberId = (req.user as Auth).sub;
		const { orderId } = req.params as { orderId: string };

		// Validate the key belongs to this member's payment-proofs folder.
		if (!paymentProofKeyRe(memberId).test(body.data.key))
			return reply
				.status(400)
				.send({ error: { code: "BAD_REQUEST", message: "Invalid key" } });

		// Confirm the object actually landed in S3 before recording it.
		if (!(await objectExists(body.data.key)))
			return reply.status(400).send({
				error: { code: "BAD_REQUEST", message: "Upload not found in storage" },
			});

		// Verify the order is still open before recording the proof.
		const { rows: orderRows } = await pool().query<{ status: string }>(
			"SELECT status FROM orders WHERE id = $1 AND member_id = $2",
			[orderId, memberId],
		);
		if (!orderRows[0])
			return reply
				.status(404)
				.send({ error: "Order not found or already confirmed" });
		if (!["created", "paid", "rejected"].includes(orderRows[0].status))
			return reply
				.status(409)
				.send({ error: "Order is already confirmed or closed" });

		// Insert proof into the proofs table (idempotent: same key twice is a no-op).
		await pool().query(
			`INSERT INTO order_payment_proofs (order_id, s3_key)
			 VALUES ($1, $2)
			 ON CONFLICT (s3_key) DO NOTHING`,
			[orderId, body.data.key],
		);

		// Flip order to 'paid'. Also clears rejection_reason when re-submitting after rejection.
		await pool().query(
			`UPDATE orders SET status = 'paid', rejection_reason = NULL
			  WHERE id = $1 AND member_id = $2 AND status IN ('created', 'rejected')`,
			[orderId, memberId],
		);

		return reply.send({ ok: true });
	});

	const BankBody = z.object({
		accountName: z.string().min(2, "Name required"),
		accountNumber: z.string().min(9, "Valid account number required"),
		ifsc: z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, "Invalid IFSC format"),
	});

	app.put("/me/bank", auth, async (req, reply) => {
		const body = BankBody.safeParse(req.body);
		if (!body.success)
			return reply.status(400).send({ error: body.error.flatten() });
		const memberId = (req.user as Auth).sub;
		await pool().query(
			`UPDATE members
			    SET bank_account_name = $2, bank_account_number = $3, bank_ifsc = $4,
			        bank_status = 'pending'
			  WHERE id = $1`,
			[
				memberId,
				body.data.accountName,
				body.data.accountNumber,
				body.data.ifsc,
			],
		);
		const me = await buildMe(memberId);
		return reply.send(me);
	});

	// ===== products & orders =====
	app.get("/products", async () => {
		const { rows } = await pool().query<{
			id: number;
			name: string;
			description: string;
			base_price: string;
		}>(
			"SELECT id, name, description, base_price FROM products WHERE active = TRUE ORDER BY id",
		);
		const images = await imagesByProduct(rows.map((p) => Number(p.id)));
		return rows.map((p) => {
			const base = toPaise(p.base_price);
			return {
				id: Number(p.id),
				name: p.name,
				description: p.description,
				basePricePaise: Number(base),
				gstPaise: 0,
				totalPaise: Number(base),
				badges: PRODUCT_BADGES[Number(p.id)] ?? [],
				images: images.get(Number(p.id)) ?? [],
			};
		});
	});

	app.get("/products/:id", async (req, reply) => {
		const { id } = req.params as { id: string };
		const idNum = Number(id);
		if (!Number.isInteger(idNum) || idNum <= 0)
			return reply.status(404).send({ error: "Not found" });
		const { rows } = await pool().query<{
			id: number;
			name: string;
			description: string;
			base_price: string;
		}>(
			// products.id is SMALLINT; without the cast the bind parameter is inferred
			// as smallint and ids > 32767 raise 22003 instead of matching nothing.
			"SELECT id, name, description, base_price FROM products WHERE id=$1::int AND active=TRUE",
			[idNum],
		);
		if (!rows[0]) return reply.status(404).send({ error: "Not found" });
		const images = await imagesByProduct([idNum]);
		const p = rows[0];
		const base = toPaise(p.base_price);
		return {
			id: Number(p.id),
			name: p.name,
			description: p.description,
			basePricePaise: Number(base),
			gstPaise: 0,
			totalPaise: Number(base),
			badges: PRODUCT_BADGES[Number(p.id)] ?? [],
			images: images.get(Number(p.id)) ?? [],
		};
	});

	const CreateOrderBody = z.object({ productId: z.number().int().positive() });
	app.post("/orders", auth, async (req, reply) => {
		const body = CreateOrderBody.safeParse(req.body);
		if (!body.success)
			return reply
				.status(400)
				.send({ error: { code: "BAD_REQUEST", message: "Invalid body" } });
		const memberId = (req.user as Auth).sub;

		// KYC gate — skipped when management has enabled the kyc_optional toggle.
		const kycOptionalFlag = await getSetting<boolean>("kyc_optional");
		if (!kycOptionalFlag) {
			const { rows: kycRows } = await pool().query<{ kyc_status: string }>(
				"SELECT kyc_status FROM members WHERE id = $1",
				[memberId],
			);
			if (kycRows[0]?.kyc_status !== "verified")
				return reply.status(409).send({
					error: {
						code: "KYC_REQUIRED",
						message: "KYC verification is required before purchase",
					},
				});
		}

		// Dedupe + pricing extracted into createOrder (see services/orderService.ts).
		// Note: idempotencyKey deliberately NOT returned to the member (see GAPS G-2).
		try {
			const result = await createOrder(memberId, body.data.productId);
			return reply.status(result.wasNew ? 201 : 200).send({
				orderId: result.orderId,
				totalPaise: Number(result.totalPaise),
				status: result.status,
			});
		} catch (e: unknown) {
			const err = e as Error & { statusCode?: number };
			return reply
				.status(err.statusCode ?? 500)
				.send({ error: { code: "ERROR", message: err.message } });
		}
	});

	// GET /me/orders — full order history for the logged-in member.
	app.get("/me/orders", auth, async (req) => {
		const memberId = (req.user as Auth).sub;
		const { rows } = await pool().query<{
			id: string;
			product_id: number;
			product_name: string;
			total_amount: string;
			status: string;
			created_at: string;
			rejection_reason: string | null;
		}>(
			`SELECT o.id, o.product_id, p.name AS product_name,
			        o.total_amount, o.status, o.created_at, o.rejection_reason
			   FROM orders o
			   JOIN products p ON p.id = o.product_id
			  WHERE o.member_id = $1
			  ORDER BY o.created_at DESC`,
			[memberId],
		);
		return rows.map((r) => ({
			orderId: r.id,
			productId: r.product_id,
			productName: r.product_name,
			totalPaise: Number(toPaise(r.total_amount)),
			status: r.status,
			createdAt: r.created_at,
			rejectionReason: r.rejection_reason ?? undefined,
		}));
	});

	app.get("/orders/:orderId", auth, async (req, reply) => {
		const { orderId } = req.params as { orderId: string };
		const memberId = (req.user as Auth).sub;
		const { rows } = await pool().query<{
			id: string;
			status: string;
			total_amount: string;
			name: string;
			rejection_reason: string | null;
		}>(
			`SELECT o.id, o.status, o.total_amount, p.name, o.rejection_reason
       FROM orders o JOIN products p ON p.id = o.product_id
       WHERE o.id = $1 AND o.member_id = $2`,
			[orderId, memberId],
		);
		if (!rows[0])
			return reply
				.status(404)
				.send({ error: { code: "NOT_FOUND", message: "Order not found" } });
		return {
			orderId: rows[0].id,
			status: rows[0].status,
			productName: rows[0].name,
			totalPaise: Number(toPaise(rows[0].total_amount)),
			rejectionReason: rows[0].rejection_reason ?? undefined,
		};
	});

	// Payment gateway webhook
	const WebhookBody = z.object({
		gatewayEventId: z.string(),
		orderId: z.number().int().positive(),
		paymentRef: z.string(),
		status: z.enum(["success", "failed"]),
	});
	app.post("/webhooks/payment", async (req, reply) => {
		// G-2: constant-time secret comparison prevents timing-based secret enumeration
		if (CFG.WEBHOOK_SECRET) {
			const provided = req.headers["x-webhook-secret"];
			const providedBuf = Buffer.from(String(provided ?? ""));
			const expectedBuf = Buffer.from(CFG.WEBHOOK_SECRET);
			if (
				providedBuf.length !== expectedBuf.length ||
				!timingSafeEqual(providedBuf, expectedBuf)
			) {
				return reply.status(401).send({ error: "Invalid webhook secret" });
			}
		}
		const body = WebhookBody.safeParse(req.body);
		if (!body.success)
			return reply.status(400).send({ error: body.error.flatten() });
		// G-7: failed payments must be recorded as 'failed', not 'paid'
		if (body.data.status === "failed") {
			await pool().query(
				`UPDATE orders SET status = 'failed' WHERE id = $1 AND status = 'created'`,
				[body.data.orderId],
			);
			return { ok: true };
		}
		await confirmOrder(
			body.data.gatewayEventId,
			BigInt(body.data.orderId),
			body.data.paymentRef,
		);
		return { ok: true };
	});

	// ===== network =====
	app.get("/network/tree", auth, async (req, reply) => {
		const user = req.user as Auth;
		const query = req.query as { depth?: string; root?: string };
		const depth = Math.min(
			CFG.MAX_TREE_DEPTH,
			parseInt(query.depth ?? "3", 10) || 3,
		);
		const rootParam =
			query.root === "me" || !query.root ? user.sub : query.root;

		// G-12: authorize tree access — caller must be the root themselves OR appear in
		// the target's placement_path (i.e. the target is in the caller's downline).
		// Return 404 (not 403) to avoid leaking whether a member code exists.
		// Lookup and authorization are one round trip.
		let rootId = rootParam;
		if (!rootParam.match(/^\d+$/)) {
			const { rows } = await pool().query<{ id: string }>(
				`SELECT id FROM members
         WHERE member_code = $1
           AND (id = $2::bigint OR placement_path @> ARRAY[$2::bigint])`,
				[rootParam, user.sub],
			);
			if (!rows[0])
				return reply
					.status(404)
					.send({ error: { code: "NOT_FOUND", message: "Root not found" } });
			rootId = rows[0].id;
		} else if (rootId !== user.sub) {
			const { rows: authRows } = await pool().query<{ ok: number }>(
				`SELECT 1 AS ok FROM members WHERE id = $1 AND placement_path @> ARRAY[$2::bigint]`,
				[rootId, user.sub],
			);
			if (!authRows[0]) {
				return reply
					.status(404)
					.send({ error: { code: "NOT_FOUND", message: "Root not found" } });
			}
		}

		const cacheKey = `tree:${rootId}:${depth}`;
		// Bound the cache read: a stalled Redis connection must degrade to a
		// cache miss, not hang the request indefinitely.
		const cached = await Promise.race([
			redis()
				.get(cacheKey)
				.catch(() => null),
			new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_000)),
		]);
		if (cached) return JSON.parse(cached);

		// Whole subtree (levels 0..depth) in one round trip instead of a
		// level-by-level walk (2 queries per level).
		const { rows: allRows } = await pool().query<TreeRow>(
			`WITH RECURSIVE walk AS (
         SELECT id, member_code, name, position, is_active, is_qualified, parent_id, 0 AS lvl
         FROM members WHERE id = $1::bigint
         UNION ALL
         SELECT m.id, m.member_code, m.name, m.position, m.is_active, m.is_qualified, m.parent_id, w.lvl + 1
         FROM members m JOIN walk w ON m.parent_id = w.id
         WHERE w.lvl < $2::int
       )
       SELECT id, member_code, name, position, is_active, is_qualified, parent_id FROM walk`,
			[rootId, depth],
		);
		const tree = buildTree(allRows, rootId, depth);
		if (!tree)
			return reply
				.status(404)
				.send({ error: { code: "NOT_FOUND", message: "Root not found" } });
		// Fire-and-forget: don't spend a Redis round trip before responding.
		redis()
			.setex(cacheKey, 60, JSON.stringify(tree))
			.catch(() => null);
		return tree;
	});

	app.get("/network/summary", auth, async (req) => {
		const memberId = (req.user as Auth).sub;

		// Independent aggregates — one parallel round trip instead of four
		// sequential ones (the caller's own depth is a scalar subquery).
		const [aggRes, dRes, lvlRes] = await Promise.all([
			pool().query<{
				total: string;
				left_team: string;
				right_team: string;
				active: string;
				qualified: string;
			}>(
				`SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE placement_sides[array_position(placement_path, $1::bigint)] = 'L') AS left_team,
              COUNT(*) FILTER (WHERE placement_sides[array_position(placement_path, $1::bigint)] = 'R') AS right_team,
              COUNT(*) FILTER (WHERE is_active) AS active,
              COUNT(*) FILTER (WHERE is_qualified) AS qualified
       FROM members WHERE placement_path @> ARRAY[$1::bigint]`,
				[memberId],
			),
			pool().query<{
				position: string;
				cnt: string;
			}>(
				`SELECT position, COUNT(*) AS cnt FROM members WHERE parent_id = $1 GROUP BY position`,
				[memberId],
			),
			pool().query<{
				level: string;
				members: string;
			}>(
				`SELECT (cardinality(placement_path)
                 - (SELECT cardinality(placement_path) FROM members WHERE id = $1)) AS level,
                COUNT(*) AS members
       FROM members WHERE placement_path @> ARRAY[$1::bigint]
       GROUP BY 1 ORDER BY 1 LIMIT 12`,
				[memberId],
			),
		]);

		const agg = aggRes.rows;
		const lvlRows = lvlRes.rows;
		const directs = { left: 0, right: 0 };
		for (const r of dRes.rows) {
			if (r.position === "L") directs.left = parseInt(r.cnt);
			if (r.position === "R") directs.right = parseInt(r.cnt);
		}

		const a = agg[0];
		return {
			totalTeam: parseInt(a?.total ?? "0"),
			leftTeam: parseInt(a?.left_team ?? "0"),
			rightTeam: parseInt(a?.right_team ?? "0"),
			activeMembers: parseInt(a?.active ?? "0"),
			qualifiedMembers: parseInt(a?.qualified ?? "0"),
			directs,
			levelDistribution: lvlRows.map((r) => ({
				level: parseInt(r.level),
				members: parseInt(r.members),
			})),
		};
	});

	// "Directs" = members you personally sponsored (sponsor tree).
	app.get("/network/directs", auth, async (req) => {
		const memberId = (req.user as Auth).sub;
		const { rows } = await pool().query<{
			member_code: string;
			name: string;
			position: string | null;
			is_active: boolean;
			is_qualified: boolean;
			created_at: string;
		}>(
			`SELECT member_code, name, position, is_active, is_qualified, created_at
       FROM members WHERE sponsor_id = $1 ORDER BY created_at DESC LIMIT 200`,
			[memberId],
		);
		return {
			items: rows.map((r) => ({
				memberCode: r.member_code,
				name: r.name,
				leg: (r.position ?? "L") as "L" | "R",
				isActive: r.is_active,
				isQualified: r.is_qualified,
				joinedAt: r.created_at,
			})),
			nextCursor: null,
		};
	});

	// All members in the caller's PLACEMENT subtree, level-ordered, searchable.
	app.get("/network/downline", auth, async (req) => {
		const memberId = (req.user as Auth).sub;
		const query = req.query as { q?: string; page?: string; limit?: string };
		const q = (query.q ?? "").trim();
		const limit = Math.min(Math.max(1, Number(query.limit ?? "20") || 20), 100);
		const page = Math.max(1, Number(query.page ?? "1") || 1);
		const offset = (page - 1) * limit;

		const where = `WHERE m.placement_path @> ARRAY[$1::bigint]
        AND ($2 = '' OR m.name ILIKE $3 OR m.member_code ILIKE $3)`;
		const baseParams = [memberId, q, `%${q}%`];

		const [countRes, dataRes] = await Promise.all([
			pool().query<{ total: string }>(
				`SELECT COUNT(*) AS total FROM members m ${where}`,
				baseParams,
			),
			pool().query<{
				member_code: string;
				name: string;
				level: number;
				leg: string | null;
				is_active: boolean;
				is_qualified: boolean;
				created_at: string;
			}>(
				// ORDER BY cardinality(placement_path) equals level order (constant
				// offset per caller) without a per-row subquery in the sort.
				`SELECT m.member_code, m.name,
                cardinality(m.placement_path)
                  - (SELECT cardinality(placement_path) FROM members WHERE id = $1::bigint) AS level,
                m.placement_sides[array_position(m.placement_path, $1::bigint)] AS leg,
                m.is_active, m.is_qualified, m.created_at
         FROM members m
         ${where}
         ORDER BY cardinality(m.placement_path) ASC, m.created_at ASC
         LIMIT $4 OFFSET $5`,
				[...baseParams, limit, offset],
			),
		]);

		return {
			items: dataRes.rows.map((r) => ({
				memberCode: r.member_code,
				name: r.name,
				level: r.level,
				leg: (r.leg ?? "L") as "L" | "R",
				isActive: r.is_active,
				isQualified: r.is_qualified,
				joinedAt: r.created_at,
			})),
			total: Number(countRes.rows[0]?.total ?? 0),
			page,
			limit,
		};
	});

	// ===== dashboard =====
	app.get("/dashboard", auth, async (req) => {
		const memberId = (req.user as Auth).sub;

		const [
			counterRes,
			walletRes,
			deferredRes,
			accrualRes,
			todayRes,
			seriesRes,
			rankRes,
			recentLedger,
		] = await Promise.all([
			pool().query<{
				left_active: string;
				right_active: string;
				left_qualified: string;
				right_qualified: string;
			}>(
				"SELECT left_active, right_active, left_qualified, right_qualified FROM member_counters WHERE member_id = $1",
				[memberId],
			),
			pool().query<{ balance: string }>(
				`SELECT wb.balance FROM wallet_balances wb JOIN accounts a ON a.id = wb.account_id
         WHERE a.owner_id = $1 AND a.kind = 'wallet'`,
				[memberId],
			),
			pool().query<{ balance: string }>(
				`SELECT wb.balance FROM wallet_balances wb JOIN accounts a ON a.id = wb.account_id
         WHERE a.owner_id = $1 AND a.kind = 'deferred_bonus'`,
				[memberId],
			),
			// Income = released accruals; pending = accrued but awaiting the
			// member's own qualification. pairs_matched (deprecated) is replaced by
			// the count of pairs completed anywhere in the member's subtree.
			pool().query<{ released: string; pending: string; cnt: string }>(
				`SELECT COALESCE(SUM(amount) FILTER (WHERE status='released'),0) AS released,
                COALESCE(SUM(amount) FILTER (WHERE status='pending'),0)  AS pending,
                COUNT(*) AS cnt
         FROM pair_accruals WHERE beneficiary_id = $1`,
				[memberId],
			),
			pool().query<{ total: string }>(
				`SELECT COALESCE(SUM(amount),0) AS total FROM pair_accruals
         WHERE beneficiary_id = $1 AND status = 'released'
           AND to_char(released_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD')
             = to_char(now() AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD')`,
				[memberId],
			),
			pool().query<{ d: string; total: string }>(
				`SELECT to_char(released_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS d,
                SUM(amount) AS total
         FROM pair_accruals
         WHERE beneficiary_id = $1 AND status = 'released'
           AND released_at > now() - interval '30 days'
         GROUP BY 1 ORDER BY 1`,
				[memberId],
			),
			pool().query<{ max: string | null }>(
				"SELECT MAX(rank_level) AS max FROM rank_achievements WHERE member_id = $1",
				[memberId],
			),
			ledgerItems(memberId, null, 10),
		]);

		const c = counterRes.rows[0] ?? {
			left_active: "0",
			right_active: "0",
			left_qualified: "0",
			right_qualified: "0",
		};
		const leftActive = parseInt(c.left_active);
		const rightActive = parseInt(c.right_active);
		const pairsMatched = parseInt(accrualRes.rows[0]?.cnt ?? "0");
		const leftQ = parseInt(c.left_qualified);
		const rightQ = parseInt(c.right_qualified);

		const currentRank = rankRes.rows[0]?.max
			? parseInt(rankRes.rows[0].max!)
			: 0;
		const nextLevel = currentRank < 12 ? currentRank + 1 : null;
		const progress =
			nextLevel && nextLevel <= 4
				? {
						leftQualified: leftQ,
						rightQualified: rightQ,
						requiredEachSide: QUALIFIED_THRESHOLDS[nextLevel],
					}
				: null;

		const { items: recent } = recentLedger;

		return {
			totalIncomePaise: Number(toPaise(accrualRes.rows[0]?.released ?? "0")),
			pairMatchIncomePaise: Number(
				toPaise(accrualRes.rows[0]?.released ?? "0"),
			),
			pendingBonusPaise: Number(toPaise(accrualRes.rows[0]?.pending ?? "0")),
			walletBalancePaise: Number(toPaise(walletRes.rows[0]?.balance ?? "0")),
			deferredBalancePaise: Number(
				toPaise(deferredRes.rows[0]?.balance ?? "0"),
			),
			counters: {
				leftActive,
				rightActive,
				leftQualified: leftQ,
				rightQualified: rightQ,
				pairsMatched,
			},
			// Display-only: which leg has more activations and by how much.
			// (Income no longer depends on leg balance.)
			carryForward: {
				side: leftActive > rightActive ? "L" : "R",
				excess: Math.abs(leftActive - rightActive),
			},
			todayPairBonusPaise: Number(toPaise(todayRes.rows[0]?.total ?? "0")),
			rank: {
				current: currentRank,
				currentName: currentRank > 0 ? RANK_NAMES[currentRank] : "Member",
				next: nextLevel,
				progress,
			},
			incomeSeries: seriesRes.rows.map((r) => ({
				date: r.d,
				pairPaise: Number(toPaise(r.total)),
			})),
			recentTransactions: recent.map((r) => ({
				type:
					r.refType === "pair"
						? "pair_bonus"
						: r.refType === "payout"
							? "payout"
							: r.refType === "sweep"
								? "sweep"
								: "purchase",
				amountPaise: r.amountPaise,
				direction: r.direction,
				at: r.at,
			})),
		};
	});

	// ===== pairs =====
	// The member's pair-bonus accrual history: one item per pair completed in
	// their subtree (their own pair included), pending until they qualify.
	app.get("/pairs", auth, async (req) => {
		const memberId = (req.user as Auth).sub;
		const query = req.query as { cursor?: string; limit?: string };
		const limit = Math.min(100, parseInt(query.limit ?? "20", 10) || 20);
		const cursorClause = query.cursor ? "AND pa.id < $3" : "";
		const params: (string | number)[] = [memberId, limit];
		if (query.cursor) params.push(parseInt(query.cursor));

		const { rows } = await pool().query<{
			id: string;
			amount: string;
			status: string;
			accrued_at: string;
			pair_code: string;
			left_code: string;
			right_code: string;
		}>(
			`SELECT pa.id, pa.amount, pa.status, pa.accrued_at,
              mp.member_code AS pair_code,
              ml.member_code AS left_code, mr.member_code AS right_code
       FROM pair_accruals pa
       JOIN pairs p ON p.id = pa.pair_id
       JOIN members mp ON mp.id = p.member_id
       JOIN members ml ON ml.id = p.left_member_id
       JOIN members mr ON mr.id = p.right_member_id
       WHERE pa.beneficiary_id = $1 ${cursorClause}
       ORDER BY pa.id DESC LIMIT $2`,
			params,
		);
		return {
			items: rows.map((r) => ({
				pairMemberCode: r.pair_code,
				leftMemberCode: r.left_code,
				rightMemberCode: r.right_code,
				bonusPaise: Number(toPaise(r.amount)),
				status: r.status as "pending" | "released",
				at: r.accrued_at,
			})),
			nextCursor:
				rows.length === limit ? String(rows[rows.length - 1].id) : null,
		};
	});

	// ===== wallet =====
	app.get("/wallet", auth, async (req) => {
		const memberId = (req.user as Auth).sub;
		const bal = async (kind: string) => {
			const { rows } = await pool().query<{ balance: string }>(
				`SELECT wb.balance FROM wallet_balances wb JOIN accounts a ON a.id = wb.account_id
         WHERE a.owner_id = $1 AND a.kind = $2`,
				[memberId, kind],
			);
			return toPaise(rows[0]?.balance ?? "0");
		};

		// Balances + open window (with the caller's earnings joined in) — one
		// parallel round trip instead of four sequential ones.
		const [walletBal, deferredBal, winRes] = await Promise.all([
			bal("wallet"),
			bal("deferred_bonus"),
			pool().query<{
				window_start: string;
				window_end: string;
				earned: string | null;
			}>(
				`SELECT c.window_start, c.window_end, ce.earned
         FROM cutoffs c
         LEFT JOIN cutoff_earnings ce ON ce.cutoff_id = c.id AND ce.member_id = $1
         WHERE c.status = 'open' LIMIT 1`,
				[memberId],
			),
		]);
		const win = winRes.rows;
		let earnedPaise = 0n;
		let start = new Date().toISOString();
		let end = new Date().toISOString();
		if (win[0]) {
			start = new Date(win[0].window_start).toISOString();
			end = new Date(win[0].window_end).toISOString();
			earnedPaise = toPaise(win[0].earned ?? "0");
		}

		return {
			balancePaise: Number(walletBal),
			deferredPaise: Number(deferredBal),
			currentWindow: {
				start,
				end,
				earnedPaise: Number(earnedPaise),
				capPaise: CFG.CUTOFF_CAP_PAISE,
			},
		};
	});

	app.get("/wallet/ledger", auth, async (req) => {
		const memberId = (req.user as Auth).sub;
		const query = req.query as { cursor?: string; limit?: string };
		const limit = Math.min(100, parseInt(query.limit ?? "20", 10) || 20);
		const { items, nextCursor } = await ledgerItems(
			memberId,
			query.cursor ?? null,
			limit,
		);
		return { items, nextCursor };
	});

	// ===== payouts =====
	app.get("/payouts", auth, async (req) => {
		const memberId = (req.user as Auth).sub;
		const { rows } = await pool().query<{
			scheduled_for: string;
			gross: string;
			tds: string;
			net: string;
			status: string;
			bank_ref: string | null;
		}>(
			`SELECT pb.scheduled_for, pi.gross, pi.tds, pi.net, pi.status, pi.bank_ref
       FROM payout_items pi JOIN payout_batches pb ON pb.id = pi.batch_id
       WHERE pi.member_id = $1 ORDER BY pi.id DESC LIMIT 50`,
			[memberId],
		);
		return {
			items: rows.map((r) => ({
				date: new Date(r.scheduled_for).toISOString(),
				grossPaise: Number(toPaise(r.gross)),
				tdsPaise: Number(toPaise(r.tds)),
				netPaise: Number(toPaise(r.net)),
				status: r.status, // pending | sent | settled | failed — matches the frontend union
				bankRef: r.bank_ref,
			})),
		};
	});

	// ===== ranks =====
	app.get("/ranks/progress", auth, async (req) => {
		const memberId = (req.user as Auth).sub;
		const [counterRes, achRes, legRes] = await Promise.all([
			pool().query<{ left_qualified: string; right_qualified: string }>(
				"SELECT left_qualified, right_qualified FROM member_counters WHERE member_id = $1",
				[memberId],
			),
			pool().query<{
				rank_level: string;
				achieved_at: string;
				verification_status: string;
			}>(
				"SELECT rank_level, achieved_at, verification_status FROM rank_achievements WHERE member_id = $1",
				[memberId],
			),
			pool().query<{
				rank_level: string;
				left_count: string;
				right_count: string;
			}>(
				"SELECT rank_level, left_count, right_count FROM leg_rank_counters WHERE member_id = $1",
				[memberId],
			),
		]);

		const leftQ = parseInt(counterRes.rows[0]?.left_qualified ?? "0");
		const rightQ = parseInt(counterRes.rows[0]?.right_qualified ?? "0");
		const achieved = new Map(
			achRes.rows.map((r) => [parseInt(r.rank_level), r]),
		);
		const legMap: Record<number, { left: number; right: number }> = {};
		for (const r of legRes.rows) {
			legMap[parseInt(r.rank_level)] = {
				left: parseInt(r.left_count),
				right: parseInt(r.right_count),
			};
		}

		const levels = [];
		for (let level = 1; level <= 12; level++) {
			const ach = achieved.get(level);
			const requirement =
				level <= 4
					? {
							kind: "qualified" as const,
							requiredEachSide: QUALIFIED_THRESHOLDS[level],
							leftQualified: leftQ,
							rightQualified: rightQ,
						}
					: {
							kind: "achiever" as const,
							requiredRank: level - 1,
							leftAchievers: legMap[level - 1]?.left ?? 0,
							rightAchievers: legMap[level - 1]?.right ?? 0,
						};
			levels.push({
				level,
				name: RANK_NAMES[level],
				achieved: !!ach,
				achievedAt: ach ? ach.achieved_at : null,
				verificationStatus: ach ? ach.verification_status : null,
				requirement,
			});
		}
		return { levels };
	});
}
