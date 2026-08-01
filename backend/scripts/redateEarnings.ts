/**
 * redateEarnings.ts — surgical correction of per-week cutoff_earnings attribution
 *                    and top-up of over-capped member wallets.
 *
 * Background:
 *   A reseed crammed all pair releases into the single open cutoff (W3), causing:
 *   (a) admin "last week" to show ₹0 (all earnings stamped to W3, not W1/W2);
 *   (b) over-triggering of the ₹1,00,000/member/week cap for 2 members, wrongly
 *       forfeiting real earnings they would have kept if releases were week-spread.
 *
 * What this script does (two independently-reversible operations):
 *   Operation A — all earners:
 *     DELETE + INSERT cutoff_earnings so each member has one row per correct week,
 *     derived from causal timestamps (release_at = GREATEST(pair completion, qualified_at)).
 *     Per-member total is preserved for non-capped members → no ledger changes for them.
 *   Operation B — capped members only (those whose correct total > current wallet):
 *     Post one balanced ledger txn (D bonus_forfeited / C wallet) to restore the
 *     wrongly-forfeited amount. Idempotent via unique idempotency_key.
 *
 * Both A and B run in a single per-member transaction so they are atomic per member.
 *
 * Safety:
 *   • Dry-run by default — prints full diff, writes nothing.  Pass --execute to write.
 *   • Pass --i-know when PROD_DATABASE_URL contains 'hayabusa' (production host).
 *   • In-script preconditions asserted and aborting on failure before any writes:
 *       – withdrawals = 0
 *       – all withdrawable balances = 0
 *       – all deferred_bonus balances = 0
 *       – SUM(cutoff_earnings.earned) == SUM(wallet_balances where kind='wallet')  (no drift)
 *   • Snapshot-race guard: released accrual count is re-checked immediately before
 *     writes — if it changed (workers still active), the script aborts.
 *   • Idempotent re-run: postLedgerTxn returns false if idempotency_key already
 *     exists (no double-credit); DELETE+INSERT on cutoff_earnings is idempotent.
 *
 * IMPORTANT — operator checklist before --execute on production:
 *   1. Take a Railway pg_dump backup (hayabusa → timestamped file).
 *   2. Stop avg-workers and let the pipeline fully quiesce (released count stable).
 *   3. Run dry-run first and verify the diff matches expectations.
 *   4. Run dev-copy execute first (PROD_DATABASE_URL=$DATABASE_URL --execute).
 *   5. Get explicit go-ahead, then run production --i-know --execute.
 *
 * Reconciler note: cutoff_earnings is NOT a reconciled quantity — re-attributing
 * it across weeks raises no drift alert. The reconciler is alert-only (no writes).
 * Existing pairbonus:* ledger txns are untouched; only a new redate-correction:*
 * txn is added for the 2 capped members.
 *
 * Usage:
 *   # dev-copy dry-run:
 *   PROD_DATABASE_URL="$DATABASE_URL" npx tsx scripts/redateEarnings.ts
 *   # dev-copy execute:
 *   PROD_DATABASE_URL="$DATABASE_URL" npx tsx scripts/redateEarnings.ts --execute
 *   # production dry-run:
 *   PROD_DATABASE_URL='postgresql://...@hayabusa...' npx tsx scripts/redateEarnings.ts --i-know
 *   # production execute (take backup + stop workers + get explicit go-ahead first):
 *   PROD_DATABASE_URL='postgresql://...@hayabusa...' npx tsx scripts/redateEarnings.ts --i-know --execute
 *   # or via npm:
 *   PROD_DATABASE_URL='...' npm run redate:earnings [-- --i-know] [-- --execute]
 */

import pg from "pg";
import { v5 as uuidv5 } from "uuid";

// ── constants (mirrors src/config.ts — no env-import to keep script side-effect-free) ──
const PAIR_BONUS_PAISE = 100_000n; // ₹1,000 per pair
const CUTOFF_CAP_PAISE = 10_000_000n; // ₹1,00,000 per member per week

// ── id helper (must match UUID_NAMESPACE in lib/ids.ts exactly) ──────────────
const UUID_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
function txnUuid(key: string): string {
	return uuidv5(key, UUID_NAMESPACE);
}

