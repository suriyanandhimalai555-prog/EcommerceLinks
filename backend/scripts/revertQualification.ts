/**
 * One-time data repair for the 2026-07 qualification tightening.
 *
 * Revokes qualification from members who no longer meet the gate (>= 2 active
 * direct referrals AND >= 1 active grandchild under an active direct) and
 * claws back pair bonuses that the old one-child rule released:
 *
 *   1. members.is_qualified → FALSE, qualified_at → NULL
 *   2. every released pair_accrual: compensating ledger txn reversing the
 *      original release legs exactly (wallet and/or deferred_bonus back to
 *      bonus_expense), accrual → 'pending' with release_seq + 1 so a later
 *      legitimate re-qualification re-releases under a fresh idempotency key
 *   3. cutoff_earnings for the release-time cutoff decremented
 *   4. upline left/right_qualified counters decremented — only where the
 *      original MemberQualified fan-out increment is recorded as processed
 *   5. rank achievements (levels 1–3, pending) that fall below threshold are
 *      deleted; anything else rank-related aborts for manual review
 *   6. one admin_audit_log row per member, actor = management account
 *
 * Dry-run by default — runs everything and rolls back:
 *   npx tsx scripts/revertQualification.ts
 *   npx tsx scripts/revertQualification.ts --execute
 *   npx tsx scripts/revertQualification.ts --member 21 --member 22
 *
 * Run with the tightened evaluateQualification deployed, migration 032
 * applied, and ALL WORKERS PAUSED with the streams drained. Any guard failure
 * aborts the entire transaction — the run is all-or-nothing.
 */
import "dotenv/config";
import type pg from "pg";
import { QUALIFIED_THRESHOLDS } from "../src/domain/ranks.js";
import { pool, withTxn } from "../src/lib/db.js";
import { fromPaise, toPaise } from "../src/lib/money.js";
import { deterministicIncrementId } from "../src/workers/fanout.js";
import { type LedgerLeg, postLedgerTxn } from "../src/workers/ledger.js";

class DryRunRollback extends Error {}

export interface RevertSummary {
	reverted: {
		memberId: string;
		memberCode: string;
		clawedBackPaise: bigint;
		accruals: number;
		countersDecremented: number;
	}[];
	ranksRevoked: { memberId: string; rankLevel: number }[];
}

function fail(msg: string): never {
	throw new Error(`ABORT — ${msg}`);
}

