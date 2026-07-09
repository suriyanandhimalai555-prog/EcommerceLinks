import argon2 from "argon2";
import { randomUUID } from "crypto";
import type pg from "pg";
import { writeOutbox } from "../events/outbox.js";
import { pool, withTxn } from "../lib/db.js";
import { nextMemberCode } from "../lib/ids.js";

export async function findPlacementSlot(
	sponsorId: bigint,
	leg: "L" | "R",
	c: pg.PoolClient,
): Promise<{ parentId: bigint; position: "L" | "R" }> {
	// Single recursive CTE walk: start at sponsorId and follow the preferred leg
	// down until a node has no child on that side — that node is the placement parent.
	const { rows } = await c.query<{ id: string }>(
		`WITH RECURSIVE walk AS (
       SELECT id FROM members WHERE id = $1
       UNION ALL
       SELECT m.id FROM members m
       JOIN walk w ON m.parent_id = w.id AND m.position = $2
     )
     SELECT id FROM walk ORDER BY id DESC LIMIT 1`,
		[sponsorId, leg],
	);
	return { parentId: BigInt(rows[0]?.id ?? sponsorId), position: leg };
}

interface RegisterInput {
	sponsorCode: string;
	preferredLeg: "L" | "R";
	name: string;
	phone: string;
	email?: string;
	password: string;
}

export async function registerMember(
	input: RegisterInput,
): Promise<{ memberId: bigint; memberCode: string }> {
	const MAX_RETRIES = 5;

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
				}>(
					"SELECT id, placement_path, placement_sides FROM members WHERE member_code = $1",
					[input.sponsorCode],
				);
				if (sRows.length === 0) {
					const e = new Error("Sponsor not found") as Error & {
						statusCode: number;
					};
					e.statusCode = 404;
					throw e;
				}
				const sponsor = sRows[0];
				const sponsorId = BigInt(sponsor.id);

				// Walk to placement slot (single recursive CTE — no unbounded per-level loop)
				const { parentId, position } = await findPlacementSlot(
					sponsorId,
					input.preferredLeg,
					c,
				);

				// Read parent's path arrays
				const { rows: pRows } = await c.query<{
					id: string;
					placement_path: string[];
					placement_sides: string[];
				}>(
					"SELECT id, placement_path, placement_sides FROM members WHERE id = $1",
					[parentId],
				);
				const parent = pRows[0];
				// path = parent.placement_path + parent.id; sides = parent.placement_sides + position
				const newPath = [
					...(parent.placement_path ?? []).map(String),
					String(parent.id),
				];
				const newSides = [...(parent.placement_sides ?? []), position];

				// Insert with a temp unique member_code; update after getting id
				const tmpCode = "TMP-" + randomUUID();
				const { rows: ins } = await c.query<{ id: string }>(
					`INSERT INTO members
             (member_code, name, phone, email, password_hash,
              sponsor_id, parent_id, position, placement_path, placement_sides)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           RETURNING id`,
					[
						tmpCode,
						input.name,
						input.phone,
						input.email ?? null,
						passwordHash,
						sponsorId,
						parentId,
						position,
						newPath,
						newSides,
					],
				);
				const memberId = BigInt(ins[0].id);
				const memberCode = nextMemberCode(memberId);
				await c.query("UPDATE members SET member_code = $1 WHERE id = $2", [
					memberCode,
					memberId,
				]);

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
			// G-10: duplicate phone or email → 409 instead of 500
			if (pg.code === "23505" && pg.constraint === "members_phone_key") {
				const e = new Error("Phone number already registered") as Error & {
					statusCode: number;
				};
				e.statusCode = 409;
				throw e;
			}
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

// Shared helper: look up a member by phone for auth
export async function findMemberByPhone(phone: string) {
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
		"SELECT id, member_code, name, phone, password_hash, is_active, kyc_status, bank_status FROM members WHERE phone = $1",
		[phone],
	);
	return rows[0] ?? null;
}
