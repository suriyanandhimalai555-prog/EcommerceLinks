import argon2 from "argon2";
import { randomUUID } from "crypto";
import type pg from "pg";
import { CFG } from "../config.js";
import { writeOutbox } from "../events/outbox.js";
import { pool, withTxn } from "../lib/db.js";
import { claimNextMemberCode } from "../lib/ids.js";
import { redis } from "../lib/redis.js";
import { deleteObject } from "../lib/s3.js";

// Each member may refer at most 2 people; a new registrant is always placed
// directly under their sponsor. Without a requested leg, the slot auto-fills —
// first referral fills L, second fills R. With a requested leg (from tapping a
// specific vacant slot in the tree), that exact slot is used, or 409 if it is
// already taken (we never silently drop the recruit onto the other leg).
// The sponsor row lock (FOR UPDATE) serializes concurrent registrations under
// the same sponsor so two of them cannot both claim the last open slot.
async function resolvePosition(
	sponsorId: bigint,
	preferredLeg: "L" | "R" | undefined,
	c: pg.PoolClient,
): Promise<"L" | "R"> {
	const { rows } = await c.query<{ position: "L" | "R" }>(
		"SELECT position FROM members WHERE parent_id = $1",
		[sponsorId],
	);
	const taken = rows.map((r) => r.position);
	if (taken.includes("L") && taken.includes("R")) {
		const e = new Error("Referral limit reached") as Error & {
			statusCode: number;
		};
		e.statusCode = 409;
		throw e;
	}
	if (preferredLeg) {
		if (taken.includes(preferredLeg)) {
			const side = preferredLeg === "L" ? "Left" : "Right";
			const e = new Error(`${side} position already filled`) as Error & {
				statusCode: number;
			};
			e.statusCode = 409;
			throw e;
		}
		return preferredLeg;
	}
	return taken.includes("L") ? "R" : "L";
}

interface RegisterInput {
	sponsorCode: string;
	name: string;
	phone: string;
	email: string;
	password: string;
	// Optional requested placement side. When set (from a leg-specific referral
	// link), the recruit is pinned to this slot or the registration 409s if it
	// is taken. Omitted → auto L-then-R (unchanged legacy behavior).
	leg?: "L" | "R";
}

