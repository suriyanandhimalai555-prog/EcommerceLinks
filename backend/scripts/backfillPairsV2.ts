/**
 * T6 — Backfill pairs + pair_accruals for income model v2 (carry-forward matching).
 *
 * Migrates existing DB state from v1 ("2 Direct Pair Matching", migration 020) to
 * v2 (carry-forward, migration 038):
 *
 *   v1: at most 1 pair per member (uq_pairs_one_per_member, now dropped); accruals
 *       fan out to owner + every placement ancestor; pairs_matched frozen at 0.
 *   v2: pairs_matched = LEAST(left_active, right_active); exactly 1 pair_accrual per
 *       pair (owner only, BR-7); pairs_matched is live.
 *
 * Per-member work (one DB transaction each — re-runnable: ON CONFLICT DO NOTHING):
 *   1. Verify leg_activations counts match stored counters (abort on mismatch).
 *   2. target = LEAST(left_active, right_active).
 *   3. Delete pending ancestor fan-out accruals (beneficiary != pair owner) for
 *      M's pairs — v1 created these, v2 never should.
 *   4. Delete pending accruals where M is a beneficiary of OTHER members' pairs.
 *   5. Insert pairs seq 1..target from leg_activations (ON CONFLICT DO NOTHING).
 *   6. Insert one pending pair_accrual per new pair (ON CONFLICT DO NOTHING).
 *   7. Set pairs_matched = target.
 *   8. Write PendingBonusReleaseRequested to outbox if M is qualified with pending accruals.
 *
 * BLOCKING precheck: any pair_accruals.release_seq > 0 → abort (revertQualification
 * was run and the per-pair idempotency keys are in a complex state that P-2's
 * monotonicity assumption does not cover).
 *
 * Production guard: refuses to run against hayabusa.proxy.rlwy.net unless --i-know is passed.
 *
 * Usage:
 *   npx tsx scripts/backfillPairsV2.ts              # dry-run: log what would change
 *   npx tsx scripts/backfillPairsV2.ts --execute    # apply (one txn per member)
 *   npx tsx scripts/backfillPairsV2.ts --i-know     # override prod-host guard
 *   npx tsx scripts/backfillPairsV2.ts --member 21  # scope to one member (repeatable)
 */
import "dotenv/config";
import { randomUUID } from "crypto";
import type pg from "pg";
import { pool, withTxn } from "../src/lib/db.js";
import { fromPaise, toPaise } from "../src/lib/money.js";
import { writeOutbox } from "../src/events/outbox.js";
import { CFG } from "../src/config.js";

const PROD_HOST = "hayabusa.proxy.rlwy.net";
const PAIR_BONUS_RUPEES = fromPaise(BigInt(CFG.PAIR_BONUS_PAISE)); // "1000.00"

// ── CLI args ─────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const EXECUTE = argv.includes("--execute");
const I_KNOW = argv.includes("--i-know");
const MEMBER_IDS: bigint[] = [];
for (let i = 0; i < argv.length; i++) {
	if (argv[i] === "--member" && argv[i + 1]) {
		MEMBER_IDS.push(BigInt(argv[++i]));
	}
}

// ── Summary accumulator ───────────────────────────────────────────────────────

export interface BackfillSummary {
	processed: number;
	skipped: number; // target=0, nothing to do
	pairsInserted: number;
	accrualsPurged: number;
	accrualsInserted: number;
	releaseEventsEmitted: number;
	warnings: string[];
}

// ── Guard helpers ─────────────────────────────────────────────────────────────

function fail(msg: string): never {
	throw new Error(`ABORT — ${msg}`);
}

// ── Per-member backfill (inside caller's transaction) ─────────────────────────

