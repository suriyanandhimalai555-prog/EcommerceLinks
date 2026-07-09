/**
 * frontend.ts — serves the exact API contract defined by
 * frontend/src/mocks/handlers.ts and frontend/src/types/api.ts.
 * Replaces orderRoutes, networkRoutes, walletRoutes, reportRoutes.
 * Keep the webhook here (orders.ts is no longer registered).
 */
import { randomUUID } from "crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CFG } from "../config.js";
import { QUALIFIED_THRESHOLDS } from "../domain/ranks.js";
import { pool } from "../lib/db.js";
import { fromPaise, pct, toPaise } from "../lib/money.js";
import { redis } from "../lib/redis.js";
import { confirmOrder } from "../services/orderService.js";

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
		sponsor_code: string | null;
	}>(
		`SELECT m.member_code, m.name, m.phone, m.email, m.kyc_status, m.bank_status,
            m.is_active, m.created_at, m.role, s.member_code AS sponsor_code
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
		role: m.role as "member" | "admin",
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

	app.put("/me/kyc", auth, async (req, reply) => {
		const memberId = (req.user as Auth).sub;
		await pool().query(
			`UPDATE members SET kyc_status = 'pending' WHERE id = $1 AND kyc_status <> 'verified'`,
			[memberId],
		);
		const me = await buildMe(memberId);
		return reply.send(me);
	});

	app.put("/me/bank", auth, async (req, reply) => {
		const memberId = (req.user as Auth).sub;
		await pool().query(
			`UPDATE members SET bank_status = 'pending' WHERE id = $1 AND bank_status <> 'verified'`,
			[memberId],
		);
		const me = await buildMe(memberId);
		return reply.send(me);
	});

	// ===== products & orders =====
	app.get("/products", async () => {
		const { rows } = await pool().query<{
			id: number;
			name: string;
			base_price: string;
		}>(
			"SELECT id, name, base_price FROM products WHERE active = TRUE ORDER BY id",
		);
		return rows.map((p) => {
			const base = toPaise(p.base_price);
			const gst = pct(base, CFG.GST_PCT);
			return {
				id: Number(p.id),
				name: p.name,
				basePricePaise: Number(base),
				gstPaise: Number(gst),
				totalPaise: Number(base + gst),
				badges: PRODUCT_BADGES[Number(p.id)] ?? [],
			};
		});
	});

	const CreateOrderBody = z.object({ productId: z.number().int().positive() });
	app.post("/orders", auth, async (req, reply) => {
		const body = CreateOrderBody.safeParse(req.body);
		if (!body.success)
			return reply
				.status(400)
				.send({ error: { code: "BAD_REQUEST", message: "Invalid body" } });
		const memberId = (req.user as Auth).sub;

		const { rows: pRows } = await pool().query<{ base_price: string }>(
			"SELECT base_price FROM products WHERE id = $1 AND active = TRUE",
			[body.data.productId],
		);
		if (!pRows[0])
			return reply
				.status(404)
				.send({ error: { code: "NOT_FOUND", message: "Product not found" } });

		const basePaise = toPaise(pRows[0].base_price);
		const gstPaise = pct(basePaise, CFG.GST_PCT);
		const totalPaise = basePaise + gstPaise;
		const idempotencyKey = randomUUID();

		const { rows } = await pool().query<{ id: string }>(
			`INSERT INTO orders (member_id, product_id, base_amount, gst_amount, total_amount, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
			[
				memberId,
				body.data.productId,
				fromPaise(basePaise),
				fromPaise(gstPaise),
				fromPaise(totalPaise),
				idempotencyKey,
			],
		);
		// Note: idempotencyKey deliberately NOT returned (see GAPS G-2)
		return reply.status(201).send({
			orderId: rows[0].id,
			totalPaise: Number(totalPaise),
			status: "created",
		});
	});

	app.get("/orders/:orderId", auth, async (req, reply) => {
		const { orderId } = req.params as { orderId: string };
		const memberId = (req.user as Auth).sub;
		const { rows } = await pool().query<{
			id: string;
			status: string;
			total_amount: string;
			name: string;
		}>(
			`SELECT o.id, o.status, o.total_amount, p.name
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
		};
	});

	// Dev-only: pretend the payment gateway confirmed the order.
	app.post("/dev/simulate-payment", auth, async (req, reply) => {
		if (CFG.NODE_ENV === "production") {
			return reply.status(403).send({
				error: { code: "FORBIDDEN", message: "Not available in production" },
			});
		}
		const body = z
			.object({ orderId: z.union([z.string(), z.number()]) })
			.safeParse(req.body);
		if (!body.success)
			return reply
				.status(400)
				.send({ error: { code: "BAD_REQUEST", message: "orderId required" } });
		const orderId = String(body.data.orderId);
		const { rows } = await pool().query<{ idempotency_key: string }>(
			"SELECT idempotency_key FROM orders WHERE id = $1",
			[orderId],
		);
		if (!rows[0])
			return reply
				.status(404)
				.send({ error: { code: "NOT_FOUND", message: "Order not found" } });
		await confirmOrder(
			rows[0].idempotency_key,
			BigInt(orderId),
			`dev-sim-${orderId}`,
		);
		return { success: true };
	});

	// Payment gateway webhook
	const WebhookBody = z.object({
		gatewayEventId: z.string(),
		orderId: z.number().int().positive(),
		paymentRef: z.string(),
		status: z.enum(["success", "failed"]),
	});
	app.post("/webhooks/payment", async (req, reply) => {
		// G-2: reject if secret is configured and header doesn't match
		if (CFG.WEBHOOK_SECRET) {
			const provided = req.headers["x-webhook-secret"];
			if (provided !== CFG.WEBHOOK_SECRET) {
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
		const depth = Math.min(4, parseInt(query.depth ?? "3", 10) || 3);
		const rootParam =
			query.root === "me" || !query.root ? user.sub : query.root;

		let rootId = rootParam;
		if (!rootParam.match(/^\d+$/)) {
			const { rows } = await pool().query<{ id: string }>(
				"SELECT id FROM members WHERE member_code = $1",
				[rootParam],
			);
			if (!rows[0])
				return reply
					.status(404)
					.send({ error: { code: "NOT_FOUND", message: "Root not found" } });
			rootId = rows[0].id;
		}

		// G-12: authorize tree access — caller must be the root themselves OR appear in
		// the target's placement_path (i.e. the target is in the caller's downline).
		if (rootId !== user.sub) {
			const { rows: authRows } = await pool().query<{ ok: number }>(
				`SELECT 1 AS ok FROM members WHERE id = $1 AND placement_path @> ARRAY[$2::bigint]`,
				[rootId, user.sub],
			);
			if (!authRows[0]) {
				return reply
					.status(403)
					.send({ error: { code: "FORBIDDEN", message: "Access denied" } });
			}
		}

		const cacheKey = `tree:${rootId}:${depth}`;
		const cached = await redis()
			.get(cacheKey)
			.catch(() => null);
		if (cached) return JSON.parse(cached);

		let currentIds = [rootId];
		const allRows: TreeRow[] = [];
		for (let d = 0; d <= depth && currentIds.length > 0; d++) {
			const { rows } = await pool().query<TreeRow>(
				`SELECT id, member_code, name, position, is_active, is_qualified, parent_id
         FROM members WHERE id = ANY($1::bigint[])`,
				[currentIds],
			);
			allRows.push(...rows);
			if (d < depth) {
				const { rows: children } = await pool().query<{ id: string }>(
					`SELECT id FROM members WHERE parent_id = ANY($1::bigint[])`,
					[currentIds],
				);
				currentIds = children.map((r) => r.id);
			} else {
				currentIds = [];
			}
		}
		const tree = buildTree(allRows, rootId, depth);
		if (!tree)
			return reply
				.status(404)
				.send({ error: { code: "NOT_FOUND", message: "Root not found" } });
		await redis()
			.setex(cacheKey, 60, JSON.stringify(tree))
			.catch(() => null);
		return tree;
	});

	app.get("/network/summary", auth, async (req) => {
		const memberId = (req.user as Auth).sub;

		const { rows: meRows } = await pool().query<{ depth: string }>(
			"SELECT cardinality(placement_path) AS depth FROM members WHERE id = $1",
			[memberId],
		);
		const myDepth = parseInt(meRows[0]?.depth ?? "0");

		const { rows: agg } = await pool().query<{
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
		);

		const { rows: dRows } = await pool().query<{
			position: string;
			cnt: string;
		}>(
			`SELECT position, COUNT(*) AS cnt FROM members WHERE parent_id = $1 GROUP BY position`,
			[memberId],
		);
		const directs = { left: 0, right: 0 };
		for (const r of dRows) {
			if (r.position === "L") directs.left = parseInt(r.cnt);
			if (r.position === "R") directs.right = parseInt(r.cnt);
		}

		const { rows: lvlRows } = await pool().query<{
			level: string;
			members: string;
		}>(
			`SELECT (cardinality(placement_path) - $2) AS level, COUNT(*) AS members
       FROM members WHERE placement_path @> ARRAY[$1::bigint]
       GROUP BY 1 ORDER BY 1 LIMIT 12`,
			[memberId, myDepth],
		);

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

	// ===== dashboard =====
	app.get("/dashboard", auth, async (req) => {
		const memberId = (req.user as Auth).sub;

		const [
			counterRes,
			walletRes,
			deferredRes,
			totalRes,
			todayRes,
			seriesRes,
			rankRes,
		] = await Promise.all([
			pool().query<{
				left_active: string;
				right_active: string;
				pairs_matched: string;
				left_qualified: string;
				right_qualified: string;
			}>(
				"SELECT left_active, right_active, pairs_matched, left_qualified, right_qualified FROM member_counters WHERE member_id = $1",
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
			pool().query<{ total: string }>(
				`SELECT COALESCE(SUM(bonus_amount),0) AS total FROM pairs WHERE member_id = $1`,
				[memberId],
			),
			pool().query<{ total: string }>(
				`SELECT COALESCE(SUM(bonus_amount),0) AS total FROM pairs
         WHERE member_id = $1
           AND to_char(created_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD')
             = to_char(now() AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD')`,
				[memberId],
			),
			pool().query<{ d: string; total: string }>(
				`SELECT to_char(created_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS d,
                SUM(bonus_amount) AS total
         FROM pairs WHERE member_id = $1 AND created_at > now() - interval '30 days'
         GROUP BY 1 ORDER BY 1`,
				[memberId],
			),
			pool().query<{ max: string | null }>(
				"SELECT MAX(rank_level) AS max FROM rank_achievements WHERE member_id = $1",
				[memberId],
			),
		]);

		const c = counterRes.rows[0] ?? {
			left_active: "0",
			right_active: "0",
			pairs_matched: "0",
			left_qualified: "0",
			right_qualified: "0",
		};
		const leftActive = parseInt(c.left_active);
		const rightActive = parseInt(c.right_active);
		const pairsMatched = parseInt(c.pairs_matched);
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

		const { items: recent } = await ledgerItems(memberId, null, 10);

		return {
			totalIncomePaise: Number(toPaise(totalRes.rows[0]?.total ?? "0")),
			pairMatchIncomePaise: Number(toPaise(totalRes.rows[0]?.total ?? "0")),
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
			carryForward: {
				side: leftActive > rightActive ? "L" : "R",
				excess: Math.max(leftActive, rightActive) - pairsMatched,
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
	app.get("/pairs", auth, async (req) => {
		const memberId = (req.user as Auth).sub;
		const query = req.query as { cursor?: string; limit?: string };
		const limit = Math.min(100, parseInt(query.limit ?? "20", 10) || 20);
		const cursorClause = query.cursor ? "AND p.id < $3" : "";
		const params: (string | number)[] = [memberId, limit];
		if (query.cursor) params.push(parseInt(query.cursor));

		const { rows } = await pool().query<{
			id: string;
			sequence_no: string;
			bonus_amount: string;
			created_at: string;
			left_code: string;
			right_code: string;
		}>(
			`SELECT p.id, p.sequence_no, p.bonus_amount, p.created_at,
              ml.member_code AS left_code, mr.member_code AS right_code
       FROM pairs p
       JOIN members ml ON ml.id = p.left_member_id
       JOIN members mr ON mr.id = p.right_member_id
       WHERE p.member_id = $1 ${cursorClause}
       ORDER BY p.id DESC LIMIT $2`,
			params,
		);
		return {
			items: rows.map((r) => ({
				sequenceNo: parseInt(r.sequence_no),
				leftMemberCode: r.left_code,
				rightMemberCode: r.right_code,
				bonusPaise: Number(toPaise(r.bonus_amount)),
				at: r.created_at,
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

		const { rows: win } = await pool().query<{
			id: string;
			window_start: string;
			window_end: string;
		}>(
			`SELECT id, window_start, window_end FROM cutoffs WHERE status = 'open' LIMIT 1`,
		);
		let earnedPaise = 0n;
		let start = new Date().toISOString();
		let end = new Date().toISOString();
		if (win[0]) {
			start = new Date(win[0].window_start).toISOString();
			end = new Date(win[0].window_end).toISOString();
			const { rows: ce } = await pool().query<{ earned: string }>(
				"SELECT earned FROM cutoff_earnings WHERE member_id = $1 AND cutoff_id = $2",
				[memberId, win[0].id],
			);
			earnedPaise = toPaise(ce[0]?.earned ?? "0");
		}

		return {
			balancePaise: Number(await bal("wallet")),
			deferredPaise: Number(await bal("deferred_bonus")),
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