async function revertOneMember(
	c: pg.PoolClient,
	m: { id: string; member_code: string; qualified_at: string },
	actorId: string,
	openCutoffId: string | null,
	touchedAncestors: Set<string>,
): Promise<RevertSummary["reverted"][number]> {
	await c.query(
		"UPDATE members SET is_qualified=FALSE, qualified_at=NULL WHERE id=$1",
		[m.id],
	);

	// ── Claw back released accruals, reversing the original legs exactly ──
	const { rows: released } = await c.query<{
		id: string;
		pair_id: string;
		amount: string;
		release_seq: number;
		released_at: string;
	}>(
		`SELECT id, pair_id, amount, release_seq, released_at
       FROM pair_accruals
      WHERE beneficiary_id=$1 AND status='released'
      ORDER BY id
      FOR UPDATE`,
		[m.id],
	);

	let clawedBack = 0n;
	for (const a of released) {
		const origKey =
			a.release_seq > 0
				? `pairbonus:${a.pair_id}:${m.id}:${a.release_seq}`
				: `pairbonus:${a.pair_id}:${m.id}`;
		const { rows: legs } = await c.query<{
			account_id: string;
			direction: "D" | "C";
			amount: string;
			kind: string;
		}>(
			`SELECT le.account_id, le.direction, le.amount, ac.kind
         FROM ledger_entries le
         JOIN ledger_txns lt ON lt.txn_id = le.txn_id
         JOIN accounts ac ON ac.id = le.account_id
        WHERE lt.idempotency_key=$1`,
			[origKey],
		);
		if (legs.length === 0)
			fail(
				`accrual ${a.id} (member ${m.member_code}) is 'released' but ledger txn '${origKey}' is missing`,
			);

		const reversed: LedgerLeg[] = legs.map((l) => ({
			accountId: BigInt(l.account_id),
			direction: l.direction === "C" ? "D" : "C",
			amountPaise: toPaise(l.amount),
		}));
		// wallet_balances CHECK (balance >= 0) is the hard guard; precheck for a
		// readable error instead of a bare 23514.
		for (const l of legs) {
			if (l.direction !== "C" || (l.kind !== "wallet" && l.kind !== "deferred_bonus"))
				continue;
			const { rows: b } = await c.query<{ balance: string }>(
				"SELECT balance FROM wallet_balances WHERE account_id=$1 FOR UPDATE",
				[l.account_id],
			);
			if (toPaise(b[0]?.balance ?? "0") < toPaise(l.amount))
				fail(
					`member ${m.member_code}: ${l.kind} balance ${b[0]?.balance ?? "0"} < clawback ${l.amount} — money already withdrawn/spent; resolve manually first`,
				);
		}

		const posted = await postLedgerTxn(
			c,
			`pairbonus-revert:${a.pair_id}:${m.id}:${a.release_seq}`,
			"pair_revert",
			BigInt(a.id),
			reversed,
		);
		if (!posted)
			fail(
				`revert txn for accrual ${a.id} (member ${m.member_code}) already exists — inconsistent prior run`,
			);

		// Undo the cap bookkeeping in the cutoff the release was counted against.
		const walletAmt = legs
			.filter((l) => l.direction === "C" && l.kind === "wallet")
			.reduce((s, l) => s + toPaise(l.amount), 0n);
		const defAmt = legs
			.filter((l) => l.direction === "C" && l.kind === "deferred_bonus")
			.reduce((s, l) => s + toPaise(l.amount), 0n);
		const { rows: co } = await c.query<{ id: string; status: string }>(
			`SELECT id, status FROM cutoffs
        WHERE window_start <= $1 AND $1 < window_end
        ORDER BY id DESC LIMIT 1`,
			[a.released_at],
		);
		if (co[0]) {
			if (co[0].status !== "open" || co[0].id !== openCutoffId)
				console.warn(
					`  ⚠ member ${m.member_code}: release for accrual ${a.id} was counted in cutoff ${co[0].id} (${co[0].status}) — earnings decremented there, review payout for that window`,
				);
			const dec = await c.query(
				`UPDATE cutoff_earnings
            SET earned = earned - $1, deferred = deferred - $2
          WHERE member_id=$3 AND cutoff_id=$4
            AND earned >= $1 AND deferred >= $2`,
				[fromPaise(walletAmt), fromPaise(defAmt), m.id, co[0].id],
			);
			if (dec.rowCount !== 1)
				fail(
					`member ${m.member_code}: cutoff_earnings for cutoff ${co[0].id} cannot absorb decrement (earned -₹${fromPaise(walletAmt)}, deferred -₹${fromPaise(defAmt)})`,
				);
		} else {
			console.warn(
				`  ⚠ member ${m.member_code}: no cutoff window covers released_at of accrual ${a.id} — cutoff_earnings left untouched`,
			);
		}

		await c.query(
			`UPDATE pair_accruals
          SET status='pending', released_at=NULL, release_seq = release_seq + 1
        WHERE id=$1`,
			[a.id],
		);
		clawedBack += toPaise(a.amount);
	}

	// ── Reverse the MemberQualified counter fan-out ──
	const { rows: ev } = await c.query<{ event_id: string }>(
		`SELECT event_id FROM events_outbox
      WHERE event_type='MemberQualified' AND aggregate_id=$1
      ORDER BY id DESC LIMIT 1`,
		[m.id],
	);
	if (!ev[0])
		fail(
			`member ${m.member_code} is qualified but has no MemberQualified outbox event — investigate before reverting`,
		);

	const { rows: pl } = await c.query<{
		placement_path: string[] | null;
		placement_sides: string[] | null;
	}>("SELECT placement_path, placement_sides FROM members WHERE id=$1", [m.id]);
	const path = pl[0].placement_path ?? [];
	const sides = pl[0].placement_sides ?? [];

	let countersDecremented = 0;
	for (let i = 0; i < path.length; i++) {
		const incId = deterministicIncrementId(ev[0].event_id, BigInt(path[i]));
		const { rows: done } = await c.query(
			`SELECT 1 FROM processed_events
        WHERE consumer_group='avg-counter-pair' AND event_id=$1`,
			[incId],
		);
		if (done.length === 0)
			fail(
				`member ${m.member_code}: qualified increment for ancestor ${path[i]} not yet processed — drain the increments stream (run workers to completion), then re-run`,
			);
		// The processed_events row stays: it still shields against XAUTOCLAIM
		// re-delivery of the original increment message.
		const col = sides[i] === "L" ? "left_qualified" : "right_qualified";
		const dec = await c.query(
			`UPDATE member_counters SET ${col} = ${col} - 1, updated_at=now()
        WHERE member_id=$1 AND ${col} > 0`,
			[path[i]],
		);
		if (dec.rowCount !== 1)
			fail(
				`member ${m.member_code}: ancestor ${path[i]} has no ${col} left to decrement — counters out of sync`,
			);
		countersDecremented++;
		touchedAncestors.add(path[i]);
	}

	await c.query(
		`INSERT INTO admin_audit_log (actor_id, action, target_type, target_id, before_state, after_state)
     VALUES ($1,'qualification_revert','member',$2,$3,$4)`,
		[
			actorId,
			m.id,
			JSON.stringify({
				isQualified: true,
				qualifiedAt: m.qualified_at,
				releasedAccruals: released.length,
			}),
			JSON.stringify({
				isQualified: false,
				clawedBackPaise: clawedBack.toString(),
				countersDecremented,
			}),
		],
	);

	return {
		memberId: m.id,
		memberCode: m.member_code,
		clawedBackPaise: clawedBack,
		accruals: released.length,
		countersDecremented,
	};
}