async function backfillOneMember(
	c: pg.PoolClient,
	memberId: bigint,
	memberCode: string,
	dryRun: boolean,
	summary: BackfillSummary,
): Promise<void> {
	// 1. Lock member_counters and read current state.
	const lockSql = dryRun
		? "SELECT left_active, right_active, pairs_matched FROM member_counters WHERE member_id=$1"
		: "SELECT left_active, right_active, pairs_matched FROM member_counters WHERE member_id=$1 FOR UPDATE";

	const { rows: cRows } = await c.query<{
		left_active: string;
		right_active: string;
		pairs_matched: string;
	}>(lockSql, [memberId]);

	if (!cRows[0]) {
		// Member has no counters row — not yet placed in the tree (management account etc.)
		summary.skipped++;
		return;
	}

	const storedLeft = BigInt(cRows[0].left_active);
	const storedRight = BigInt(cRows[0].right_active);
	const storedPairs = BigInt(cRows[0].pairs_matched);

	// 2. Recompute L/R from leg_activations — the durable ordered log.
	const { rows: legMax } = await c.query<{ side: string; max_seq: string }>(
		`SELECT side, MAX(seq) AS max_seq FROM leg_activations WHERE ancestor_id=$1 GROUP BY side`,
		[memberId],
	);
	const computedLeft =
		BigInt(legMax.find((r) => r.side === "L")?.max_seq ?? "0");
	const computedRight =
		BigInt(legMax.find((r) => r.side === "R")?.max_seq ?? "0");

	// Mismatch means the activation log and the hot counter diverged — we do not
	// know which is correct, so we stop here for human review.
	if (computedLeft !== storedLeft) {
		fail(
			`${memberCode}: left_active mismatch — stored ${storedLeft}, leg_activations says ${computedLeft}`,
		);
	}
	if (computedRight !== storedRight) {
		fail(
			`${memberCode}: right_active mismatch — stored ${storedRight}, leg_activations says ${computedRight}`,
		);
	}

	const target = computedLeft < computedRight ? computedLeft : computedRight;

	if (target === 0n) {
		summary.skipped++;
		return;
	}

	// 3. Find existing pairs M owns.
	const { rows: existingPairs } = await c.query<{ id: string }>(
		"SELECT id FROM pairs WHERE member_id=$1",
		[memberId],
	);
	const mPairIds = existingPairs.map((r) => r.id);

	// 4a. Detect + delete pending ancestor fan-out accruals for M's own pairs.
	//     These are v1 rows where beneficiary != pair owner. They must not exist in v2.
	let purgedCount = 0;
	if (mPairIds.length > 0) {
		const { rows: releasedAnc } = await c.query<{ cnt: string }>(
			`SELECT COUNT(*) AS cnt FROM pair_accruals
			  WHERE pair_id = ANY($1) AND beneficiary_id != $2 AND status='released'`,
			[mPairIds, memberId],
		);
		const releasedAncCount = parseInt(releasedAnc[0].cnt, 10);
		if (releasedAncCount > 0) {
			// Can't delete released ancestor accruals (D-7); warn and leave them.
			summary.warnings.push(
				`${memberCode}: ${releasedAncCount} released ancestor accrual(s) for M's pairs cannot be removed (D-7) — v1 fan-out money already paid`,
			);
		}

		if (!dryRun) {
			const del = await c.query(
				`DELETE FROM pair_accruals
				  WHERE pair_id = ANY($1) AND beneficiary_id != $2 AND status='pending'`,
				[mPairIds, memberId],
			);
			purgedCount += del.rowCount ?? 0;
		} else {
			const { rows: pendingAnc } = await c.query<{ cnt: string }>(
				`SELECT COUNT(*) AS cnt FROM pair_accruals
				  WHERE pair_id = ANY($1) AND beneficiary_id != $2 AND status='pending'`,
				[mPairIds, memberId],
			);
			purgedCount += parseInt(pendingAnc[0].cnt, 10);
		}
	}

	// 4b. Delete pending accruals where M is a beneficiary of OTHER members' pairs.
	//     Under v2 M should never receive accruals from other pairs (no fan-out).
	const { rows: releasedOther } = await c.query<{ cnt: string }>(
		`SELECT COUNT(*) AS cnt FROM pair_accruals
		  WHERE beneficiary_id=$1 AND status='released'
		    AND pair_id NOT IN (SELECT id FROM pairs WHERE member_id=$1)`,
		[memberId],
	);
	const releasedOtherCount = parseInt(releasedOther[0].cnt, 10);
	if (releasedOtherCount > 0) {
		summary.warnings.push(
			`${memberCode}: ${releasedOtherCount} released accrual(s) where M is ancestor-beneficiary of other pairs (D-7 — cannot remove)`,
		);
	}
	if (!dryRun) {
		const del2 = await c.query(
			`DELETE FROM pair_accruals
			  WHERE beneficiary_id=$1 AND status='pending'
			    AND pair_id NOT IN (SELECT id FROM pairs WHERE member_id=$1)`,
			[memberId],
		);
		purgedCount += del2.rowCount ?? 0;
	} else {
		const { rows: pendingOther } = await c.query<{ cnt: string }>(
			`SELECT COUNT(*) AS cnt FROM pair_accruals
			  WHERE beneficiary_id=$1 AND status='pending'
			    AND pair_id NOT IN (SELECT id FROM pairs WHERE member_id=$1)`,
			[memberId],
		);
		purgedCount += parseInt(pendingOther[0].cnt, 10);
	}

	summary.accrualsPurged += purgedCount;

	// 5. Fetch leg_activations for the entire seq range 1..target.
	const { rows: legRows } = await c.query<{
		side: string;
		seq: string;
		member_id: string;
	}>(
		`SELECT side, seq, member_id FROM leg_activations
		  WHERE ancestor_id=$1 AND seq >= 1 AND seq <= $2`,
		[memberId, target],
	);

	const bySide: Record<"L" | "R", Map<bigint, string>> = {
		L: new Map(),
		R: new Map(),
	};
	for (const r of legRows) {
		bySide[r.side as "L" | "R"].set(BigInt(r.seq), r.member_id);
	}

	// 6. Insert pairs seq 1..target and their accruals.
	let pairsInserted = 0;
	let accrualsInserted = 0;

	for (let k = 1n; k <= target; k++) {
		const leftMemberId = bySide.L.get(k);
		const rightMemberId = bySide.R.get(k);

		if (!leftMemberId || !rightMemberId) {
			fail(
				`${memberCode}: leg_activations gap at seq ${k} (L=${leftMemberId ?? "missing"} R=${rightMemberId ?? "missing"}) — cannot mint pair without both legs`,
			);
		}

		let pairId: bigint;

		if (!dryRun) {
			// Insert pair; ON CONFLICT (member_id, sequence_no) DO NOTHING → re-runnable.
			const { rows: ins } = await c.query<{ id: string }>(
				`INSERT INTO pairs (member_id, sequence_no, left_member_id, right_member_id, bonus_amount)
				 VALUES ($1,$2,$3,$4,$5)
				 ON CONFLICT (member_id, sequence_no) DO NOTHING
				 RETURNING id`,
				[memberId, k, leftMemberId, rightMemberId, PAIR_BONUS_RUPEES],
			);

			if (ins[0]) {
				pairId = BigInt(ins[0].id);
				pairsInserted++;
			} else {
				// Already exists — get its id for the accrual step.
				const { rows: ex } = await c.query<{ id: string }>(
					"SELECT id FROM pairs WHERE member_id=$1 AND sequence_no=$2",
					[memberId, k],
				);
				if (!ex[0]) fail(`${memberCode}: pair seq=${k} vanished after ON CONFLICT`);
				pairId = BigInt(ex[0].id);
			}

			// Insert pending accrual (owner only — BR-7); ON CONFLICT → re-runnable.
			const { rows: aIns } = await c.query<{ id: string }>(
				`INSERT INTO pair_accruals (pair_id, beneficiary_id, amount, status)
				 VALUES ($1,$2,$3,'pending')
				 ON CONFLICT (pair_id, beneficiary_id) DO NOTHING
				 RETURNING id`,
				[pairId, memberId, PAIR_BONUS_RUPEES],
			);
			if (aIns[0]) accrualsInserted++;
		} else {
			// Dry-run: count what would be inserted.
			const { rows: existsPair } = await c.query<{ id: string }>(
				"SELECT id FROM pairs WHERE member_id=$1 AND sequence_no=$2",
				[memberId, k],
			);
			if (!existsPair[0]) pairsInserted++;
		}
	}

	// 7. Set pairs_matched = target.
	if (!dryRun) {
		await c.query(
			"UPDATE member_counters SET pairs_matched=$1, updated_at=now() WHERE member_id=$2",
			[target, memberId],
		);
	}

	// 8. Emit PendingBonusReleaseRequested if qualified + has pending accruals.
	const { rows: qual } = await c.query<{ is_qualified: boolean }>(
		"SELECT is_qualified FROM members WHERE id=$1",
		[memberId],
	);
	const { rows: pendingCount } = await c.query<{ cnt: string }>(
		"SELECT COUNT(*) AS cnt FROM pair_accruals WHERE beneficiary_id=$1 AND status='pending'",
		[memberId],
	);
	const hasPending = parseInt(pendingCount[0].cnt, 10) > 0;

	if (qual[0]?.is_qualified && hasPending) {
		if (!dryRun) {
			await writeOutbox(c, {
				event_id: randomUUID(),
				event_type: "PendingBonusReleaseRequested",
				occurred_at: new Date().toISOString(),
				schema_version: 1,
				member_id: Number(memberId),
			});
		}
		summary.releaseEventsEmitted++;
	}

	summary.pairsInserted += pairsInserted;
	summary.accrualsInserted += accrualsInserted;
	summary.processed++;

	console.log(
		`  ${dryRun ? "[DRY]" : "     "} ${memberCode} (${memberId}): ` +
			`target=${target}, stored_pairs=${storedPairs}, ` +
			`pairs_to_create=${pairsInserted}, accruals_purged=${purgedCount}, ` +
			`accruals_to_create=${dryRun ? target - BigInt(existingPairs.length) : accrualsInserted}` +
			(qual[0]?.is_qualified && hasPending ? ", release_requested=yes" : ""),
	);
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function backfillPairsV2(opts: {
	execute: boolean;
	memberIds?: bigint[];
}): Promise<BackfillSummary> {
	const summary: BackfillSummary = {
		processed: 0,
		skipped: 0,
		pairsInserted: 0,
		accrualsPurged: 0,
		accrualsInserted: 0,
		releaseEventsEmitted: 0,
		warnings: [],
	};

	// Global check 1: release_seq > 0 blocks the backfill (P-2 monotonicity).
	// revertQualification bumps release_seq, which puts pair-idempotency keys in a
	// state where the backfill's clean-rebuild of pair_accruals would create
	// duplicates or leave stale ledger_txn entries.
	const { rows: rSeqRows } = await pool().query<{ cnt: string }>(
		"SELECT COUNT(*) AS cnt FROM pair_accruals WHERE release_seq > 0",
	);
	const rSeqCount = parseInt(rSeqRows[0].cnt, 10);
	if (rSeqCount > 0) {
		fail(
			`${rSeqCount} pair_accruals row(s) have release_seq > 0 (revertQualification was run). ` +
				"Resolve the qualification revert manually before backfilling. " +
				"See plan T6 §4 caveat.",
		);
	}

	// Fetch the members to process.
	const { rows: members } = await pool().query<{
		id: string;
		member_code: string;
	}>(
		`SELECT m.id, m.member_code
		   FROM members m
		   JOIN member_counters mc ON mc.member_id = m.id
		  WHERE ($1::bigint[] IS NULL OR m.id = ANY($1))
		  ORDER BY m.id`,
		[opts.memberIds ? opts.memberIds.map(String) : null],
	);

	console.log(`\n${members.length} member(s) to process.\n`);

	for (const row of members) {
		const memberId = BigInt(row.id);

		if (opts.execute) {
			// One transaction per member — re-runnable: if interrupted, already-processed
			// members stay committed; re-running starts from the first uncommitted member.
			await withTxn(async (c) => {
				await backfillOneMember(c, memberId, row.member_code, false, summary);
			});
		} else {
			// Dry-run: use a read-only client from the pool (no txn, no writes).
			const client = await pool().connect();
			try {
				await backfillOneMember(client, memberId, row.member_code, true, summary);
			} finally {
				client.release();
			}
		}
	}

	return summary;
}

// ── Script entry point ────────────────────────────────────────────────────────

const _argv1 = process.argv[1] ?? "";
if (
	_argv1.endsWith("backfillPairsV2.ts") ||
	_argv1.endsWith("backfillPairsV2.js")
) {
	let dbHost = "(unknown)";
	try {
		dbHost = new URL(process.env.DATABASE_URL ?? "").hostname;
	} catch {
		/* ignore */
	}

	if (dbHost === PROD_HOST && !I_KNOW) {
		console.error(
			`\nRefusing to run against production host ${PROD_HOST}.\n` +
				"Pass --i-know if you have taken a backup and understand the D-7 implications.\n",
		);
		process.exit(1);
	}

	console.log(
		`Backfill pairs v2 — ${EXECUTE ? "EXECUTE" : "DRY RUN"} against ${dbHost}\n` +
			"Preconditions: workers paused, streams drained, migration 038 applied.\n" +
			(MEMBER_IDS.length > 0
				? `Scoped to members: ${MEMBER_IDS.join(", ")}\n`
				: ""),
	);

	backfillPairsV2({
		execute: EXECUTE,
		memberIds: MEMBER_IDS.length > 0 ? MEMBER_IDS : undefined,
	})
		.then(async (s) => {
			console.log("\n──────────────────────────────────────────");
			console.log(
				`Done: ${s.processed} processed, ${s.skipped} skipped (target=0), ` +
					`${s.pairsInserted} pairs created, ${s.accrualsPurged} accruals purged, ` +
					`${s.accrualsInserted} accruals created, ${s.releaseEventsEmitted} release event(s) queued.`,
			);
			if (s.warnings.length > 0) {
				console.warn("\nWarnings (D-7 — released money not touched):");
				for (const w of s.warnings) console.warn(`  ⚠ ${w}`);
			}
			if (!EXECUTE) {
				console.log(
					"\nDRY RUN — no changes applied. Re-run with --execute to apply.",
				);
			}
			await pool().end();
		})
		.catch(async (err) => {
			console.error(`\n${err.message ?? err}`);
			await pool().end();
			process.exit(1);
		});
}
