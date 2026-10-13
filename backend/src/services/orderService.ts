import { randomUUID } from "crypto";
import { writeOutbox } from "../events/outbox.js";
import { pool, withTxn } from "../lib/db.js";
import { coinsForPackageValuePaise, isWithinCampaign, unitsForPackageValuePaise } from "../lib/campaign.js";
import { CFG } from "../config.js";
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
		// Confirm the order and snapshot the member's current delivery address into
		// the order's ship_* columns in one UPDATE … FROM.  Using a JOIN on member_id
		// guarantees the address reflects whatever the admin last set, even when
		// createOrder() returned a pre-existing order (dedup path).
		const { rowCount, rows } = await c.query<{
			member_id: string;
			product_id: string;
			base_amount: string;
			status: string;
			upgrade_to_value_paise: string | null;
		}>(
			`UPDATE orders o
			    SET status        = 'confirmed',
			        confirmed_at  = now(),
			        payment_ref   = $1,
			        ship_recipient_name = m.addr_recipient_name,
			        ship_phone          = m.addr_phone,
			        ship_line1          = m.addr_line1,
			        ship_line2          = m.addr_line2,
			        ship_city           = m.addr_city,
			        ship_state          = m.addr_state,
			        ship_pincode        = m.addr_pincode
			   FROM members m
			  WHERE o.id = $2
			    AND o.member_id = m.id
			    AND o.idempotency_key = $3
			    AND o.status IN ('created','paid')
			  RETURNING o.member_id, o.product_id, o.base_amount, o.status, o.upgrade_to_value_paise`,
			[paymentRef, orderId, gatewayEventId],
		);
		if (!rowCount || rowCount === 0) return; // already confirmed or not found

		const { member_id, base_amount, upgrade_to_value_paise } = rows[0];
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

		// --- Campaign: package-value ratchet + AVG Coin grant ---
		// For upgrade orders, upgrade_to_value_paise is the target tier (e.g. ₹50k);
		// for regular orders it's null and we use the order's own base_amount.
		// Capture old package_value and lock the member row before ratcheting.
		// FOR UPDATE serialises concurrent upgrade confirms for the same member.
		// (For the isFirst path the member row is already locked by the is_active UPDATE above.)
		const { rows: oldPvRows } = await c.query<{ package_value_paise: string }>(
			`SELECT package_value_paise FROM members WHERE id = $1 FOR UPDATE`,
			[memberId],
		);
		const oldPackagePaise = BigInt(oldPvRows[0]?.package_value_paise ?? "0");

		const effectiveValuePaise = upgrade_to_value_paise
			? BigInt(upgrade_to_value_paise)
			: bvPaise;

		// Ratchet: package_value_paise only ever increases.
		const { rows: pvRows } = await c.query<{ package_value_paise: string }>(
			`UPDATE members
			    SET package_value_paise = GREATEST(package_value_paise, $2)
			  WHERE id = $1
			  RETURNING package_value_paise`,
			[memberId, effectiveValuePaise],
		);
		const newPackagePaise = BigInt(pvRows[0].package_value_paise);
		const newPackageValue = Number(newPackagePaise); // for coinsForPackageValuePaise

		if (isWithinCampaign()) {
			// AVG Coin grant (Phase A) — per-order DELTA, not final-tier total.
			// Granting the delta (new-tier coins − old-tier coins) ensures any upgrade
			// path to a given tier totals exactly that tier's coin allocation:
			//   ₹10k→₹30k (250) then ₹30k→₹50k (250) = 500 total ✓
			//   ₹10k→₹50k direct (500) = 500 total ✓
			// oldPackagePaise was captured before the ratchet above (under FOR UPDATE)
			// so it reflects the member's tier before this confirming order.
			const coinDelta =
				coinsForPackageValuePaise(newPackageValue) -
				coinsForPackageValuePaise(Number(oldPackagePaise));
			if (coinDelta > 0) {
				await c.query(
					`INSERT INTO avg_coin_grants
					   (member_id, order_id, coins, package_value_paise)
					 VALUES ($1, $2, $3, $4)
					 ON CONFLICT (order_id) DO NOTHING`,
					[memberId, orderId, coinDelta, newPackageValue],
				);
			}

			// Phase B: total-unit tracking.
			// Emit CampaignUnitsAdded for every in-window activation or upgrade that
			// changes the member's unit or headcount contribution to the campaign layer.
			//
			// member_delta = 1 on first activation (a new head enters the tree);
			//              = 0 on a pure upgrade (head was already counted).
			// For a new activation the old package is effectively 0 — the head was not
			// in the tree before, so oldUnits = 0n regardless of the product tier.
			//
			// campaignCounter.ts fans both deltas up the path and computes:
			//   T − B  where T = LEAST(total_units) and B = LEAST(headcount),
			// paying only the top-up above what the live engine already covers.
			const memberDelta = activated ? 1 : 0;
			const oldUnits = activated ? 0n : unitsForPackageValuePaise(oldPackagePaise);
			const unitDelta = unitsForPackageValuePaise(newPackagePaise) - oldUnits;
			if (memberDelta > 0 || unitDelta > 0n) {
				await writeOutbox(c, {
					event_id: randomUUID(),
					event_type: "CampaignUnitsAdded",
					occurred_at: new Date().toISOString(),
					schema_version: 1,
					member_id: Number(memberId),
					member_delta: memberDelta,
					unit_delta: Number(unitDelta),
					new_value_paise: Number(newPackagePaise),
				});
			}

			// Emit CampaignEligibilityReached exactly once: the first time a member's
			// package crosses the ₹30k eligibility threshold (₹10k → ₹30k).
			// This triggers release of ALL pending campaign accruals for the member.
			// Already-qualified members (upgrading ₹30k → ₹50k) do not re-emit —
			// their accruals already release immediately via the binary gate in
			// campaignLedger.ts (accrueCampaignPairBonus).
			const eligiblePaise = BigInt(CFG.CAMPAIGN_TIER_30K_PAISE);
			if (oldPackagePaise < eligiblePaise && newPackagePaise >= eligiblePaise) {
				await writeOutbox(c, {
					event_id: randomUUID(),
					event_type: "CampaignEligibilityReached",
					occurred_at: new Date().toISOString(),
					schema_version: 1,
					member_id: Number(memberId),
				});
			}
		}
	});
	return { activated };
}