export async function revertQualifications(opts: {
	execute: boolean;
	memberIds?: bigint[];
}): Promise<RevertSummary> {
	const summary: RevertSummary = { reverted: [], ranksRevoked: [] };
	try {
		await withTxn(async (c) => {
			const { rows: mgmt } = await c.query<{ id: string }>(
				"SELECT id FROM members WHERE role='management' LIMIT 1",
			);
			if (!mgmt[0]) fail("no management account found for the audit trail");

			const { rows: openCo } = await c.query<{ id: string }>(
				"SELECT id FROM cutoffs WHERE status='open' LIMIT 1",
			);

			// The affected set is recomputed HERE, with the same structural predicate
			// the tightened evaluateQualification uses — never from a stale snapshot.
			const { rows: affected } = await c.query<{
				id: string;
				member_code: string;
				qualified_at: string;
			}>(
				`SELECT m.id, m.member_code, m.qualified_at
           FROM members m
          WHERE m.is_qualified
            AND ($1::bigint[] IS NULL OR m.id = ANY($1))
            AND NOT (
              (SELECT COUNT(*) FROM members r
                WHERE r.sponsor_id = m.id AND r.is_active) >= 2
              AND EXISTS (
                SELECT 1 FROM members r
                JOIN members g ON g.sponsor_id = r.id AND g.is_active
                WHERE r.sponsor_id = m.id AND r.is_active)
            )
          ORDER BY m.id
          FOR UPDATE OF m`,
				[opts.memberIds ? opts.memberIds.map(String) : null],
			);

			console.log(`${affected.length} member(s) fail the tightened gate`);
			const touchedAncestors = new Set<string>();
			for (const m of affected) {
				const r = await revertOneMember(
					c,
					m,
					mgmt[0].id,
					openCo[0]?.id ?? null,
					touchedAncestors,
				);
				console.log(
					`  ${r.memberCode}: unqualified, clawed back ₹${fromPaise(r.clawedBackPaise)} (${r.accruals} accrual(s)), ${r.countersDecremented} ancestor counter(s) decremented`,
				);
				summary.reverted.push(r);
			}

			// ── Rank achievements that no longer meet their thresholds ──
			// Scoped to members whose counters this run changed; pre-existing drift
			// elsewhere is the reconciler's problem, not this script's.
			const { rows: ranks } = await c.query<{
				id: string;
				member_id: string;
				member_code: string;
				rank_level: number;
				verification_status: string;
				left_qualified: string;
				right_qualified: string;
			}>(
				`SELECT ra.id, ra.member_id, mm.member_code, ra.rank_level,
                ra.verification_status, mc.left_qualified, mc.right_qualified
           FROM rank_achievements ra
           JOIN member_counters mc ON mc.member_id = ra.member_id
           JOIN members mm ON mm.id = ra.member_id
          WHERE ra.rank_level <= 4 AND ra.member_id = ANY($1::bigint[])
          ORDER BY ra.member_id, ra.rank_level`,
				[[...touchedAncestors]],
			);
			for (const ra of ranks) {
				const t = QUALIFIED_THRESHOLDS[ra.rank_level];
				const minSide = Math.min(
					parseInt(ra.left_qualified),
					parseInt(ra.right_qualified),
				);
				if (minSide >= t) continue;
				// Level 4 fans out rank_achiever increments and >pending states carry
				// delivered rewards — both need human decisions, not a script.
				if (ra.rank_level >= 4)
					fail(
						`${ra.member_code} rank ${ra.rank_level} falls below threshold — level-4 revocation (leg_rank_counters fan-out) must be handled manually`,
					);
				if (ra.verification_status !== "pending")
					fail(
						`${ra.member_code} rank ${ra.rank_level} (${ra.verification_status}) falls below threshold — reward already processed, resolve manually`,
					);
				const { rows: higher } = await c.query(
					"SELECT 1 FROM rank_achievements WHERE member_id=$1 AND rank_level > $2 LIMIT 1",
					[ra.member_id, ra.rank_level],
				);
				if (higher.length > 0)
					fail(
						`${ra.member_code} holds ranks above ${ra.rank_level} — cascade revocation must be handled manually`,
					);

				await c.query("DELETE FROM rank_achievements WHERE id=$1", [ra.id]);
				await c.query(
					`INSERT INTO admin_audit_log (actor_id, action, target_type, target_id, before_state, after_state)
           VALUES ($1,'rank_revoke','member',$2,$3,$4)`,
					[
						mgmt[0].id,
						ra.member_id,
						JSON.stringify({
							rankLevel: ra.rank_level,
							verificationStatus: ra.verification_status,
						}),
						JSON.stringify({
							leftQualified: parseInt(ra.left_qualified),
							rightQualified: parseInt(ra.right_qualified),
							threshold: t,
						}),
					],
				);
				console.log(
					`  ${ra.member_code}: rank ${ra.rank_level} revoked (${ra.left_qualified}/${ra.right_qualified} < ${t} per side)`,
				);
				summary.ranksRevoked.push({
					memberId: ra.member_id,
					rankLevel: ra.rank_level,
				});
			}

			if (!opts.execute) throw new DryRunRollback();
		});
	} catch (err) {
		if (!(err instanceof DryRunRollback)) throw err;
		console.log("\nDRY RUN — transaction rolled back, nothing changed. Re-run with --execute to apply.");
	}
	return summary;
}