export async function registerMember(
	input: RegisterInput,
): Promise<{ memberId: bigint; memberCode: string }> {
	const MAX_RETRIES = 5;

	// Email is the login identifier — store it lowercase so the UNIQUE
	// constraint is effectively case-insensitive.
	const email = input.email.trim().toLowerCase();

	// G-14: hash the password BEFORE opening the transaction so the slow CPU
	// work does not hold a pooled connection, and does not repeat on retries.
	const passwordHash = await argon2.hash(input.password);

	for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
		try {
			return await withTxn(async (c) => {
				// Resolve sponsor
				const { rows: sRows } = await c.query<{
					id: string;
					placement_path: string[];
					placement_sides: string[];
					role: string;
				}>(
					"SELECT id, placement_path, placement_sides, role FROM members WHERE member_code = $1 FOR UPDATE",
					[input.sponsorCode],
				);
				if (sRows.length === 0) {
					const e = new Error("Sponsor not found") as Error & {
						statusCode: number;
					};
					e.statusCode = 404;
					throw e;
				}
				// Off-tree master accounts are off-tree: nothing may ever be placed under
				// them. Enforced here (not only at the register route) so every
				// caller — including simulate/test scripts — hits the same wall.
				if (sRows[0].role === "management" || sRows[0].role === "payout") {
					const e = new Error(
						"This code cannot be used as a sponsor",
					) as Error & { statusCode: number };
					e.statusCode = 409;
					throw e;
				}
				const sponsor = sRows[0];
				const sponsorId = BigInt(sponsor.id);

				// Direct placement: the sponsor IS the binary parent (2-referral cap)
				const position = await resolvePosition(sponsorId, input.leg, c);
				const parentId = sponsorId;

				// path = sponsor.placement_path + sponsor.id; sides = sponsor.placement_sides + position
				const newPath = [
					...(sponsor.placement_path ?? []).map(String),
					String(sponsorId),
				];
				const newSides = [...(sponsor.placement_sides ?? []), position];

				// Claim a gapless member code inside this txn — if the txn
				// rolls back, the counter increment also rolls back (no gaps).
				const { code: memberCode } = await claimNextMemberCode(c);

				const { rows: ins } = await c.query<{ id: string }>(
					`INSERT INTO members
             (member_code, name, phone, email, password_hash,
              sponsor_id, parent_id, position, placement_path, placement_sides)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           RETURNING id`,
					[
						memberCode,
						input.name,
						input.phone,
						email,
						passwordHash,
						sponsorId,
						parentId,
						position,
						newPath,
						newSides,
					],
				);
				const memberId = BigInt(ins[0].id);

				// Counters row + accounts + wallet_balances
				await c.query("INSERT INTO member_counters (member_id) VALUES ($1)", [
					memberId,
				]);

				const { rows: wRows } = await c.query<{ id: string }>(
					`INSERT INTO accounts (owner_type, owner_id, kind) VALUES ('member',$1,'wallet') RETURNING id`,
					[memberId],
				);
				const { rows: dRows } = await c.query<{ id: string }>(
					`INSERT INTO accounts (owner_type, owner_id, kind) VALUES ('member',$1,'deferred_bonus') RETURNING id`,
					[memberId],
				);
				const { rows: xRows } = await c.query<{ id: string }>(
					`INSERT INTO accounts (owner_type, owner_id, kind) VALUES ('member',$1,'withdrawable') RETURNING id`,
					[memberId],
				);
				await c.query(
					"INSERT INTO wallet_balances (account_id, balance) VALUES ($1,0),($2,0),($3,0)",
					[wRows[0].id, dRows[0].id, xRows[0].id],
				);

				await writeOutbox(c, {
					event_id: randomUUID(),
					event_type: "MemberRegistered",
					occurred_at: new Date().toISOString(),
					schema_version: 1,
					member_id: Number(memberId),
					sponsor_id: Number(sponsorId),
					parent_id: Number(parentId),
					position,
					placement_path: newPath.map(Number),
					placement_sides: newSides,
				});

				return { memberId, memberCode };
			});
		} catch (err: unknown) {
			const pg = err as {
				code?: string;
				constraint?: string;
				statusCode?: number;
			};
			// Duplicate placement slot — race condition with another registration, retry
			if (
				pg.code === "23505" &&
				pg.constraint === "uq_placement_slot" &&
				attempt < MAX_RETRIES - 1
			) {
				continue;
			}
			// G-10: duplicate email → 409 instead of 500. Phone is intentionally
			// non-unique (families/groups share a contact number; login is email-only),
			// so there is no members_phone_key violation to map — see migration 029.
			if (pg.code === "23505" && pg.constraint === "members_email_key") {
				const e = new Error("Email address already registered") as Error & {
					statusCode: number;
				};
				e.statusCode = 409;
				throw e;
			}
			throw err;
		}
	}

	const e = new Error(
		"Placement slot conflict — max retries exceeded",
	) as Error & { statusCode: number };
	e.statusCode = 409;
	throw e;
}

/**
 * deleteInactiveMember — hard-deletes a member who has never activated.
 *
 * Guards (all enforced under a FOR UPDATE lock so concurrent deletes / activations
 * cannot race):
 *   • member must exist (else 404)
 *   • role must not be 'management' (else 403)
 *   • is_active must be false (else 409)
 *   • must be a childless leaf — no member has parent_id pointing at it (else 409)
 *   • must have no live orders (created / paid / confirmed) (else 409)
 *
 * Cleanup order respects FK dependencies (child rows before the members row).
 * Post-commit: best-effort S3 deletion + Redis tree-cache invalidation so the
 * vacated slot appears immediately in the admin tree without a 60 s TTL wait.
 */