// ── money helpers (mirrors lib/money.ts; no float arithmetic on money) ────────
function fromPaise(p: bigint): string {
	return (Number(p) / 100).toFixed(2);
}
function toPaise(s: string | number): bigint {
	return BigInt(Math.round(Number(s) * 100));
}
function toRupees(p: bigint): string {
	return `₹${(Number(p) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;
}

// ── arg parsing ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const I_KNOW = args.includes("--i-know");

// ── inline postLedgerTxn ──────────────────────────────────────────────────────
// Mirrors workers/ledger.ts:25–82 exactly.  Kept inline so this script has
// zero side-effects from importing the worker module (no dotenv, no pool init).
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

	// Idempotency check — returns false (skip) if key already processed
	const { rows: existing } = await c.query(
		"SELECT 1 FROM ledger_txns WHERE idempotency_key=$1",
		[idempotencyKey],
	);
	if (existing.length > 0) return false;

	// Enforce balanced double-entry
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
		// Only wallet/deferred_bonus/withdrawable accounts have wallet_balances rows
		const { rows: acRows } = await c.query<{ kind: string }>(
			"SELECT kind FROM accounts WHERE id=$1",
			[leg.accountId],
		);
		const kind = acRows[0]?.kind;
		if (
			kind === "wallet" ||
			kind === "deferred_bonus" ||
			kind === "withdrawable"
		) {
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

// ── main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
	const url = process.env.PROD_DATABASE_URL;
	if (!url) {
		console.error(
			"[redateEarnings] PROD_DATABASE_URL is required.\n" +
				"  Dev copy:   PROD_DATABASE_URL=$DATABASE_URL npx tsx scripts/redateEarnings.ts\n" +
				"  Production: PROD_DATABASE_URL='postgresql://...' npx tsx scripts/redateEarnings.ts --i-know",
		);
		process.exit(1);
	}

	const isProd = url.includes("hayabusa");
	if (isProd && !I_KNOW) {
		console.error(
			"[redateEarnings] PROD_DATABASE_URL points at production (hayabusa).\n" +
				"  Take a Railway pg_dump backup and stop avg-workers first, then pass --i-know.",
		);
		process.exit(1);
	}

	const pool = new pg.Pool({ connectionString: url, max: 5 });

	try {
		// ── 1. Preconditions — read-only checks, abort on any failure ──────────
		const { rows: preRows } = await pool.query<{
			withdrawals: string;
			withdrawable_nonzero: string;
			deferred_nonzero: string;
			cutoff_earned_rupees: string;
			wallet_total_rupees: string;
			released_accruals: string;
		}>(`
      SELECT
        (SELECT COUNT(*) FROM withdrawals)::text                                           AS withdrawals,
        (SELECT COUNT(*) FROM wallet_balances wb
          JOIN accounts a ON a.id=wb.account_id
          WHERE a.kind='withdrawable' AND wb.balance > 0)::text                            AS withdrawable_nonzero,
        (SELECT COUNT(*) FROM wallet_balances wb
          JOIN accounts a ON a.id=wb.account_id
          WHERE a.kind='deferred_bonus' AND wb.balance > 0)::text                          AS deferred_nonzero,
        (SELECT COALESCE(SUM(earned),0) FROM cutoff_earnings)::text                        AS cutoff_earned_rupees,
        (SELECT COALESCE(SUM(wb.balance),0)
          FROM wallet_balances wb JOIN accounts a ON a.id=wb.account_id
          WHERE a.kind='wallet')::text                                                     AS wallet_total_rupees,
        (SELECT COUNT(*) FROM pair_accruals WHERE status='released')::text                 AS released_accruals
    `);
		const pre = preRows[0];
		const releasedSnapshot = BigInt(pre.released_accruals);
		const cutoffEarnedPaise = toPaise(pre.cutoff_earned_rupees);
		const walletTotalPaise = toPaise(pre.wallet_total_rupees);

		const precondFailed: string[] = [];
		if (BigInt(pre.withdrawals) > 0n)
			precondFailed.push(`withdrawals = ${pre.withdrawals} (expected 0)`);
		if (BigInt(pre.withdrawable_nonzero) > 0n)
			precondFailed.push(
				`members with withdrawable > 0: ${pre.withdrawable_nonzero}`,
			);
		if (BigInt(pre.deferred_nonzero) > 0n)
			precondFailed.push(
				`members with deferred_bonus > 0: ${pre.deferred_nonzero}`,
			);
		if (cutoffEarnedPaise !== walletTotalPaise)
			precondFailed.push(
				`cutoff_earnings total (${toRupees(cutoffEarnedPaise)}) ≠ wallet total (${toRupees(walletTotalPaise)}) — pre-existing drift, do not proceed`,
			);

		if (precondFailed.length > 0) {
			console.error(
				"[redateEarnings] PRECONDITIONS FAILED — aborting:\n" +
					precondFailed.map((s) => `  • ${s}`).join("\n"),
			);
			process.exit(1);
		}

		console.log(`[redateEarnings] ✓ Preconditions passed.`);
		console.log(`  Wallet total         : ${toRupees(walletTotalPaise)}`);
		console.log(`  Released accruals    : ${releasedSnapshot}`);

		// ── 2. Reconstruction query — same method as reconstructWeekly.ts ────────
		// release_at = GREATEST(pair completion, earner qualification)
		// Only released accruals — pending = unqualified = not earned in any week.
		const { rows: recoRows } = await pool.query<{
			cutoff_id: string;
			member_id: string;
			member_code: string;
			name: string;
			gross_paise: string;
		}>(`
      WITH rel AS (
        SELECT p.member_id   AS beneficiary_id,
               GREATEST(
                 GREATEST(lm.activated_at, rm.activated_at),
                 b.qualified_at
               )              AS release_at
          FROM pair_accruals pa
          JOIN pairs   p  ON p.id  = pa.pair_id
          JOIN members lm ON lm.id = p.left_member_id
          JOIN members rm ON rm.id = p.right_member_id
          JOIN members b  ON b.id  = p.member_id
         WHERE pa.status = 'released'
      )
      SELECT c.id::text                           AS cutoff_id,
             r.beneficiary_id::text               AS member_id,
             m.member_code,
             m.name,
             (COUNT(*) * ${PAIR_BONUS_PAISE})::bigint::text AS gross_paise
        FROM rel r
        JOIN cutoffs c
          ON r.release_at >= c.window_start
         AND r.release_at <  c.window_end
        JOIN members m ON m.id = r.beneficiary_id
       GROUP BY c.id, r.beneficiary_id, m.member_code, m.name
       ORDER BY r.beneficiary_id::bigint, c.id::bigint
    `);

		type NewCeRow = {
			cutoffId: bigint;
			memberId: bigint;
			memberCode: string;
			name: string;
			grossPaise: bigint;
			netPaise: bigint; // min(gross, cap)
		};

		// Apply per-member-per-week cap in JS (mirrors reconstructWeekly.ts)
		const newCeRows: NewCeRow[] = recoRows.map((r) => {
			const gross = BigInt(r.gross_paise);
			const net = gross < CUTOFF_CAP_PAISE ? gross : CUTOFF_CAP_PAISE;
			return {
				cutoffId: BigInt(r.cutoff_id),
				memberId: BigInt(r.member_id),
				memberCode: r.member_code,
				name: r.name,
				grossPaise: gross,
				netPaise: net,
			};
		});

		// Group correct rows by member
		type MemberCorrect = {
			memberId: bigint;
			memberCode: string;
			name: string;
			totalNetPaise: bigint;
			ceRows: NewCeRow[];
		};
		const correctByMember = new Map<bigint, MemberCorrect>();
		for (const r of newCeRows) {
			let entry = correctByMember.get(r.memberId);
			if (!entry) {
				entry = {
					memberId: r.memberId,
					memberCode: r.memberCode,
					name: r.name,
					totalNetPaise: 0n,
					ceRows: [],
				};
				correctByMember.set(r.memberId, entry);
			}
			entry.totalNetPaise += r.netPaise;
			entry.ceRows.push(r);
		}

		// ── 3. Current state — wallet balance per member ─────────────────────────
		const { rows: walletRows } = await pool.query<{
			owner_id: string;
			acc_id: string;
			balance: string;
		}>(`
      SELECT a.owner_id::text AS owner_id, a.id::text AS acc_id, wb.balance::text AS balance
        FROM accounts a
        JOIN wallet_balances wb ON wb.account_id = a.id
       WHERE a.kind = 'wallet' AND a.owner_type = 'member'
    `);
		const walletByMember = new Map<
			bigint,
			{ accId: bigint; balancePaise: bigint }
		>();
		for (const r of walletRows) {
			walletByMember.set(BigInt(r.owner_id), {
				accId: BigInt(r.acc_id),
				balancePaise: toPaise(r.balance),
			});
		}

		// ── 4. Compute diffs ──────────────────────────────────────────────────────
		type MemberDiff = {
			memberId: bigint;
			memberCode: string;
			name: string;
			currentWalletPaise: bigint;
			correctTotalPaise: bigint;
			deltaPaise: bigint; // >0 = wallet top-up needed, 0 = redate only
			walletAccId: bigint;
			newCeRows: NewCeRow[];
		};

		const diffs: MemberDiff[] = [];
		for (const [memberId, correct] of correctByMember) {
			const walletInfo = walletByMember.get(memberId);
			if (!walletInfo) {
				console.warn(
					`[redateEarnings] WARN: no wallet account for ${correct.memberCode} — skipping`,
				);
				continue;
			}
			diffs.push({
				memberId,
				memberCode: correct.memberCode,
				name: correct.name,
				currentWalletPaise: walletInfo.balancePaise,
				correctTotalPaise: correct.totalNetPaise,
				deltaPaise: correct.totalNetPaise - walletInfo.balancePaise,
				walletAccId: walletInfo.accId,
				newCeRows: correct.ceRows,
			});
		}

		// Sanity: delta must be ≥ 0 (re-dating can only increase or preserve total)
		const negativeDelta = diffs.filter((d) => d.deltaPaise < 0n);
		if (negativeDelta.length > 0) {
			console.error(
				"[redateEarnings] ABORT: the following members would LOSE money — reconstruction inconsistency:\n" +
					negativeDelta
						.map(
							(d) =>
								`  ${d.memberCode}: correct=${toRupees(d.correctTotalPaise)} wallet=${toRupees(d.currentWalletPaise)} delta=${toRupees(d.deltaPaise)}`,
						)
						.join("\n"),
			);
			process.exit(1);
		}

		const cappedMembers = diffs.filter((d) => d.deltaPaise > 0n);
		const redateOnlyMembers = diffs.filter((d) => d.deltaPaise === 0n);
		const totalDeltaPaise = cappedMembers.reduce(
			(s, d) => s + d.deltaPaise,
			0n,
		);

		// ── 5. Cutoff metadata for display ─────────────────────────────────────
		const { rows: cutoffRows } = await pool.query<{
			id: string;
			window_start: Date;
			window_end: Date;
			status: string;
		}>(`SELECT id::text, window_start, window_end, status FROM cutoffs ORDER BY window_start`);
		const cutoffMeta = new Map(
			cutoffRows.map((r) => [
				BigInt(r.id),
				{
					start: r.window_start.toISOString().slice(0, 10),
					end: r.window_end.toISOString().slice(0, 10),
					status: r.status,
				},
			]),
		);

		// ── 6. Dry-run report ─────────────────────────────────────────────────────
		const line = "═".repeat(70);
		console.log(`\n${line}`);
		console.log(
			`  redateEarnings — diff report (${EXECUTE ? (isProd ? "EXECUTE on PRODUCTION" : "EXECUTE on dev copy") : "DRY-RUN"})`,
		);
		console.log(line);

		if (cappedMembers.length === 0) {
			console.log(
				"\n  ⚠  No members need wallet top-up (Operation B). Only week re-attribution (Operation A) applies.",
			);
		} else {
			console.log(
				`\n  Operation B — wallet top-up (${cappedMembers.length} member${cappedMembers.length !== 1 ? "s" : ""}):`,
			);
			for (const d of cappedMembers) {
				console.log(`\n  ${d.memberCode}  ${d.name}`);
				console.log(`    Current wallet    : ${toRupees(d.currentWalletPaise)}`);
				console.log(`    Correct total     : ${toRupees(d.correctTotalPaise)}`);
				console.log(
					`    Delta (credit)    : +${toRupees(d.deltaPaise)}  (D bonus_forfeited / C wallet)`,
				);
				console.log(`    Idempotency key   : redate-correction:${d.memberId}`);
				console.log(`    New cutoff_earnings rows:`);
				for (const r of d.newCeRows) {
					const cm = cutoffMeta.get(r.cutoffId);
					const label = cm
						? `${cm.start}→${cm.end} [${cm.status}]`
						: `cutoff_id=${r.cutoffId}`;
					const forfeited = r.grossPaise - r.netPaise;
					console.log(
						`      ${label}  net=${toRupees(r.netPaise)}  gross=${toRupees(r.grossPaise)}${forfeited > 0n ? `  forfeited=${toRupees(forfeited)}` : ""}`,
					);
				}
			}
		}

		// Per-week summary (all earners)
		console.log(
			`\n  Operation A — week re-attribution (${diffs.length} earners total):`,
		);
		const windowSummary = new Map<
			bigint,
			{ earners: number; net: bigint }
		>();
		for (const d of diffs) {
			for (const r of d.newCeRows) {
				const ws = windowSummary.get(r.cutoffId) ?? { earners: 0, net: 0n };
				ws.earners++;
				ws.net += r.netPaise;
				windowSummary.set(r.cutoffId, ws);
			}
		}
		const sortedWindows = [...windowSummary.entries()].sort(([a], [b]) =>
			a < b ? -1 : 1,
		);
		for (const [wid, ws] of sortedWindows) {
			const cm = cutoffMeta.get(wid);
			const label = cm
				? `${cm.start}→${cm.end} [${cm.status}]`
				: `cutoff_id=${wid}`;
			console.log(
				`    Window ${wid}: ${label}  earners=${ws.earners}  net=${toRupees(ws.net)}`,
			);
		}
		const grandNet = sortedWindows.reduce((s, [, ws]) => s + ws.net, 0n);
		console.log(`    Grand total net: ${toRupees(grandNet)}`);

		console.log(`\n  Summary:`);
		console.log(
			`    Earners total      : ${diffs.length}  (${cappedMembers.length} top-up, ${redateOnlyMembers.length} redate-only)`,
		);
		console.log(
			`    Current wallet     : ${toRupees(walletTotalPaise)}`,
		);
		console.log(
			`    After correction   : ${toRupees(walletTotalPaise + totalDeltaPaise)}`,
		);
		console.log(
			`    Net δ              : +${toRupees(totalDeltaPaise)}  (recovered from over-forfeiture)`,
		);

		if (!EXECUTE) {
			console.log(
				"\n[redateEarnings] DRY-RUN complete — no writes. Pass --execute to apply.\n",
			);
			return;
		}

		// ── 7. Pre-write race guard — re-check released accrual count ────────────
		const { rows: raceRows } = await pool.query<{ released: string }>(
			`SELECT COUNT(*) AS released FROM pair_accruals WHERE status='released'`,
		);
		const releasedNow = BigInt(raceRows[0].released);
		if (releasedNow !== releasedSnapshot) {
			console.error(
				`\n[redateEarnings] ABORT: released accrual count changed from ${releasedSnapshot} to ${releasedNow}.\n` +
					"  Workers are still active. Stop avg-workers, let the pipeline fully quiesce, then re-run.",
			);
			process.exit(1);
		}
		console.log(
			`\n[redateEarnings] ✓ Released count stable (${releasedNow}). Proceeding with writes.\n`,
		);

		// ── 8. Fetch bonus_forfeited system account id dynamically ─────────────
		const { rows: bfRows } = await pool.query<{ id: string }>(
			`SELECT id FROM accounts WHERE owner_type='system' AND kind='bonus_forfeited'`,
		);
		if (!bfRows[0]) {
			console.error(
				"[redateEarnings] ABORT: no bonus_forfeited system account found.",
			);
			process.exit(1);
		}
		const bonusForfeitedAccId = BigInt(bfRows[0].id);

		// ── 9. Per-member atomic transactions (Operation A + optional B) ─────────
		let processed = 0;
		let topUps = 0;
		process.stdout.write("[redateEarnings] Writing");
		for (const d of diffs) {
			const client = await pool.connect();
			try {
				await client.query("BEGIN");

				// Operation A: delete current cutoff_earnings, insert correct rows
				await client.query(
					"DELETE FROM cutoff_earnings WHERE member_id=$1",
					[d.memberId],
				);
				for (const r of d.newCeRows) {
					await client.query(
						`INSERT INTO cutoff_earnings (member_id, cutoff_id, earned) VALUES ($1,$2,$3)`,
						[d.memberId, r.cutoffId, fromPaise(r.netPaise)],
					);
				}

				// Operation B: top-up wallet for over-capped members only
				if (d.deltaPaise > 0n) {
					const posted = await postLedgerTxn(
						client,
						`redate-correction:${d.memberId}`,
						"correction",
						null,
						[
							{
								accountId: bonusForfeitedAccId,
								direction: "D",
								amountPaise: d.deltaPaise,
							},
							{
								accountId: d.walletAccId,
								direction: "C",
								amountPaise: d.deltaPaise,
							},
						],
					);
					if (posted) topUps++;
					// if !posted: idempotent re-run, ledger already written — cutoff_earnings still updated above
				}

				await client.query("COMMIT");
				processed++;
				process.stdout.write(".");
			} catch (err) {
				await client.query("ROLLBACK");
				console.error(
					`\n[redateEarnings] ERROR on ${d.memberCode}: ${(err as Error).message}`,
				);
				throw err;
			} finally {
				client.release();
			}
		}
		console.log(
			`\n[redateEarnings] ${processed}/${diffs.length} members processed, ${topUps} wallet top-up(s) posted.\n`,
		);

		// ── 10. Post-write verification ───────────────────────────────────────────
		const { rows: verRows } = await pool.query<{
			cutoff_earned_rupees: string;
			wallet_total_rupees: string;
		}>(`
      SELECT
        (SELECT COALESCE(SUM(earned),0) FROM cutoff_earnings)::text      AS cutoff_earned_rupees,
        (SELECT COALESCE(SUM(wb.balance),0)
           FROM wallet_balances wb JOIN accounts a ON a.id=wb.account_id
          WHERE a.kind='wallet')::text                                    AS wallet_total_rupees
    `);
		const afterCePaise = toPaise(verRows[0].cutoff_earned_rupees);
		const afterWalletPaise = toPaise(verRows[0].wallet_total_rupees);
		const invariantHolds = afterCePaise === afterWalletPaise;

		console.log("── Post-write verification ───────────────────────────────────────");
		console.log(
			`  cutoff_earnings total   : ${toRupees(afterCePaise)}  (was ${toRupees(cutoffEarnedPaise)})`,
		);
		console.log(
			`  wallet total            : ${toRupees(afterWalletPaise)}  (was ${toRupees(walletTotalPaise)})`,
		);
		console.log(
			`  Invariant (CE == wallet): ${invariantHolds ? "✅ PASS" : "❌ FAIL"}`,
		);

		// Spot-check capped members
		for (const d of cappedMembers) {
			const { rows: spotRows } = await pool.query<{
				earned_sum: string;
				wallet_balance: string;
			}>(
				`SELECT
           (SELECT COALESCE(SUM(earned),0) FROM cutoff_earnings WHERE member_id=$1)::text AS earned_sum,
           (SELECT wb.balance FROM wallet_balances wb
              JOIN accounts a ON a.id=wb.account_id
             WHERE a.owner_id=$1 AND a.kind='wallet')::text                               AS wallet_balance`,
				[d.memberId],
			);
			const spot = spotRows[0];
			const earnedPaise = toPaise(spot.earned_sum);
			const walletPaise = toPaise(spot.wallet_balance);
			const ok =
				earnedPaise === walletPaise && earnedPaise === d.correctTotalPaise;
			console.log(
				`  ${d.memberCode}: cutoff_earnings=${toRupees(earnedPaise)}  wallet=${toRupees(walletPaise)}  expected=${toRupees(d.correctTotalPaise)}  ${ok ? "✅" : "❌ MISMATCH"}`,
			);
		}

		if (!invariantHolds) {
			console.error(
				"\n[redateEarnings] CRITICAL: CE==wallet invariant failed after write. Investigate immediately.",
			);
			process.exit(1);
		}

		console.log(
			"\n[redateEarnings] ✅ Done. Next steps:",
		);
		console.log(
			"  1. Run `PROD_DATABASE_URL=... npm run report:weekly` — W2 should now show ₹6,75,000-class figure.",
		);
		console.log(
			"  2. Check admin 'last week' endpoint in Network tab (not just the rendered number).",
		);
		console.log(
			"  3. Restart avg-workers when ready.\n",
		);
	} finally {
		await pool.end();
	}
}

main().catch((err) => {
	console.error("[redateEarnings] fatal:", err);
	process.exit(1);
});
