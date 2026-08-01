/**
 * reconstructWeeklyPayouts.ts — replay the weekly payout sweep for every
 * historical closed cutoff, producing one `pending` withdrawal row per member
 * per week that their cumulative withdrawable balance crossed the ₹500 minimum.
 *
 * Background:
 *   The pipeline's weekly sweep (cutoff.ts → ledger.ts sweepToWithdrawable)
 *   auto-creates one `pending` withdrawal row per member per cutoff close.
 *   After a reseed, all earnings were crammed into the single open cutoff
 *   rather than spread week-by-week.  This script replays what each week's
 *   sweep WOULD have produced, restoring the per-week pending history that
 *   management approves and members see.
 *
 * Method:
 *   Phase 1 — Wipe prior auto-generated pending rows (source_cutoff_id IS NOT NULL)
 *             and reverse their ledger moves so all money returns to wallet.
 *   Phase 2 — Ensure every historical week has a `closed` cutoff row in the DB
 *             (INSERT … ON CONFLICT DO NOTHING, chained from the open cutoff).
 *   Phase 3 — Replay the sweep per closed cutoff, in chronological order:
 *             for each member with released pair bonuses in that week, post
 *             wallet → withdrawable (wsweep: key), then if cumulative withdrawable
 *             ≥ ₹500 create a pending withdrawal + hold (autowd: key).  Sub-₹500
 *             balances carry forward to the next week — naturally, via the
 *             persistent withdrawable balance.
 *   Phase 4 — Conservation self-check: Σ(pending rows) + Σ(remaining withdrawable)
 *             + Σ(current wallet) == wallet total recorded after Phase 1 wipe.
 *
 * Week attribution: earnings land in the week of
 *   GREATEST(left_member.activated_at, right_member.activated_at, earner.qualified_at)
 *   — matches the real ledger (see also reconstructWeekly.ts).
 *
 * Safety:
 *   • Dry-run by default — prints full plan, writes nothing.  Pass --execute to write.
 *   • Pass --i-know when PROD_DATABASE_URL contains 'hayabusa' (production host).
 *   • Snapshot-race guard: re-reads released-accrual count immediately before
 *     writes; aborts if workers are still active.
 *   • Idempotent re-run: the same wsweep:/autowd: idempotency keys + the partial
 *     unique index uq_withdrawal_source_cutoff make Phase 3 fully re-runnable.
 *
 * Prerequisites (production checklist):
 *   1. pg_dump backup of the production DB.
 *   2. Stop avg-workers (so no new events publish between checks and writes).
 *   3. Run `npm run report:weekly` (dry-read) against production — confirm 0 orphans
 *      and that all cutoff anchors are consistent with the current open cutoff.
 *      If orphans appear, manually INSERT a closed cutoff covering the gap first.
 *   4. Run `npm run redate:earnings -- --execute` first (if needed) to ensure
 *      wallet balances reflect the correct weekly-capped totals.
 *   5. Dry-run this script (`--i-know`, no `--execute`) and review the plan.
 *   6. Execute (`--i-know --execute`).
 *
 * Usage:
 *   # dev-copy dry-run:
 *   PROD_DATABASE_URL="$DATABASE_URL" npx tsx scripts/reconstructWeeklyPayouts.ts
 *   # dev-copy execute:
 *   PROD_DATABASE_URL="$DATABASE_URL" npx tsx scripts/reconstructWeeklyPayouts.ts --execute
 *   # production dry-run (take backup + stop workers first):
 *   PROD_DATABASE_URL='postgresql://...@hayabusa...' npx tsx scripts/reconstructWeeklyPayouts.ts --i-know
 *   # production execute:
 *   PROD_DATABASE_URL='postgresql://...@hayabusa...' npx tsx scripts/reconstructWeeklyPayouts.ts --i-know --execute
 *   # or via npm:
 *   PROD_DATABASE_URL='...' npm run reconstruct:payouts [-- --i-know] [-- --execute]
 */

import { fileURLToPath } from "url";
import pg from "pg";
import { v5 as uuidv5 } from "uuid";

// ── constants (mirrors src/config.ts — no env-import to keep script side-effect-free) ──
const PAIR_BONUS_PAISE = 100_000n;    // ₹1,000 per pair
const CUTOFF_CAP_PAISE = 10_000_000n; // ₹1,00,000 per member per week
const MIN_PAYOUT_PAISE = 50_000n;     // ₹500 minimum payout threshold

// ── id helper (must match UUID_NAMESPACE in lib/ids.ts exactly) ──────────────
const UUID_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
function txnUuid(key: string): string {
	return uuidv5(key, UUID_NAMESPACE);
}