/**
 * markDelivered — record that a confirmed order has been physically delivered.
 *
 * Only confirmed, not-yet-delivered orders are eligible (guard:
 * status = 'confirmed' AND delivered_at IS NULL).  Returns rowCount so the
 * caller can distinguish "ok" (1) from "already delivered or wrong status" (0).
 *
 * Idempotent: calling twice returns rowCount 0 on the second call — no data
 * is changed and no error is thrown, letting the route reply 409.
 */
export async function markDelivered(
	orderId: string,
	actorId: string,
): Promise<{ rowCount: number }> {
	const { rowCount } = await pool().query(
		`UPDATE orders
		    SET delivered_at = now(),
		        delivered_by = $2
		  WHERE id = $1
		    AND status = 'confirmed'
		    AND delivered_at IS NULL`,
		[orderId, actorId],
	);
	return { rowCount: rowCount ?? 0 };
}

/**
 * unmarkDelivered — revert a delivered order back to "not yet delivered".
 *
 * Only orders that are confirmed AND already delivered (delivered_at IS NOT NULL)
 * are eligible.  Returns rowCount so the route can distinguish ok (1) from
 * "order not delivered / wrong status" (0).  No pipeline side-effects: status
 * stays 'confirmed' throughout, so MemberActivated / counters / money are unaffected.
 */
export async function unmarkDelivered(
	orderId: string,
): Promise<{ rowCount: number }> {
	const { rowCount } = await pool().query(
		`UPDATE orders
		    SET delivered_at = NULL,
		        delivered_by = NULL
		  WHERE id = $1
		    AND status = 'confirmed'
		    AND delivered_at IS NOT NULL`,
		[orderId],
	);
	return { rowCount: rowCount ?? 0 };
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

/**
 * createUpgradeOrder — create an upgrade order for an already-active member.
 *
 * Looks up the inactive upgrade product matching `upgradeTargetPaise` and
 * inserts an order with the delta base_amount and upgrade_to_value_paise set
 * so that confirmOrder will ratchet the member's package_value_paise to the
 * correct target tier rather than the smaller delta amount.
 *
 * Returns the orderId + idempotencyKey ready to pass to confirmOrder.
 */
export async function createUpgradeOrder(
	memberId: string,
	upgradeTargetPaise: number,
): Promise<{ orderId: string; idempotencyKey: string; totalPaise: bigint }> {
	// Look up the upgrade product (used only as an FK vehicle — its base_price is
	// the fixed delta from ₹10k, not from the member's current tier).
	const { rows: pRows } = await pool().query<{
		id: string;
		upgrade_target_paise: string;
	}>(
		`SELECT id, upgrade_target_paise
		   FROM products
		  WHERE upgrade_target_paise = $1
		  LIMIT 1`,
		[upgradeTargetPaise],
	);
	if (!pRows[0]) {
		const e = new Error("Upgrade product not found") as Error & { statusCode: number };
		e.statusCode = 404;
		throw e;
	}

	// Compute the true delta: target tier − member's current package value.
	// This is what the member actually owes, and what gets recorded on the order.
	// confirmOrder ratchets package_value_paise via upgrade_to_value_paise, not
	// base_amount, so recording the true delta here is safe and does not affect
	// the tier ratchet or campaign-unit logic.
	const { rows: mRows } = await pool().query<{ package_value_paise: string }>(
		`SELECT package_value_paise FROM members WHERE id = $1`,
		[memberId],
	);
	const rawPaise = BigInt(mRows[0]?.package_value_paise ?? "0");
	// Normalize to canonical tier floor so the 31 early members who paid ₹11,800
	// (old GST price, package_value_paise = 1_180_000) are treated as ₹10k members
	// and receive a delta of ₹20,000, not ₹18,200.
	const currentPaise =
		rawPaise >= 5_000_000n ? 5_000_000n :
		rawPaise >= 3_000_000n ? 3_000_000n :
		1_000_000n; // ₹10k floor — backend already guards non-active members with 409
	const targetPaise  = BigInt(upgradeTargetPaise);
	const deltaPaise = targetPaise > currentPaise ? targetPaise - currentPaise : 0n;

	const { id: productId, upgrade_target_paise } = pRows[0];
	const idempotencyKey = randomUUID();

	const { rows } = await pool().query<{ id: string }>(
		`INSERT INTO orders
		   (member_id, product_id, base_amount, gst_amount, total_amount, idempotency_key, upgrade_to_value_paise)
		 VALUES ($1,$2,$3,$4,$5,$6,$7)
		 RETURNING id`,
		[
			memberId,
			productId,
			fromPaise(deltaPaise),
			fromPaise(0n),
			fromPaise(deltaPaise),
			idempotencyKey,
			upgrade_target_paise,
		],
	);

	return { orderId: rows[0].id, idempotencyKey, totalPaise: deltaPaise };
}
