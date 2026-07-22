import { randomUUID } from "crypto";
import { writeOutbox } from "../events/outbox.js";
import { pool, withTxn } from "../lib/db.js";
import { fromPaise, toPaise } from "../lib/money.js";

/**
 * confirmOrder — confirm a payment gateway callback and, if this is the member's
 * first confirmed order, activate the member and emit MemberActivated.
 *
 * Idempotent: calling twice with the same gatewayEventId is safe (second call is a no-op).
 * Returns { activated: true } only when this call was the one that activated the member.
 * Existing callers that ignore the return value are unaffected.
 */
export async function confirmOrder(
	gatewayEventId: string,
	orderId: bigint,
	paymentRef: string,
): Promise<{ activated: boolean }> {
	let activated = false;
	await withTxn(async (c) => {
		const { rowCount, rows } = await c.query<{
			member_id: string;
			product_id: string;
			base_amount: string;
			status: string;
		}>(
			`UPDATE orders SET status = 'confirmed', confirmed_at = now(), payment_ref = $1
       WHERE id = $2 AND idempotency_key = $3 AND status IN ('created','paid')
       RETURNING member_id, product_id, base_amount, status`,
			[paymentRef, orderId, gatewayEventId],
		);
		if (!rowCount || rowCount === 0) return; // already confirmed or not found

		const { member_id, base_amount } = rows[0];
		const memberId = BigInt(member_id);
		const bvPaise = toPaise(base_amount);

		// Check if this is the member's first confirmed order
		const { rows: existingOrders } = await c.query<{ cnt: string }>(
			`SELECT COUNT(*) AS cnt FROM orders
       WHERE member_id = $1 AND status = 'confirmed' AND id != $2`,
			[memberId, orderId],
		);
		const isFirst = existingOrders[0].cnt === "0";

		if (isFirst) {
			activated = true;
			await c.query(
				`UPDATE members SET is_active = TRUE, activated_at = now() WHERE id = $1`,
				[memberId],
			);
			await writeOutbox(c, {
				event_id: randomUUID(),
				event_type: "MemberActivated",
				occurred_at: new Date().toISOString(),
				schema_version: 1,
				member_id: Number(memberId),
				order_id: Number(orderId),
				bv_paise: Number(bvPaise),
			});
		}
	});
	return { activated };
}

/**
 * createOrder — find or create an open order for the given member + product.
 *
 * Encapsulates the pricing and the dedupe logic
 * (returns an existing order in status 'created'/'paid'/'rejected' rather than
 * inserting a duplicate). Callers that need to enforce the KYC gate should do
 * so before calling this function.
 *
 * Returns wasNew=false when an existing open order was found.
 */
export async function createOrder(
	memberId: string,
	productId: number,
): Promise<{
	orderId: string;
	idempotencyKey: string;
	totalPaise: bigint;
	status: string;
	wasNew: boolean;
}> {
	// Return existing open order if one exists (prevents duplicate orders).
	const { rows: openRows } = await pool().query<{
		id: string;
		total_amount: string;
		status: string;
		idempotency_key: string;
	}>(
		`SELECT id, total_amount, status, idempotency_key FROM orders
		  WHERE member_id = $1 AND product_id = $2
		    AND status IN ('created', 'paid', 'rejected')
		  ORDER BY created_at DESC LIMIT 1`,
		[memberId, productId],
	);
	if (openRows[0]) {
		return {
			orderId: openRows[0].id,
			idempotencyKey: openRows[0].idempotency_key,
			totalPaise: toPaise(openRows[0].total_amount),
			status: openRows[0].status,
			wasNew: false,
		};
	}

	const { rows: pRows } = await pool().query<{ base_price: string }>(
		"SELECT base_price FROM products WHERE id = $1 AND active = TRUE",
		[productId],
	);
	if (!pRows[0]) {
		const e = new Error("Product not found") as Error & { statusCode: number };
		e.statusCode = 404;
		throw e;
	}

	const basePaise = toPaise(pRows[0].base_price);
	// GST removed: members pay the flat base price. gst_amount stays in the
	// schema (NOT NULL column) and is written as 0 to preserve historical rows.
	const gstPaise = 0n;
	const totalPaise = basePaise;
	const idempotencyKey = randomUUID();

	let rows: { id: string }[];
	try {
		({ rows } = await pool().query<{ id: string }>(
			`INSERT INTO orders (member_id, product_id, base_amount, gst_amount, total_amount, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
			[
				memberId,
				productId,
				fromPaise(basePaise),
				fromPaise(gstPaise),
				fromPaise(totalPaise),
				idempotencyKey,
			],
		));
	} catch (e: unknown) {
		// FK violation: product was concurrently deleted between the price lookup and here.
		const pg = e as { code?: string };
		if (pg.code === "23503") {
			const err = new Error("Product is no longer available") as Error & { statusCode: number };
			err.statusCode = 409;
			throw err;
		}
		throw e;
	}
	return { orderId: rows[0].id, idempotencyKey, totalPaise, status: "created", wasNew: true };
}
