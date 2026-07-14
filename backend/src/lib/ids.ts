import type pg from "pg";
import { v5 as uuidv5 } from "uuid";

// RFC 4122 URL namespace
const NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

/** Pure formatter: converts a counter number to a member code string. */
export function formatMemberCode(num: bigint): string {
	return "AVG" + (100000n + num).toString();
}

/**
 * @deprecated Use {@link claimNextMemberCode} for new members.
 * Kept only for backward-compat display (converting an existing db id to a code).
 */
export function nextMemberCode(id: bigint): string {
	return "AVG" + (100000n + id).toString();
}

/**
 * Atomically claim the next gapless member code number from
 * `member_code_counter`. MUST be called inside a transaction — if the txn
 * rolls back, the increment also rolls back, guaranteeing zero gaps.
 *
 * Uses `FOR UPDATE` to serialize concurrent claims within the txn.
 */
export async function claimNextMemberCode(
	client: pg.PoolClient,
): Promise<{ num: bigint; code: string }> {
	const { rows } = await client.query<{ claimed: string }>(
		`UPDATE member_code_counter
		 SET next_val = next_val + 1
		 WHERE id = 1
		 RETURNING next_val - 1 AS claimed`,
	);
	if (!rows[0]) {
		throw new Error(
			"member_code_counter row missing — run migration 021_member_code_counter.sql",
		);
	}
	const num = BigInt(rows[0].claimed);
	return { num, code: formatMemberCode(num) };
}

export function txnUuid(idempotencyKey: string): string {
	return uuidv5(idempotencyKey, NAMESPACE);
}