const _argv1 = process.argv[1] ?? "";
if (
	_argv1.endsWith("revertQualification.ts") ||
	_argv1.endsWith("revertQualification.js")
) {
	const execute = process.argv.includes("--execute");
	const memberIds: bigint[] = [];
	for (let i = 2; i < process.argv.length; i++) {
		if (process.argv[i] === "--member" && process.argv[i + 1])
			memberIds.push(BigInt(process.argv[++i]));
	}
	let dbHost = "(unknown)";
	try {
		dbHost = new URL(process.env.DATABASE_URL ?? "").hostname;
	} catch {
		/* ignore */
	}
	console.log(
		`Qualification revert — ${execute ? "EXECUTE" : "dry run"} against ${dbHost}\n` +
			"Precondition: workers paused, streams drained.\n",
	);
	revertQualifications({
		execute,
		memberIds: memberIds.length > 0 ? memberIds : undefined,
	})
		.then(async (s) => {
			const total = s.reverted.reduce((a, r) => a + r.clawedBackPaise, 0n);
			console.log(
				`\nDone: ${s.reverted.length} member(s) reverted, ₹${fromPaise(total)} clawed back, ${s.ranksRevoked.length} rank(s) revoked.`,
			);
			await pool().end();
		})
		.catch(async (err) => {
			console.error(err.message ?? err);
			await pool().end();
			process.exit(1);
		});
}
