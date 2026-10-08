/**
 * coinService.ts — AVG Coin balance management.
 *
 * Member coin total  =  SUM(avg_coin_grants.coins)
 *                     + SUM(coin_adjustments.delta)
 *
 * avg_coin_grants is campaign-sourced (order-backed, append-only, always positive).
 * coin_adjustments is management-sourced (manual add/deduct, signed, audit-logged).
 *
 * The 0-floor invariant (total never negative) is enforced inside adjustMemberCoins
 * under a FOR UPDATE row lock — this cannot race.
 */

import { pool, withTxn } from "../lib/db.js";

export interface CoinGrantRow {
	id: string;
	coins: number;
	packageValuePaise: number;
	grantedAt: string;
	orderId: string;
}

export interface CoinAdjustmentRow {
	id: string;
	delta: number;
	reason: string;
	actorId: string;
	createdAt: string;
}

export interface MemberCoinsDetail {
	memberId: string;
	name: string;
	memberCode: string;
	packageValuePaise: number;
	totalCoins: number;
	grants: CoinGrantRow[];
	adjustments: CoinAdjustmentRow[];
}

/**
 * getMemberCoinTotal — sum grants + adjustments for a single member.
 * Used by the /me profile builder and /me/avg-coins endpoint so the
 * member-facing total always reflects manual corrections.
 */
export async function getMemberCoinTotal(memberId: string): Promise<number> {
	const { rows } = await pool().query<{ total: string }>(
		`SELECT
		   COALESCE(
		     (SELECT SUM(coins)  FROM avg_coin_grants   WHERE member_id = $1), 0
		   ) +
		   COALESCE(
		     (SELECT SUM(delta)  FROM coin_adjustments  WHERE member_id = $1), 0
		   ) AS total`,
		[memberId],
	);
	return Number(rows[0]?.total ?? "0");
}

/**
 * getMemberCoins — full coin detail for the admin view.
 * Returns member identity + sorted history of grants and adjustments.
 */
export async function getMemberCoins(
	memberId: string,
): Promise<MemberCoinsDetail | null> {
	// Member identity
	const { rows: mRows } = await pool().query<{
		id: string;
		name: string;
		member_code: string;
		package_value_paise: string;
	}>(
		`SELECT id, name, member_code, package_value_paise
		   FROM members WHERE id = $1`,
		[memberId],
	);
	if (!mRows[0]) return null;

	const [grantsRes, adjustRes] = await Promise.all([
		pool().query<{
			id: string;
			coins: string;
			package_value_paise: string;
			granted_at: string;
			order_id: string;
		}>(
			`SELECT id, coins, package_value_paise, granted_at, order_id
			   FROM avg_coin_grants
			  WHERE member_id = $1
			  ORDER BY granted_at DESC`,
			[memberId],
		),
		pool().query<{
			id: string;
			delta: string;
			reason: string;
			actor_id: string;
			created_at: string;
		}>(
			`SELECT id, delta, reason, actor_id, created_at
			   FROM coin_adjustments
			  WHERE member_id = $1
			  ORDER BY created_at DESC`,
			[memberId],
		),
	]);

	const grants: CoinGrantRow[] = grantsRes.rows.map((r) => ({
		id: r.id,
		coins: Number(r.coins),
		packageValuePaise: Number(BigInt(r.package_value_paise)),
		grantedAt: r.granted_at,
		orderId: r.order_id,
	}));

	const adjustments: CoinAdjustmentRow[] = adjustRes.rows.map((r) => ({
		id: r.id,
		delta: Number(r.delta),
		reason: r.reason,
		actorId: r.actor_id,
		createdAt: r.created_at,
	}));

	const totalCoins =
		grants.reduce((s, g) => s + g.coins, 0) +
		adjustments.reduce((s, a) => s + a.delta, 0);

	return {
		memberId: mRows[0].id,
		name: mRows[0].name,
		memberCode: mRows[0].member_code,
		packageValuePaise: Number(BigInt(mRows[0].package_value_paise)),
		totalCoins,
		grants,
		adjustments,
	};
}

/**
 * adjustMemberCoins — apply a signed coin delta (management-only).
 *
 * Guards:
 *  - Member must exist (404).
 *  - current total + delta must be >= 0 (409 "would make balance negative").
 *
 * Writes an admin_audit_log row inside the same transaction.
 * Returns the new total.
 */
export async function adjustMemberCoins(
	memberId: string,
	actorId: string,
	delta: number,
	reason: string,
): Promise<number> {
	let newTotal = 0;

	await withTxn(async (c) => {
		// Lock the member row to serialise concurrent adjustments.
		const { rows: mRows } = await c.query<{ id: string }>(
			`SELECT id FROM members WHERE id = $1 FOR UPDATE`,
			[memberId],
		);
		if (!mRows[0]) {
			const e = Object.assign(new Error("Member not found"), { statusCode: 404 });
			throw e;
		}

		// Current total (grants + prior adjustments) inside the same txn.
		const { rows: totRows } = await c.query<{ total: string }>(
			`SELECT
			   COALESCE(
			     (SELECT SUM(coins) FROM avg_coin_grants  WHERE member_id = $1), 0
			   ) +
			   COALESCE(
			     (SELECT SUM(delta) FROM coin_adjustments WHERE member_id = $1), 0
			   ) AS total`,
			[memberId],
		);
		const currentTotal = Number(totRows[0]?.total ?? "0");

		if (currentTotal + delta < 0) {
			const e = Object.assign(
				new Error(
					`Adjustment would make balance negative (current ${currentTotal}, delta ${delta})`,
				),
				{ statusCode: 409 },
			);
			throw e;
		}

		// Insert the adjustment row.
		await c.query(
			`INSERT INTO coin_adjustments (member_id, delta, reason, actor_id)
			 VALUES ($1, $2, $3, $4)`,
			[memberId, delta, reason, actorId],
		);

		newTotal = currentTotal + delta;

		// Audit log.
		await c.query(
			`INSERT INTO admin_audit_log
			   (actor_id, action, target_type, target_id, before_state, after_state)
			 VALUES ($1, 'coin_adjustment', 'member', $2, $3, $4)`,
			[
				actorId,
				memberId,
				{ totalCoins: currentTotal },
				{ totalCoins: newTotal, delta, reason },
			],
		);
	});

	return newTotal;
}