export async function deleteInactiveMember(
	actorId: string,
	memberCode: string,
): Promise<void> {
	const s3Keys: string[] = [];
	let parentId: string | null = null;

	await withTxn(async (c) => {
		// Lock the target row so concurrent activation / deletion can't race.
		const { rows: tRows } = await c.query<{
			id: string;
			role: string;
			is_active: boolean;
			parent_id: string | null;
			name: string;
			email: string;
			member_code: string;
		}>(
			`SELECT id, role, is_active, parent_id, name, email, member_code
       FROM members WHERE member_code = $1 FOR UPDATE`,
			[memberCode],
		);
		if (!tRows[0])
			throw Object.assign(new Error("Member not found"), { statusCode: 404 });
		const target = tRows[0];

		if (target.role === "management" || target.role === "payout")
			throw Object.assign(
				new Error("Cannot delete a management or payout account"),
				{ statusCode: 403 },
			);

		if (target.is_active)
			throw Object.assign(
				new Error("Member is active and cannot be deleted"),
				{ statusCode: 409 },
			);

		// Guard: member must be a leaf — no one placed beneath them.
		const { rows: childRows } = await c.query<{ cnt: string }>(
			"SELECT COUNT(*) AS cnt FROM members WHERE parent_id = $1",
			[target.id],
		);
		if (Number(childRows[0].cnt) > 0)
			throw Object.assign(
				new Error(
					"Member has their own referrals — remove those first",
				),
				{ statusCode: 409 },
			);

		// Guard: no one sponsored by this member (sponsor_id is a NO-ACTION self-FK
		// with no cascade). Since the July-2026 cap, sponsor_id = parent_id for new
		// rows so the check above already covers them, but pre-cap rows can have
		// sponsor_id ≠ parent_id — without this guard the final DELETE FROM members
		// would raise FK 23503 (uncaught 500) instead of this clean 409.
		const { rows: sponsoredRows } = await c.query<{ cnt: string }>(
			"SELECT COUNT(*) AS cnt FROM members WHERE sponsor_id = $1",
			[target.id],
		);
		if (Number(sponsoredRows[0].cnt) > 0)
			throw Object.assign(
				new Error(
					"Member has sponsored others — remove those first",
				),
				{ statusCode: 409 },
			);

		// Guard: no live orders (created / paid / confirmed).
		const { rows: orderRows } = await c.query<{ cnt: string }>(
			`SELECT COUNT(*) AS cnt FROM orders
       WHERE member_id = $1 AND status IN ('created','paid','confirmed')`,
			[target.id],
		);
		if (Number(orderRows[0].cnt) > 0)
			throw Object.assign(
				new Error("Member has an order in progress"),
				{ statusCode: 409 },
			);

		// Collect S3 keys before deleting rows (for post-commit cleanup).
		const { rows: proofRows } = await c.query<{ s3_key: string }>(
			`SELECT opp.s3_key
       FROM order_payment_proofs opp
       JOIN orders o ON o.id = opp.order_id
       WHERE o.member_id = $1`,
			[target.id],
		);
		for (const r of proofRows) s3Keys.push(r.s3_key);

		const { rows: kycRows } = await c.query<{ s3_key: string }>(
			"SELECT s3_key FROM kyc_documents WHERE member_id = $1",
			[target.id],
		);
		for (const r of kycRows) s3Keys.push(r.s3_key);

		// FK-ordered cleanup.
		await c.query(
			`DELETE FROM order_payment_proofs
       WHERE order_id IN (SELECT id FROM orders WHERE member_id = $1)`,
			[target.id],
		);
		await c.query("DELETE FROM orders WHERE member_id = $1", [target.id]);
		await c.query("DELETE FROM kyc_documents WHERE member_id = $1", [
			target.id,
		]);
		await c.query(
			`DELETE FROM wallet_balances
       WHERE account_id IN (
         SELECT id FROM accounts
         WHERE owner_type = 'member' AND owner_id = $1
       )`,
			[target.id],
		);
		await c.query(
			"DELETE FROM accounts WHERE owner_type = 'member' AND owner_id = $1",
			[target.id],
		);
		await c.query("DELETE FROM member_counters WHERE member_id = $1", [
			target.id,
		]);
		await c.query("DELETE FROM refresh_tokens WHERE member_id = $1", [
			target.id,
		]);
		await c.query("DELETE FROM members WHERE id = $1", [target.id]);

		// Audit log — same INSERT shape as admin.ts block endpoint.
		await c.query(
			`INSERT INTO admin_audit_log
         (actor_id, action, target_type, target_id, before_state, after_state)
       VALUES ($1,'delete_member','member',$2,$3,$4)`,
			[
				actorId,
				target.id,
				{
					name: target.name,
					email: target.email,
					member_code: target.member_code,
					is_active: false,
				},
				null,
			],
		);

		parentId = target.parent_id;
	});

	// Post-commit: best-effort S3 cleanup (same pattern as productService.deleteProduct).
	for (const key of s3Keys) {
		await deleteObject(key).catch(() => null);
	}

	// Bust the Redis tree cache so the vacated slot shows up immediately in the
	// admin tree view (keys written by frontend.ts /network/tree at 60 s TTL).
	if (parentId) {
		const delKeys: string[] = [];
		for (let d = 1; d <= CFG.MAX_TREE_DEPTH; d++) {
			delKeys.push(`tree:${parentId}:${d}`);
		}
		await redis().del(...delKeys).catch(() => null);
	}
}

// Shared helper: look up a member by email for auth (emails are stored lowercase)
export async function findMemberByEmail(email: string) {
	const { rows } = await pool().query<{
		id: string;
		member_code: string;
		name: string;
		phone: string;
		password_hash: string;
		is_active: boolean;
		kyc_status: string;
		bank_status: string;
	}>(
		"SELECT id, member_code, name, phone, password_hash, is_active, kyc_status, bank_status FROM members WHERE email = $1",
		[email.trim().toLowerCase()],
	);
	return rows[0] ?? null;
}
