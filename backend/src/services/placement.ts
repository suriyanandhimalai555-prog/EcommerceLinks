import argon2 from "argon2";
import { randomUUID } from "crypto";
import type pg from "pg";
import { writeOutbox } from "../events/outbox.js";
import { pool, withTxn } from "../lib/db.js";
import { claimNextMemberCode } from "../lib/ids.js";

// Each member may refer at most 2 people; a new registrant is always placed
// directly under their sponsor — first referral fills L, second fills R.
// The sponsor row lock (FOR UPDATE) serializes concurrent registrations under
// the same sponsor so two of them cannot both claim the last open slot.
async function nextChildPosition(
	sponsorId: bigint,
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
	return taken.includes("L") ? "R" : "L";
}

interface RegisterInput {
	sponsorCode: string;
	name: string;
	phone: string;
	email: string;
	password: string;
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
				// Management accounts are off-tree: nothing may ever be placed under
				// them. Enforced here (not only at the register route) so every
				// caller — including simulate/test scripts — hits the same wall.
				if (sRows[0].role === "management") {
					const e = new Error(
						"This code cannot be used as a sponsor",
					) as Error & { statusCode: number };
					e.statusCode = 409;
					throw e;
				}
				const sponsor = sRows[0];
				const sponsorId = BigInt(sponsor.id);

				// Direct placement: the sponsor IS the binary parent (2-referral cap)
				const position = await nextChildPosition(sponsorId, c);
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
				await c.query(
					"INSERT INTO wallet_balances (account_id, balance) VALUES ($1,0),($2,0)",
					[wRows[0].id, dRows[0].id],
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