// ── money helpers (mirrors lib/money.ts — no float arithmetic on money) ──────
function fromPaise(p: bigint): string {
	return (Number(p) / 100).toFixed(2);
}
function toPaise(s: string | number): bigint {
	return BigInt(Math.round(Number(s) * 100));
}
function toRupees(p: bigint): string {
	return `₹${(Number(p) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;
}

// ── inline postLedgerTxn ──────────────────────────────────────────────────────
// Mirrors workers/ledger.ts:25–82 and scripts/redateEarnings.ts:98–162 exactly.
// Kept inline so this script has zero side-effects from importing worker modules.
interface LedgerLeg {
	accountId: bigint;
	direction: "D" | "C";
	amountPaise: bigint;
}

async function postLedgerTxn(
	c: pg.PoolClient,
	idempotencyKey: string,
	referenceType: string,
	referenceId: bigint | null,
	legs: LedgerLeg[],
): Promise<boolean> {
	const txnId = txnUuid(idempotencyKey);

	const { rows: existing } = await c.query(
		"SELECT 1 FROM ledger_txns WHERE idempotency_key=$1",
		[idempotencyKey],
	);
	if (existing.length > 0) return false;

	const debitTotal = legs
		.filter((l) => l.direction === "D")
		.reduce((s, l) => s + l.amountPaise, 0n);
	const creditTotal = legs
		.filter((l) => l.direction === "C")
		.reduce((s, l) => s + l.amountPaise, 0n);
	if (debitTotal !== creditTotal || debitTotal === 0n) {
		throw new Error(
			`Ledger imbalance: D=${debitTotal} C=${creditTotal} key=${idempotencyKey}`,
		);
	}

	await c.query(
		`INSERT INTO ledger_txns (txn_id, idempotency_key, reference_type, reference_id)
     VALUES ($1,$2,$3,$4)`,
		[txnId, idempotencyKey, referenceType, referenceId],
	);
	for (const leg of legs) {
		await c.query(
			`INSERT INTO ledger_entries (txn_id, account_id, direction, amount) VALUES ($1,$2,$3,$4)`,
			[txnId, leg.accountId, leg.direction, fromPaise(leg.amountPaise)],
		);
		const { rows: acRows } = await c.query<{ kind: string }>(
			"SELECT kind FROM accounts WHERE id=$1",
			[leg.accountId],
		);
		const kind = acRows[0]?.kind;
		if (kind === "wallet" || kind === "deferred_bonus" || kind === "withdrawable") {
			const signed =
				leg.direction === "C"
					? fromPaise(leg.amountPaise)
					: "-" + fromPaise(leg.amountPaise);
			await c.query(
				`UPDATE wallet_balances SET balance = balance + $1::numeric, updated_at = now()
         WHERE account_id = $2`,
				[signed, leg.accountId],
			);
		}
	}
	return true;
}

// ── pure carry-forward simulation (exported for tests) ───────────────────────
export interface WeeklyEarning {
	cutoffId: bigint;
	netEarnedPaise: bigint; // already capped at ₹1L per week
}

export interface PlannedPayout {
	cutoffId: bigint;
	amountPaise: bigint; // = full withdrawable balance at the time of the payout
}

/**
 * Simulates the accumulation/payout logic across weeks without touching the DB.
 * For each week's net earnings, adds to the running withdrawable balance.
 * If the balance reaches minPayoutPaise, a payout is triggered for the full
 * balance, resetting it to zero.  Unspent balance carries to the next week.
 */
export function planWeeklyPayouts(
	weeks: WeeklyEarning[],
	minPayoutPaise: bigint,
	initialWithdrawable: bigint = 0n,
): { payouts: PlannedPayout[]; finalWithdrawable: bigint } {
	let withdrawable = initialWithdrawable;
	const payouts: PlannedPayout[] = [];
	for (const week of weeks) {
		withdrawable += week.netEarnedPaise;
		if (withdrawable >= minPayoutPaise) {
			payouts.push({ cutoffId: week.cutoffId, amountPaise: withdrawable });
			withdrawable = 0n;
		}
	}
	return { payouts, finalWithdrawable: withdrawable };
}

// ── arg parsing ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const I_KNOW = args.includes("--i-know");

// ── main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
	const url = process.env.PROD_DATABASE_URL;
	if (!url) {
		console.error(
			"[reconstructWeeklyPayouts] PROD_DATABASE_URL is required.\n" +
				"  Dev copy:   PROD_DATABASE_URL=\"$DATABASE_URL\" npx tsx scripts/reconstructWeeklyPayouts.ts\n" +
				"  Production: PROD_DATABASE_URL='postgresql://...' npx tsx scripts/reconstructWeeklyPayouts.ts --i-know",
		);
		process.exit(1);
	}

	const isProd = url.includes("hayabusa");
	if (isProd && !I_KNOW) {
		console.error(
			"[reconstructWeeklyPayouts] PROD_DATABASE_URL points at production (hayabusa).\n" +
				"  Take a Railway pg_dump backup, stop avg-workers, then pass --i-know.",
		);
		process.exit(1);
	}

	const pool = new pg.Pool({ connectionString: url, max: 5 });

	try {
		// ── Phase 0: Preconditions ──────────────────────────────────────────────
		const { rows: preRows } = await pool.query<{
			auto_paid_count: string;
			released_accruals: string;
			open_cutoff_exists: string;
		}>(`
      SELECT
        (SELECT COUNT(*) FROM withdrawals
          WHERE source_cutoff_id IS NOT NULL
            AND status IN ('approved','paid'))::text  AS auto_paid_count,
        (SELECT COUNT(*) FROM pair_accruals WHERE status='released')::text
                                                      AS released_accruals,
        (SELECT COUNT(*) FROM cutoffs WHERE status='open')::text
                                                      AS open_cutoff_exists
    `);
		const pre = preRows[0];
		const releasedSnapshot = BigInt(pre.released_accruals);

		if (BigInt(pre.auto_paid_count) > 0n) {
			console.error(
				`[reconstructWeeklyPayouts] ABORT: ${pre.auto_paid_count} auto-generated withdrawal(s) have already been approved/paid.\n` +
					"  Wiping them would destroy settled payment records.  Handle manually.",
			);
			process.exit(1);
		}
		if (BigInt(pre.open_cutoff_exists) === 0n) {
			console.error(
				"[reconstructWeeklyPayouts] ABORT: no open cutoff found.\n" +
					"  Run `npm run seed` (or `npm run dev:workers`) to create one.",
			);
			process.exit(1);
		}
		if (releasedSnapshot === 0n) {
			console.error(
				"[reconstructWeeklyPayouts] ABORT: no released pair accruals found.\n" +
					"  Nothing to reconstruct.  Activate members and let workers run first.",
			);
			process.exit(1);
		}
		console.log(`[reconstructWeeklyPayouts] ✓ Preconditions passed.`);
		console.log(`  Released accruals : ${releasedSnapshot}`);
		console.log(`  Mode              : ${EXECUTE ? (isProd ? "EXECUTE on PRODUCTION" : "EXECUTE on dev copy") : "DRY-RUN"}\n`);

		// ── Load all released accruals bucketed by cutoff (read-only) ───────────
		// release_at = GREATEST(left_activated, right_activated, earner_qualified)
		// matches reconstructWeekly.ts and the real ledger.ts logic exactly.
		const { rows: accrualRows } = await pool.query<{
			cutoff_id: string;
			window_start: Date;
			window_end: Date;
			status: string;
			member_id: string;
			member_code: string;
			gross_paise: string;
		}>(`
      WITH rel AS (
        SELECT p.member_id             AS beneficiary_id,
               GREATEST(
                 GREATEST(lm.activated_at, rm.activated_at),
                 b.qualified_at
               )                       AS release_at
          FROM pair_accruals pa
          JOIN pairs   p  ON p.id  = pa.pair_id
          JOIN members lm ON lm.id  = p.left_member_id
          JOIN members rm ON rm.id  = p.right_member_id
          JOIN members b  ON b.id   = p.member_id
         WHERE pa.status = 'released'
      )
      SELECT c.id::text                                   AS cutoff_id,
             c.window_start,
             c.window_end,
             c.status,
             r.beneficiary_id::text                      AS member_id,
             m.member_code,
             (COUNT(*) * ${PAIR_BONUS_PAISE})::bigint::text AS gross_paise
        FROM rel r
        JOIN cutoffs c
          ON r.release_at >= c.window_start
         AND r.release_at <  c.window_end
        JOIN members m ON m.id = r.beneficiary_id
       GROUP BY c.id, c.window_start, c.window_end, c.status, r.beneficiary_id, m.member_code
       ORDER BY c.window_start, r.beneficiary_id::bigint
    `);

		// Apply per-member per-week cap; exclude open cutoff (stays in wallet until close)
		type EarnerRow = {
			cutoffId: bigint;
			windowStart: Date;
			windowEnd: Date;
			cutoffStatus: string;
			memberId: bigint;
			memberCode: string;
			netPaise: bigint;
		};
		const earnerRows: EarnerRow[] = accrualRows
			.filter((r) => r.status === "closed") // open-cutoff earnings stay in wallet
			.map((r) => {
				const gross = BigInt(r.gross_paise);
				const net = gross < CUTOFF_CAP_PAISE ? gross : CUTOFF_CAP_PAISE;
				return {
					cutoffId: BigInt(r.cutoff_id),
					windowStart: r.window_start,
					windowEnd: r.window_end,
					cutoffStatus: r.status,
					memberId: BigInt(r.member_id),
					memberCode: r.member_code,
					netPaise: net,
				};
			});

		// Find range of historical weeks needed
		const { rows: rangeRows } = await pool.query<{
			earliest: Date;
			open_start: Date;
		}>(`
      SELECT
        (SELECT GREATEST(GREATEST(lm.activated_at, rm.activated_at), b.qualified_at)
           FROM pair_accruals pa
           JOIN pairs   p  ON p.id  = pa.pair_id
           JOIN members lm ON lm.id = p.left_member_id
           JOIN members rm ON rm.id = p.right_member_id
           JOIN members b  ON b.id  = p.member_id
          WHERE pa.status = 'released'
          ORDER BY 1 ASC LIMIT 1)          AS earliest,
        (SELECT window_start FROM cutoffs WHERE status='open' LIMIT 1) AS open_start
    `);
		const earliestRelease = rangeRows[0].earliest;
		const openStart = rangeRows[0].open_start;

		// Determine which closed cutoffs need to be created (chained backwards)
		type NewCutoff = { windowStart: Date; windowEnd: Date; payoutDate: Date };
		const cutoffsToCreate: NewCutoff[] = [];
		if (earliestRelease) {
			// Chain backwards in 7-day steps from the open cutoff's window_start
			let cursor = new Date(openStart);
			cursor = new Date(cursor.getTime() - 1000); // window_end of prior week = open_start - 1s
			while (cursor >= earliestRelease) {
				const wEnd = new Date(cursor);
				const wStart = new Date(cursor.getTime() - 7 * 24 * 60 * 60 * 1000 + 1000);
				const pDate = new Date(wEnd.getTime() + 7 * 24 * 60 * 60 * 1000);
				cutoffsToCreate.unshift({ windowStart: wStart, windowEnd: wEnd, payoutDate: pDate });
				cursor = new Date(wStart.getTime() - 1000); // prev week's end
			}
		}

		// ── Phase 0.5: Pre-mutation validation ─────────────────────────────────────
		// Validate the *planned* combined cutoff set (existing closed + cutoffsToCreate)
		// BEFORE any mutations.  A Phase 1 wipe on production that later fails at Phase 2
		// requires restoring from pg_dump — better to catch the problem here.
		//
		// Two invariants:
		//   (1) No two windows overlap  → a release can't be credited twice.
		//   (2) No orphan releases      → every released accrual maps into a window.
		//       An orphaned release is silently dropped from payout history;
		//       conservation (Phase 4) would still pass because the money stays in
		//       wallet — so only this pre-flight check catches it.
		{
			// Load existing closed cutoff windows (may be empty on a fresh DB)
			const { rows: ecRows } = await pool.query<{
				window_start: Date;
				window_end: Date;
			}>(`SELECT window_start, window_end FROM cutoffs WHERE status='closed' ORDER BY window_start`);

			// Merge existing + planned (deduplicate by window_start to avoid double-counting)
			// Also include the open cutoff so earnings released in the current (not-yet-closed)
			// window aren't flagged as orphans — the script filters them to status='closed' on
			// read, so they won't be processed, but they are legitimately accounted for.
			type CutoffWindow = { windowStart: Date; windowEnd: Date };
			const existingStarts = new Set(ecRows.map(r => r.window_start.getTime()));
			const combined: CutoffWindow[] = [
				...ecRows.map(r => ({ windowStart: r.window_start, windowEnd: r.window_end })),
				...cutoffsToCreate.filter(c => !existingStarts.has(c.windowStart.getTime())),
			].sort((a, b) => a.windowStart.getTime() - b.windowStart.getTime());

			// Append the open cutoff window (earnings there are skipped by the script, not lost)
			const { rows: openWinRows } = await pool.query<{ window_start: Date; window_end: Date }>(
				`SELECT window_start, window_end FROM cutoffs WHERE status='open' LIMIT 1`,
			);
			if (openWinRows[0]) {
				combined.push({ windowStart: openWinRows[0].window_start, windowEnd: openWinRows[0].window_end });
				// keep sorted (open window is always last)
				combined.sort((a, b) => a.windowStart.getTime() - b.windowStart.getTime());
			}

			// (1) Overlap check: adjacent windows must not overlap
			let preflight_abort = false;
			for (let i = 1; i < combined.length; i++) {
				const prev = combined[i - 1];
				const curr = combined[i];
				if (curr.windowStart < prev.windowEnd) {
					console.error(
						`\n[Phase 0] ABORT: planned cutoff windows overlap.\n` +
						`  Window ${i - 1}: ${prev.windowStart.toISOString()} → ${prev.windowEnd.toISOString()}\n` +
						`  Window ${i}  : ${curr.windowStart.toISOString()} → ${curr.windowEnd.toISOString()}\n` +
						"  Manually resolve conflicting rows in the cutoffs table before re-running.\n" +
						"  Tip: delete the stale closed cutoffs (check for an anchor change between deploys).",
					);
					preflight_abort = true;
					break;
				}
			}

			// (2) Orphan check: every distinct release_at must land in exactly one window.
			//     Use DISTINCT because multiple accruals can share the same release timestamp;
			//     the overlap/orphan status is per-timestamp, not per-accrual.
			const { rows: releaseAtRows } = await pool.query<{ release_at: Date }>(`
        SELECT DISTINCT
               GREATEST(GREATEST(lm.activated_at, rm.activated_at), b.qualified_at) AS release_at
          FROM pair_accruals pa
          JOIN pairs   p  ON p.id  = pa.pair_id
          JOIN members lm ON lm.id  = p.left_member_id
          JOIN members rm ON rm.id  = p.right_member_id
          JOIN members b  ON b.id   = p.member_id
         WHERE pa.status = 'released'
      `);

			let preOrphanCount = 0;
			const orphanExamples: string[] = [];
			for (const { release_at } of releaseAtRows) {
				const t = release_at.getTime();
				const inWindow = combined.some(
					w => t >= w.windowStart.getTime() && t < w.windowEnd.getTime(),
				);
				if (!inWindow) {
					preOrphanCount++;
					if (orphanExamples.length < 3)
						orphanExamples.push(release_at.toISOString());
				}
			}
			if (preOrphanCount > 0) {
				console.error(
					`\n[Phase 0] ABORT: ${preOrphanCount} distinct release timestamp(s) fall outside all ` +
					`closed cutoff windows (including planned ones).\n` +
					`  Examples: ${orphanExamples.join(", ")}\n` +
					"  These earnings would be PERMANENTLY LOST from payout history.\n" +
					"  Likely cause: the open cutoff anchor shifted, leaving a gap between\n" +
					"  the last historical window and the current open window.\n" +
					"  Fix: run `npm run report:weekly` to identify the gap, manually\n" +
					"  INSERT a closed cutoff covering it, then re-run this script.",
				);
				preflight_abort = true;
			}

			if (preflight_abort) process.exit(1);

			console.log(
				`[Phase 0] ✓ Pre-mutation validation passed — ` +
				`${combined.length} windows, ${releaseAtRows.length} distinct release timestamp(s), ` +
				`0 overlaps, 0 orphans.\n`,
			);
		}

		// ── Phase 1: print wipe plan (and execute if --execute) ─────────────────
		const { rows: existingPending } = await pool.query<{
			count: string;
			total: string;
		}>(`
      SELECT COUNT(*)::text AS count, COALESCE(SUM(amount),0)::text AS total
      FROM withdrawals WHERE source_cutoff_id IS NOT NULL AND status='pending'
    `);
		const pendingCount = BigInt(existingPending[0].count);
		const pendingTotal = toPaise(existingPending[0].total);

		const { rows: autoTxnRows } = await pool.query<{
			txn_id: string;
			idempotency_key: string;
			account_id: string;
			direction: string;
			amount: string;
			kind: string;
			owner_id: string;
		}>(`
      SELECT t.txn_id, t.idempotency_key,
             e.account_id::text, e.direction, e.amount::text,
             a.kind, a.owner_id::text
        FROM ledger_txns t
        JOIN ledger_entries e ON e.txn_id = t.txn_id
        JOIN accounts a ON a.id = e.account_id
       WHERE t.idempotency_key LIKE 'autowd:%' OR t.idempotency_key LIKE 'wsweep:%'
       ORDER BY t.idempotency_key, e.direction
    `);

		// Compute per-member balance deltas for the wipe
		type MemberWipe = {
			memberId: bigint;
			txnIds: Set<string>;
			walletDelta: bigint;
			withdrawableDelta: bigint;
			walletAccId: bigint | null;
			withdrawableAccId: bigint | null;
		};
		const wipeByMember = new Map<bigint, MemberWipe>();

		for (const row of autoTxnRows) {
			// Parse member id from key: "autowd:<cutoffId>:<memberId>" or "wsweep:<cutoffId>:<memberId>"
			const parts = row.idempotency_key.split(":");
			const memberId = BigInt(parts[2]);

			let mw = wipeByMember.get(memberId);
			if (!mw) {
				mw = {
					memberId,
					txnIds: new Set(),
					walletDelta: 0n,
					withdrawableDelta: 0n,
					walletAccId: null,
					withdrawableAccId: null,
				};
				wipeByMember.set(memberId, mw);
			}
			mw.txnIds.add(row.txn_id);

			const amt = toPaise(row.amount);
			const isAutowd = row.idempotency_key.startsWith("autowd:");
			const isWsweep = row.idempotency_key.startsWith("wsweep:");

			if (row.kind === "wallet" && isWsweep && row.direction === "D") {
				// wsweep D-wallet: reverse → wallet += amount
				mw.walletDelta += amt;
				mw.walletAccId = BigInt(row.account_id);
			} else if (row.kind === "withdrawable" && isWsweep && row.direction === "C") {
				// wsweep C-withdrawable: reverse → withdrawable -= amount
				mw.withdrawableDelta -= amt;
				mw.withdrawableAccId = BigInt(row.account_id);
			} else if (row.kind === "withdrawable" && isAutowd && row.direction === "D") {
				// autowd D-withdrawable: reverse → withdrawable += amount
				mw.withdrawableDelta += amt;
				mw.withdrawableAccId = BigInt(row.account_id);
			}
			// autowd C-payout_clearing: system account, no wallet_balances row — skip
		}

		const totalWipeDelta = [...wipeByMember.values()].reduce(
			(s, m) => s + m.walletDelta,
			0n,
		);

		const line = "═".repeat(70);
		console.log(line);
		console.log(`  reconstructWeeklyPayouts — ${EXECUTE ? (isProd ? "EXECUTE on PRODUCTION ⚠️" : "EXECUTE on dev copy") : "DRY-RUN"}`);
		console.log(line);

		console.log(`\nPhase 1 — Wipe ${pendingCount} auto-pending withdrawal(s) (${toRupees(pendingTotal)})`);
		console.log(`  Ledger txns to delete : ${autoTxnRows.length > 0 ? [...new Set(autoTxnRows.map(r => r.txn_id))].length : 0} txn(s)`);
		console.log(`  Wallet restored by    : ${toRupees(totalWipeDelta)} (returned from withdrawable/payout_clearing)`);

		// Phase 2 — cutoffs to create
		const existingCutoffCount = accrualRows.length > 0
			? new Set(accrualRows.map(r => r.cutoff_id)).size
			: 0;
		console.log(
			`\nPhase 2 — Ensure historical cutoffs (${cutoffsToCreate.length} to create, ${existingCutoffCount} already exist with released earnings)`,
		);
		for (const c of cutoffsToCreate) {
			console.log(
				`  ${c.windowStart.toISOString().slice(0, 10)} → ${c.windowEnd.toISOString().slice(0, 10)}  [closed, to create]`,
			);
		}

		// Phase 3 — dry-run simulation using planWeeklyPayouts
		// Group per-member weekly earnings for simulation
		type MemberWeeks = Map<bigint, WeeklyEarning[]>;
		const memberWeeks: MemberWeeks = new Map();
		for (const r of earnerRows) {
			let weeks = memberWeeks.get(r.memberId);
			if (!weeks) { weeks = []; memberWeeks.set(r.memberId, weeks); }
			weeks.push({ cutoffId: r.cutoffId, netEarnedPaise: r.netPaise });
		}

		let totalSimPending = 0;
		let totalSimAmount = 0n;
		const byWeekSim = new Map<bigint, { earners: number; amount: bigint }>();

		for (const [, weeks] of memberWeeks) {
			const { payouts } = planWeeklyPayouts(weeks, MIN_PAYOUT_PAISE);
			for (const p of payouts) {
				totalSimPending++;
				totalSimAmount += p.amountPaise;
				const ws = byWeekSim.get(p.cutoffId) ?? { earners: 0, amount: 0n };
				ws.earners++;
				ws.amount += p.amountPaise;
				byWeekSim.set(p.cutoffId, ws);
			}
		}

		// Get cutoff metadata for display
		const { rows: cmRows } = await pool.query<{
			id: string; window_start: Date; window_end: Date; status: string;
		}>(`SELECT id::text, window_start, window_end, status FROM cutoffs ORDER BY window_start`);
		const cutoffMeta = new Map(cmRows.map(r => [
			BigInt(r.id),
			{ start: r.window_start.toISOString().slice(0, 10), end: r.window_end.toISOString().slice(0, 10), status: r.status },
		]));

		console.log(`\nPhase 3 — Reconstruct ${totalSimPending} pending payout(s) totalling ${toRupees(totalSimAmount)}`);
		console.log(`  (Simulation: carry-forward from initial withdrawable=0; excludes pre-existing non-auto withdrawable balances)`);
		const sortedSim = [...byWeekSim.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
		for (const [wid, ws] of sortedSim) {
			const cm = cutoffMeta.get(wid);
			const label = cm ? `${cm.start}→${cm.end} [${cm.status}]` : `cutoff_id=${wid}`;
			console.log(`  Cutoff ${wid}: ${label}  earners=${ws.earners}  pending total=${toRupees(ws.amount)}`);
		}

		if (earnerRows.length === 0) {
			console.log(`\n  ⚠  No released accruals bucket into any existing cutoff window.`);
			console.log(`     Run Phase 2 (--execute) to create historical cutoffs first, then re-run.`);
		}

		if (!EXECUTE) {
			console.log(
				`\n[reconstructWeeklyPayouts] DRY-RUN complete — no writes. Pass --execute to apply.\n`,
			);
			return;
		}

		// ── Pre-write race guard ─────────────────────────────────────────────────
		const { rows: raceRows } = await pool.query<{ released: string }>(
			`SELECT COUNT(*) AS released FROM pair_accruals WHERE status='released'`,
		);
		const releasedNow = BigInt(raceRows[0].released);
		if (releasedNow !== releasedSnapshot) {
			console.error(
				`\n[reconstructWeeklyPayouts] ABORT: released accrual count changed from ${releasedSnapshot} to ${releasedNow}.\n` +
					"  Workers are still active. Stop avg-workers, let the pipeline fully quiesce, then re-run.",
			);
			process.exit(1);
		}
		console.log(`\n✓ Released count stable (${releasedNow}). Proceeding with writes.\n`);

		// ── Phase 1: Execute wipe ────────────────────────────────────────────────
		process.stdout.write("[Phase 1] Wiping auto-pending rows");
		let wiped = 0;
		for (const [, mw] of wipeByMember) {
			const txnIds = [...mw.txnIds];
			const client = await pool.connect();
			try {
				await client.query("BEGIN");

				// Restore wallet balance (always positive delta)
				if (mw.walletDelta > 0n && mw.walletAccId !== null) {
					await client.query(
						`UPDATE wallet_balances SET balance = balance + $1::numeric, updated_at = now()
             WHERE account_id = $2`,
						[fromPaise(mw.walletDelta), mw.walletAccId],
					);
				}

				// Restore withdrawable balance (net delta: may be 0 or positive)
				if (mw.withdrawableAccId !== null) {
					if (mw.withdrawableDelta !== 0n) {
						const signed =
							mw.withdrawableDelta > 0n
								? fromPaise(mw.withdrawableDelta)
								: "-" + fromPaise(-mw.withdrawableDelta);
						await client.query(
							`UPDATE wallet_balances SET balance = balance + $1::numeric, updated_at = now()
               WHERE account_id = $2`,
							[signed, mw.withdrawableAccId],
						);
					}
				}

				// Delete entries before txns (FK is NO ACTION, not CASCADE)
				await client.query(
					`DELETE FROM ledger_entries WHERE txn_id = ANY($1::uuid[])`,
					[txnIds],
				);
				await client.query(
					`DELETE FROM ledger_txns WHERE txn_id = ANY($1::uuid[])`,
					[txnIds],
				);

				// Delete auto-pending withdrawals for this member (proofs cascade)
				await client.query(
					`DELETE FROM withdrawals WHERE member_id=$1 AND source_cutoff_id IS NOT NULL AND status='pending'`,
					[mw.memberId],
				);

				await client.query("COMMIT");
				wiped++;
				process.stdout.write(".");
			} catch (err) {
				await client.query("ROLLBACK");
				console.error(`\n[Phase 1] ERROR on member ${mw.memberId}: ${(err as Error).message}`);
				throw err;
			} finally {
				client.release();
			}
		}
		console.log(`\n[Phase 1] ✓ Wiped ${wiped} members. Auto-pending rows cleared.\n`);

		// Record wallet total after wipe (for conservation check in Phase 4)
		const { rows: postWipeRows } = await pool.query<{ wallet_total: string }>(`
      SELECT COALESCE(SUM(wb.balance), 0)::text AS wallet_total
        FROM wallet_balances wb
        JOIN accounts a ON a.id = wb.account_id
       WHERE a.kind = 'wallet'
    `);
		const walletAfterWipe = toPaise(postWipeRows[0].wallet_total);
		console.log(`  Wallet total after wipe: ${toRupees(walletAfterWipe)}`);

		// ── Phase 2: Ensure historical cutoffs ──────────────────────────────────
		process.stdout.write("[Phase 2] Ensuring historical cutoffs");
		let cutoffsCreated = 0;
		for (const c of cutoffsToCreate) {
			const { rowCount } = await pool.query(
				`INSERT INTO cutoffs (window_start, window_end, payout_date, status)
         VALUES ($1,$2,$3,'closed')
         ON CONFLICT (window_start) DO NOTHING`,
				[c.windowStart.toISOString(), c.windowEnd.toISOString(), c.payoutDate.toISOString().slice(0, 10)],
			);
			if ((rowCount ?? 0) > 0) {
				cutoffsCreated++;
				process.stdout.write(".");
			}
		}
		console.log(`\n[Phase 2] ✓ Created ${cutoffsCreated} new cutoff(s).\n`);

		// ── Post-Phase-2 safety assertion: no release matches > 1 closed cutoff ──
		// If window boundaries overlap (e.g., the anchor changed between deployments),
		// a single release could match two cutoffs and a member would be credited twice.
		// Conservation check (Phase 4) would NOT catch this — the global sum still
		// balances because the extra credit comes from the member's own wallet total.
		const { rows: overlapRows } = await pool.query<{ overlap_count: string }>(`
      WITH rel AS (
        SELECT GREATEST(GREATEST(lm.activated_at, rm.activated_at), b.qualified_at) AS release_at
          FROM pair_accruals pa
          JOIN pairs   p  ON p.id  = pa.pair_id
          JOIN members lm ON lm.id  = p.left_member_id
          JOIN members rm ON rm.id  = p.right_member_id
          JOIN members b  ON b.id   = p.member_id
         WHERE pa.status = 'released'
      ), matches AS (
        SELECT r.release_at, COUNT(DISTINCT c.id) AS matched_cutoffs
          FROM rel r
          JOIN cutoffs c ON r.release_at >= c.window_start
                        AND r.release_at <  c.window_end
                        AND c.status = 'closed'
         GROUP BY r.release_at
      )
      SELECT COUNT(*) AS overlap_count FROM matches WHERE matched_cutoffs > 1
    `);
		const overlapCount = BigInt(overlapRows[0].overlap_count);
		if (overlapCount > 0n) {
			console.error(
				`\n[Phase 2] ABORT: ${overlapCount} release timestamp(s) match >1 closed cutoff.\n` +
				"  This means the cutoff windows overlap (anchor changed between deployments).\n" +
				"  Manually inspect the cutoffs table and remove conflicting windows before re-running.",
			);
			process.exit(1);
		}

		// Confirm no orphan releases (releases outside all closed windows)
		const { rows: orphanRows } = await pool.query<{ orphan_count: string }>(`
      WITH rel AS (
        SELECT pa.id AS accrual_id,
               GREATEST(GREATEST(lm.activated_at, rm.activated_at), b.qualified_at) AS release_at
          FROM pair_accruals pa
          JOIN pairs   p  ON p.id  = pa.pair_id
          JOIN members lm ON lm.id  = p.left_member_id
          JOIN members rm ON rm.id  = p.right_member_id
          JOIN members b  ON b.id   = p.member_id
         WHERE pa.status = 'released'
      )
      SELECT COUNT(*) AS orphan_count
        FROM rel r
        WHERE NOT EXISTS (
          SELECT 1 FROM cutoffs c
           WHERE r.release_at >= c.window_start
             AND r.release_at <  c.window_end
             AND c.status IN ('closed', 'open')
        )
    `);
		const orphanCount = BigInt(orphanRows[0].orphan_count);
		if (orphanCount > 0n) {
			// Orphan releases were already caught by Phase 0 pre-mutation check.
			// If we somehow reach here (e.g. a concurrent INSERT changed the data
			// between Phase 0 and now), abort hard — the pre-flight check missed it
			// but Phase 4 conservation would NOT catch it (orphan money stays in wallet
			// and still balances).  Better to abort than silently drop earnings.
			console.error(
				`\n[Phase 2] ABORT: ${orphanCount} released accrual(s) fall outside all closed cutoff windows.\n` +
				"  These earnings would NOT appear in any weekly payout.\n" +
				"  The data changed between the Phase 0 pre-flight check and now\n" +
				"  (possible concurrent worker activity). Re-run with workers stopped.",
			);
			process.exit(1);
		} else {
			console.log(`[Phase 2] ✓ No overlap or orphan releases. All ${releasedSnapshot} released accruals bucket cleanly.\n`);
		}

		// ── Phase 3: Per-week sweep replay ───────────────────────────────────────
		// Fetch all member wallet/withdrawable accounts in bulk
		const { rows: accRows } = await pool.query<{
			owner_id: string;
			kind: string;
			acc_id: string;
		}>(`
      SELECT a.owner_id::text, a.kind, a.id::text AS acc_id
        FROM accounts a
       WHERE a.kind IN ('wallet','withdrawable') AND a.owner_type='member'
    `);
		type MemberAccounts = { walletAccId: bigint; withdrawableAccId: bigint };
		const memberAccounts = new Map<bigint, MemberAccounts>();
		for (const r of accRows) {
			const mid = BigInt(r.owner_id);
			let ma = memberAccounts.get(mid);
			if (!ma) { ma = { walletAccId: 0n, withdrawableAccId: 0n }; memberAccounts.set(mid, ma); }
			if (r.kind === "wallet") ma.walletAccId = BigInt(r.acc_id);
			else if (r.kind === "withdrawable") ma.withdrawableAccId = BigInt(r.acc_id);
		}

		// Get system payout_clearing account
		const { rows: sysRows } = await pool.query<{ id: string }>(
			`SELECT id FROM accounts WHERE owner_type='system' AND kind='payout_clearing'`,
		);
		if (!sysRows[0]) {
			console.error("[Phase 3] ABORT: no payout_clearing system account found.");
			process.exit(1);
		}
		const payoutClearingId = BigInt(sysRows[0].id);

		// Re-run the reconstruction query AFTER Phase 2 (new cutoffs may now exist)
		const { rows: accrualRows2 } = await pool.query<{
			cutoff_id: string;
			window_end: Date;
			member_id: string;
			gross_paise: string;
		}>(`
      WITH rel AS (
        SELECT p.member_id             AS beneficiary_id,
               GREATEST(
                 GREATEST(lm.activated_at, rm.activated_at),
                 b.qualified_at
               )                       AS release_at
          FROM pair_accruals pa
          JOIN pairs   p  ON p.id  = pa.pair_id
          JOIN members lm ON lm.id  = p.left_member_id
          JOIN members rm ON rm.id  = p.right_member_id
          JOIN members b  ON b.id   = p.member_id
         WHERE pa.status = 'released'
      )
      SELECT c.id::text                                   AS cutoff_id,
             c.window_end,
             r.beneficiary_id::text                      AS member_id,
             (COUNT(*) * ${PAIR_BONUS_PAISE})::bigint::text AS gross_paise
        FROM rel r
        JOIN cutoffs c
          ON r.release_at >= c.window_start
         AND r.release_at <  c.window_end
         AND c.status = 'closed'
        JOIN members m ON m.id = r.beneficiary_id
       GROUP BY c.id, c.window_end, r.beneficiary_id
       ORDER BY c.window_start, r.beneficiary_id::bigint
    `);

		// Group earners per cutoff
		type CutoffEarners = {
			windowEnd: Date;
			earners: Map<bigint, bigint>; // member_id → net_paise
		};
		const earnersByCutoff = new Map<bigint, CutoffEarners>();
		for (const r of accrualRows2) {
			const cid = BigInt(r.cutoff_id);
			let ce = earnersByCutoff.get(cid);
			if (!ce) {
				ce = { windowEnd: r.window_end, earners: new Map() };
				earnersByCutoff.set(cid, ce);
			}
			const gross = BigInt(r.gross_paise);
			const net = gross < CUTOFF_CAP_PAISE ? gross : CUTOFF_CAP_PAISE;
			ce.earners.set(BigInt(r.member_id), net);
		}

		// Get all closed cutoffs in chronological order
		const { rows: closedCutoffs } = await pool.query<{
			id: string;
			window_end: Date;
		}>(`SELECT id::text, window_end FROM cutoffs WHERE status='closed' ORDER BY window_start`);

		console.log(`[Phase 3] Replaying ${closedCutoffs.length} closed cutoff(s)...`);

		let pendingCreated = 0;
		let totalPendingPaise = 0n;

		for (const cutoff of closedCutoffs) {
			const cutoffId = BigInt(cutoff.id);
			const windowEnd = cutoff.window_end;
			const ce = earnersByCutoff.get(cutoffId);
			const earners = ce?.earners ?? new Map<bigint, bigint>();

			// Step A: for earners this week, post wallet → withdrawable
			for (const [memberId, netPaise] of earners) {
				if (netPaise === 0n) continue;
				const ma = memberAccounts.get(memberId);
				if (!ma) {
					console.warn(`  WARN: no accounts for member ${memberId} — skipping`);
					continue;
				}

				const client = await pool.connect();
				try {
					await client.query("BEGIN");
					await postLedgerTxn(
						client,
						`wsweep:${cutoffId}:${memberId}`,
						"wsweep",
						null,
						[
							{ accountId: ma.walletAccId, direction: "D", amountPaise: netPaise },
							{ accountId: ma.withdrawableAccId, direction: "C", amountPaise: netPaise },
						],
					);
					await client.query("COMMIT");
				} catch (err) {
					await client.query("ROLLBACK");
					console.error(`\n[Phase 3] ERROR wsweep cutoff=${cutoffId} member=${memberId}: ${(err as Error).message}`);
					throw err;
				} finally {
					client.release();
				}
			}

			// Step B: for ALL members with withdrawable >= ₹500 (earners + carry-forward),
			// create pending withdrawal + hold.
			const { rows: eligibleRows } = await pool.query<{
				member_id: string;
				balance: string;
				withdrawable_acc_id: string;
			}>(`
        SELECT a.owner_id::text AS member_id, wb.balance::text AS balance, a.id::text AS withdrawable_acc_id
          FROM wallet_balances wb
          JOIN accounts a ON a.id = wb.account_id
         WHERE a.kind = 'withdrawable'
           AND a.owner_type = 'member'
           AND wb.balance * 100 >= ${MIN_PAYOUT_PAISE}
           AND NOT EXISTS (
             SELECT 1 FROM withdrawals w
              WHERE w.member_id = a.owner_id::bigint
                AND w.source_cutoff_id = ${cutoffId}
                AND w.status = 'pending'
           )
      `);

			for (const row of eligibleRows) {
				const memberId = BigInt(row.member_id);
				const withdrawableBalance = toPaise(row.balance);
				const withdrawableAccId = BigInt(row.withdrawable_acc_id);

				const client = await pool.connect();
				try {
					await client.query("BEGIN");

					// Re-read FOR UPDATE to prevent races
					const { rows: lockRows } = await client.query<{ balance: string }>(
						`SELECT wb.balance FROM wallet_balances wb WHERE wb.account_id=$1 FOR UPDATE`,
						[withdrawableAccId],
					);
					const lockedBalance = lockRows[0] ? toPaise(lockRows[0].balance) : 0n;

					if (lockedBalance < MIN_PAYOUT_PAISE) {
						await client.query("ROLLBACK");
						continue; // fell below threshold due to concurrent write
					}

					const holdKey = `autowd:${cutoffId}:${memberId}`;

					const { rows: wdRows } = await client.query<{ id: string }>(
						`INSERT INTO withdrawals (member_id, amount, status, source_cutoff_id, requested_at)
             VALUES ($1, $2::numeric, 'pending', $3, $4)
             ON CONFLICT (member_id, source_cutoff_id)
               WHERE source_cutoff_id IS NOT NULL
             DO NOTHING
             RETURNING id`,
						[
							String(memberId),
							fromPaise(lockedBalance),
							String(cutoffId),
							windowEnd.toISOString(),
						],
					);

					if (wdRows[0]) {
						await postLedgerTxn(
							client,
							holdKey,
							"withdrawal",
							BigInt(wdRows[0].id),
							[
								{ accountId: withdrawableAccId, direction: "D", amountPaise: lockedBalance },
								{ accountId: payoutClearingId, direction: "C", amountPaise: lockedBalance },
							],
						);
						pendingCreated++;
						totalPendingPaise += lockedBalance;
					}

					await client.query("COMMIT");
				} catch (err) {
					await client.query("ROLLBACK");
					console.error(`\n[Phase 3] ERROR hold cutoff=${cutoffId} member=${memberId}: ${(err as Error).message}`);
					throw err;
				} finally {
					client.release();
				}
			}

			process.stdout.write(`  Cutoff ${cutoffId}: earners=${earners.size}  new pending=${eligibleRows.length}\n`);
		}

		console.log(`\n[Phase 3] ✓ Created ${pendingCreated} pending withdrawal(s) totalling ${toRupees(totalPendingPaise)}.\n`);

		// ── Phase 4: Conservation self-check ────────────────────────────────────
		const { rows: consRows } = await pool.query<{
			wallet_sum: string;
			withdrawable_sum: string;
			pending_sum: string;
		}>(`
      SELECT
        (SELECT COALESCE(SUM(wb.balance),0)
           FROM wallet_balances wb JOIN accounts a ON a.id=wb.account_id
          WHERE a.kind='wallet')::text                                AS wallet_sum,
        (SELECT COALESCE(SUM(wb.balance),0)
           FROM wallet_balances wb JOIN accounts a ON a.id=wb.account_id
          WHERE a.kind='withdrawable')::text                         AS withdrawable_sum,
        (SELECT COALESCE(SUM(amount),0)
           FROM withdrawals WHERE source_cutoff_id IS NOT NULL AND status='pending')::text AS pending_sum
    `);
		const walletNow = toPaise(consRows[0].wallet_sum);
		const withdrawableNow = toPaise(consRows[0].withdrawable_sum);
		const pendingNow = toPaise(consRows[0].pending_sum);
		const conserved = walletNow + withdrawableNow + pendingNow;
		const conservationPass = conserved === walletAfterWipe;

		console.log("── Phase 4: Conservation self-check ──────────────────────────────────");
		console.log(`  Wallet after wipe (baseline) : ${toRupees(walletAfterWipe)}`);
		console.log(`  Wallet now                   : ${toRupees(walletNow)}`);
		console.log(`  Withdrawable now             : ${toRupees(withdrawableNow)}  (carry-forward < ₹500)`);
		console.log(`  Pending withdrawals total    : ${toRupees(pendingNow)}`);
		console.log(`  Sum (wallet+withdr+pending)  : ${toRupees(conserved)}`);
		console.log(`  Conservation check           : ${conservationPass ? "✅ PASS" : "❌ FAIL"}`);

		if (!conservationPass) {
			console.error(
				"\n[reconstructWeeklyPayouts] CRITICAL: conservation check failed — money was created or destroyed.\n" +
					`  Expected: ${toRupees(walletAfterWipe)}  Got: ${toRupees(conserved)}  Δ=${toRupees(conserved - walletAfterWipe)}\n` +
					"  Investigate ledger entries immediately.",
			);
			process.exit(1);
		}

		console.log(`\n[reconstructWeeklyPayouts] ✅ Done. ${pendingCreated} pending withdrawal(s) across ${closedCutoffs.length} week(s).`);
		console.log("  Next steps:");
		console.log("  1. Verify in admin panel: WithdrawalsTab → pending filter shows per-week rows.");
		console.log("  2. Verify member Wallet page shows historical pending rows dated to each week.");
		console.log("  3. Restart avg-workers when ready.\n");
	} finally {
		await pool.end();
	}
}

// Only run main() when this file is the direct entry point (not when imported
// for its exports — e.g., by unit tests importing planWeeklyPayouts).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main().catch((err) => {
		console.error("[reconstructWeeklyPayouts] fatal:", err);
		process.exit(1);
	});
}
