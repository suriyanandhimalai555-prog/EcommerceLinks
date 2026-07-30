/**
 * writebackV2Balances.ts — apply v2 income model corrections to production.
 *
 * Intended to run via:
 *   DATABASE_URL=<prod> REDIS_URL=<prod> npx tsx scripts/writebackV2Balances.ts --i-know [--execute]
 *
 * What it does (--execute mode):
 *   Phase 0  Apply migration 038 if not already applied (drops uq_pairs_one_per_member,
 *            adds idx_pairs_member_seq — required for multiple pairs per member).
 *   Phase 1  Wipe money layer in a single transaction:
 *              DELETE ledger_entries, ledger_txns, pair_accruals, pairs, cutoff_earnings
 *              UPDATE wallet_balances SET balance=0
 *              UPDATE member_counters SET pairs_matched=0
 *              DELETE FROM processed_events WHERE consumer_group IN (avg-ledger, avg-counter-pair)
 *   Phase 2  Flush Redis streams avg.ledger.commands and avg.counter.increments
 *            so stale messages cannot replay over the rebuilt data.
 *   Phase 3  Rebuild the money layer in ONE bulk transaction (set-based, ~11 round-trips):
 *              Bulk INSERT pairs from leg_activations spine (self-join L↔R)
 *              Bulk UPDATE member_counters.pairs_matched
 *              Bulk INSERT pair_accruals (one per pair, beneficiary = matching node)
 *              Ensure cutoff_earnings rows for qualified members
 *              Compute per-accrual cap split in JS (row_number rank × ₹1000)
 *              Bulk INSERT ledger_txns + ledger_entries (D expense / C wallet / C forfeited)
 *              Bulk UPDATE wallet_balances + cutoff_earnings
 *              Bulk UPDATE pair_accruals → released
 *
 * Without --execute: dry-run — reads only, prints per-member plan and totals.
 *
 * Safety guards:
 *   --i-know        required when DATABASE_URL contains 'hayabusa' (production host)
 *   --execute       required to apply any writes
 *   Preconditions   zero withdrawals, open cutoff, system accounts present,
 *                   all qualified members have wallet_balances rows
 *   Workers MUST be stopped before running (can't be checked programmatically)
 *
 * Cap note: CUTOFF_CAP_PAISE default 10_000_000 paise = ₹1,00,000 = 100 pairs.
 *   Members with >100 matchable pairs: up to ₹1,00,000 to wallet, excess forfeited.
 *   Two such members on production: AVG100001 (192 pairs) and AVG100003 (106 pairs).
 *
 * Re-runnable: Phase 1 re-wipes cleanly; ON CONFLICT DO NOTHING in Phase 3 is safe to repeat.
 *   Interrupted after Phase 1 → re-run re-wipes the partial state and rebuilds from scratch.
 */

import pg from "pg";
import { Redis } from "ioredis";
import { v5 as uuidv5 } from "uuid";

// Mirrors the NAMESPACE constant in lib/ids.ts — must stay identical.
const UUID_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
function txnUuid(key: string): string {
	return uuidv5(key, UUID_NAMESPACE);
}

// ── constants ─────────────────────────────────────────────────────────────────
const PAIR_BONUS_PAISE = BigInt(
	parseInt(process.env.PAIR_BONUS_PAISE ?? "100000", 10),
); // ₹1000
const CUTOFF_CAP_PAISE = BigInt(
	parseInt(process.env.CUTOFF_CAP_PAISE ?? "10000000", 10),
); // ₹1,00,000

const STREAM_LEDGER = "avg.ledger.commands";
const STREAM_COUNTER = "avg.counter.increments";
const GROUP_LEDGER = "avg-ledger";
const GROUP_COUNTER = "avg-counter-pair";

// ── money helpers (mirrors lib/money.ts — no module import to avoid side effects) ──
function fromPaise(p: bigint): string {
	return (Number(p) / 100).toFixed(2);
}
function toPaise(rupees: string | number): bigint {
	return BigInt(Math.round(Number(rupees) * 100));
}

// ── arg parsing ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const I_KNOW = args.includes("--i-know");

// ── main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
	const dbUrl = process.env.DATABASE_URL;
	const redisUrl = process.env.REDIS_URL;

	if (!dbUrl) {
		console.error(
			"[writebackV2Balances] DATABASE_URL is required.\n" +
				"  Run via: DATABASE_URL=<prod> REDIS_URL=<prod> npx tsx scripts/writebackV2Balances.ts --i-know [--execute]",
		);
		process.exit(1);
	}

	// Production host guard
	const isProd = dbUrl.includes("hayabusa");
	if (isProd && !I_KNOW) {
		console.error(
			"[writebackV2Balances] DATABASE_URL points at production (hayabusa).\n" +
				"  Pass --i-know if you have taken a Railway backup and stopped the workers.",
		);
		process.exit(1);
	}

	console.log(`
══════════════════════════════════════════════════════════════
  writebackV2Balances — v2 income model correction
  Target: ${isProd ? "PRODUCTION (hayabusa)" : "dev copy (tokaido)"}
  Mode:   ${EXECUTE ? "EXECUTE (writes WILL be applied)" : "DRY-RUN (read only)"}
══════════════════════════════════════════════════════════════`);

	if (EXECUTE && isProd) {
		console.log(`
  ⚠  WORKERS MUST BE STOPPED before proceeding.
     If you have not stopped avg-workers in Railway, Ctrl-C now.
     Sleeping 10 seconds…`);
		await new Promise((r) => setTimeout(r, 10_000));
	}

	const client = new pg.Client({ connectionString: dbUrl });
	await client.connect();

	try {
		// ── preconditions ───────────────────────────────────────────────────────
		const { rows: wdRows } = await client.query<{ status: string; cnt: string }>(
			`SELECT status, count(*) AS cnt FROM withdrawals
        WHERE status IN ('paid','approved','requested')
        GROUP BY status`,
		);
		if (wdRows.length > 0) {
			console.error(
				"[ABORT] Withdrawals in live/paid status detected — cannot safely rebuild:\n" +
					JSON.stringify(wdRows, null, 2),
			);
			process.exit(1);
		}
		console.log("  ✓ Withdrawals: 0 paid/approved/requested");

		const { rows: cutoffRows } = await client.query<{ id: string }>(
			"SELECT id FROM cutoffs WHERE status='open' LIMIT 1",
		);
		if (!cutoffRows[0]) {
			console.error(
				"[ABORT] No open cutoff window. Run `npm run seed` (dev) or ensure the cutoff worker has created one.",
			);
			process.exit(1);
		}
		console.log(`  ✓ Open cutoff: id=${cutoffRows[0].id}`);

		const { rows: sysCheck } = await client.query<{ kind: string }>(
			`SELECT kind FROM accounts
        WHERE owner_type='system' AND kind IN ('bonus_expense','bonus_forfeited')`,
		);
		const kinds = sysCheck.map((r) => r.kind);
		if (!kinds.includes("bonus_expense") || !kinds.includes("bonus_forfeited")) {
			console.error(
				"[ABORT] System accounts missing: " +
					JSON.stringify(kinds) +
					". Run `npm run seed` to create them.",
			);
			process.exit(1);
		}
		console.log("  ✓ System accounts: bonus_expense, bonus_forfeited present");

		// ── compute rebuild plan from durable inputs ────────────────────────────
		const { rows: members } = await client.query<{
			member_id: string;
			member_code: string;
			name: string;
			is_active: boolean;
			is_qualified: boolean;
			left_active: string;
			right_active: string;
		}>(
			`SELECT m.id AS member_id, m.member_code, m.name, m.is_active, m.is_qualified,
              mc.left_active, mc.right_active
         FROM members m JOIN member_counters mc ON mc.member_id = m.id
        WHERE m.role <> 'management'
        ORDER BY m.id`,
		);

		let totalPairs = 0n;
		let totalWallet = 0n;
		let totalPending = 0n;
		let overCapCount = 0;
		let membersWithPairs = 0;

		console.log("\n  Per-member rebuild plan:");
		console.log(
			"  member_code | matchable | v2_wallet_rupees | held_pending | over_cap",
		);
		console.log("  " + "─".repeat(70));

		const buildPlan = members.map((m) => {
			const matchable = BigInt(Math.min(
				parseInt(m.left_active),
				parseInt(m.right_active),
			));
			const gross = matchable * PAIR_BONUS_PAISE;
			const qualified = m.is_qualified;
			const overCap = gross > CUTOFF_CAP_PAISE;
			const walletAmt = qualified ? gross : 0n;
			const pendingAmt = qualified ? 0n : gross;

			if (matchable > 0n) {
				membersWithPairs++;
				totalPairs += matchable;
				totalWallet += walletAmt;
				totalPending += pendingAmt;
				if (overCap) overCapCount++;
				console.log(
					`  ${m.member_code.padEnd(12)} | ${String(matchable).padStart(9)} |` +
						` ${("₹" + (Number(walletAmt) / 100).toFixed(2)).padStart(16)} |` +
						` ${("₹" + (Number(pendingAmt) / 100).toFixed(2)).padStart(12)} |` +
						` ${overCap ? "⚠ YES" : "no"}`,
				);
			}

			return {
				memberId: BigInt(m.member_id),
				memberCode: m.member_code,
				name: m.name,
				matchable,
				qualified,
				overCap,
			};
		});

		const filtered = buildPlan.filter((m) => m.matchable > 0n);

		console.log(`
  Summary:
    Members with matchable pairs : ${membersWithPairs}
    Total matchable pairs         : ${totalPairs}
    Total v2 wallet (qualified)   : ₹${(Number(totalWallet) / 100).toFixed(2)}
    Total held pending            : ₹${(Number(totalPending) / 100).toFixed(2)}
    Over-cap members              : ${overCapCount} (gross capped at ₹1,00,000; excess forfeited)`);

		if (!EXECUTE) {
			console.log(`
  DRY-RUN complete. No changes made.
  To apply: DATABASE_URL=<prod> REDIS_URL=<prod> npx tsx scripts/writebackV2Balances.ts --i-know --execute
══════════════════════════════════════════════════════════════`);
			return;
		}

		// ═══════════════════════════════════════════════════════════════
		// PHASE 0: Apply migration 038 if not already applied
		// ═══════════════════════════════════════════════════════════════
		console.log("\n  Phase 0: Checking migration 038…");
		const { rows: m038 } = await client.query(
			"SELECT 1 FROM schema_migrations WHERE name='038_multi_pair_carry_forward.sql'",
		);
		if (m038.length > 0) {
			console.log("  ✓ Migration 038 already applied — skipping");
		} else {
			console.log("  Applying migration 038 (DROP INDEX uq_pairs_one_per_member…)");
			await client.query("BEGIN");
			try {
				await client.query("DROP INDEX IF EXISTS uq_pairs_one_per_member");
				await client.query(
					"CREATE INDEX IF NOT EXISTS idx_pairs_member_seq ON pairs (member_id, sequence_no)",
				);
				await client.query(
					`COMMENT ON COLUMN member_counters.pairs_matched IS
            'Live count of pairs matched at this member node under the carry-forward model. Equal to LEAST(left_active, right_active). Updated by workers/counterPair.ts.'`,
				);
				await client.query(
					"INSERT INTO schema_migrations (name) VALUES ('038_multi_pair_carry_forward.sql')",
				);
				await client.query("COMMIT");
				console.log("  ✓ Migration 038 applied");
			} catch (err) {
				await client.query("ROLLBACK");
				throw err;
			}
		}

		// ═══════════════════════════════════════════════════════════════
		// PHASE 1: Wipe the money layer (single atomic transaction)
		// ═══════════════════════════════════════════════════════════════
		console.log("\n  Phase 1: Wiping money layer…");
		await client.query("BEGIN");
		try {
			await client.query("DELETE FROM ledger_entries");
			await client.query("DELETE FROM ledger_txns");
			await client.query("DELETE FROM pair_accruals");
			await client.query("DELETE FROM pairs");
			await client.query("DELETE FROM cutoff_earnings");
			await client.query(
				"UPDATE wallet_balances SET balance = 0.00, updated_at = now()",
			);
			await client.query("UPDATE member_counters SET pairs_matched = 0");
			await client.query(
				`DELETE FROM processed_events
          WHERE consumer_group IN ($1,$2)`,
				[GROUP_LEDGER, GROUP_COUNTER],
			);
			await client.query("COMMIT");
			console.log("  ✓ Money layer wiped");
		} catch (err) {
			await client.query("ROLLBACK");
			throw err;
		}

		// ═══════════════════════════════════════════════════════════════
		// PHASE 2: Flush Redis streams
		// ═══════════════════════════════════════════════════════════════
		console.log("\n  Phase 2: Flushing Redis streams…");
		if (redisUrl) {
			const redis = new Redis(redisUrl, { lazyConnect: true });
			await redis.connect();
			try {
				const del = await redis.del(STREAM_LEDGER, STREAM_COUNTER);
				console.log(
					`  ✓ Deleted ${del} Redis stream(s): ${STREAM_LEDGER}, ${STREAM_COUNTER}`,
				);
			} finally {
				await redis.quit();
			}
		} else {
			console.log(
				"  ⚠ REDIS_URL not set — skipping Redis flush. Ensure workers are stopped.",
			);
		}

		// ═══════════════════════════════════════════════════════════════
		// PHASE 3: Rebuild the money layer (set-based, one transaction)
		//
		// ~11 round-trips total regardless of member/pair count.
		// Replaces the old per-member/per-pair loop (~14,000 round-trips on prod).
		// ═══════════════════════════════════════════════════════════════
		console.log(
			`\n  Phase 3: Rebuilding ${filtered.length} member(s) — set-based, single transaction…`,
		);

		const openCutoffId = BigInt(cutoffRows[0].id);

		// Precondition: every qualified member must have a wallet_balances row.
		// A missing row causes wallet UPDATE ... WHERE account_id = ? to silently no-op (lost money).
		const { rows: missingWbCheck } = await client.query<{
			member_id: string;
			member_code: string;
		}>(
			`SELECT m.id AS member_id, m.member_code
			 FROM members m
			 WHERE m.is_qualified AND m.role <> 'management'
			   AND NOT EXISTS (
			     SELECT 1 FROM wallet_balances wb
			     JOIN accounts a ON a.id = wb.account_id
			     WHERE a.owner_id = m.id AND a.kind = 'wallet'
			   )
			 LIMIT 5`,
		);
		if (missingWbCheck.length > 0) {
			console.error(
				"[ABORT] Qualified member(s) missing wallet_balances row — cannot safely update wallets:",
				missingWbCheck,
			);
			process.exit(1);
		}
		console.log("  ✓ All qualified members have wallet_balances rows");

		// Fetch system account ids (presence already verified in preconditions)
		const { rows: sysAccBulk } = await client.query<{ id: string; kind: string }>(
			`SELECT id, kind FROM accounts
			 WHERE owner_type = 'system' AND kind IN ('bonus_expense', 'bonus_forfeited')`,
		);
		const expenseAccId = BigInt(sysAccBulk.find((a) => a.kind === "bonus_expense")!.id);
		const forfeitedAccId = BigInt(sysAccBulk.find((a) => a.kind === "bonus_forfeited")!.id);

		// Fetch all wallet account ids once (one round-trip → replaces per-accrual SELECT)
		const { rows: walletAccRows } = await client.query<{ owner_id: string; id: string }>(
			`SELECT owner_id, id FROM accounts WHERE kind = 'wallet'`,
		);
		const walletAccMap = new Map(walletAccRows.map((r) => [r.owner_id, BigInt(r.id)]));

		await client.query("BEGIN");
		try {
			// ── Step 1: Bulk INSERT pairs ───────────────────────────────────────
			// Self-join leg_activations L↔R on equal seq, capped at LEAST(left_active, right_active).
			const { rowCount: pairsInserted } = await client.query(
				`INSERT INTO pairs (member_id, sequence_no, left_member_id, right_member_id, bonus_amount)
				 SELECT l.ancestor_id, l.seq, l.member_id, r.member_id, $1::numeric
				 FROM leg_activations l
				 JOIN leg_activations r
				   ON r.ancestor_id = l.ancestor_id AND r.side = 'R' AND r.seq = l.seq
				 JOIN member_counters mc ON mc.member_id = l.ancestor_id
				 JOIN members m ON m.id = l.ancestor_id AND m.role <> 'management'
				 WHERE l.side = 'L'
				   AND l.seq <= LEAST(mc.left_active, mc.right_active)
				 ON CONFLICT (member_id, sequence_no) DO NOTHING`,
				[fromPaise(PAIR_BONUS_PAISE)],
			);
			console.log(`  ✓ Step 1 — pairs inserted: ${pairsInserted ?? 0}`);

			// ── Step 2: Bulk UPDATE pairs_matched ──────────────────────────────
			await client.query(
				`UPDATE member_counters mc
				 SET pairs_matched = LEAST(mc.left_active, mc.right_active)
				 FROM members m
				 WHERE m.id = mc.member_id AND m.role <> 'management'`,
			);
			console.log("  ✓ Step 2 — pairs_matched updated");

			// ── Step 3: Bulk INSERT pair_accruals ──────────────────────────────
			// One accrual per pair; beneficiary = the matching node (BR-7).
			const { rowCount: accrualInserted } = await client.query(
				`INSERT INTO pair_accruals (pair_id, beneficiary_id, amount)
				 SELECT p.id, p.member_id, $1::numeric FROM pairs p
				 ON CONFLICT (pair_id, beneficiary_id) DO NOTHING`,
				[fromPaise(PAIR_BONUS_PAISE)],
			);
			console.log(`  ✓ Step 3 — pair_accruals inserted: ${accrualInserted ?? 0}`);

			// ── Step 4: Ensure cutoff_earnings rows for qualified members ───────
			await client.query(
				`INSERT INTO cutoff_earnings (member_id, cutoff_id)
				 SELECT m.id, $1 FROM members m
				 WHERE m.is_qualified AND m.role <> 'management'
				 ON CONFLICT DO NOTHING`,
				[openCutoffId.toString()],
			);
			console.log("  ✓ Step 4 — cutoff_earnings rows ensured");

			// ── Step 5: Fetch qualified pending accruals with per-beneficiary rank
			// row_number() OVER (PARTITION BY beneficiary ORDER BY id) gives the position
			// within the member's sequence. Since every accrual is an identical ₹1000,
			// earnedBefore = (rn-1) × PAIR_BONUS_PAISE — no need to re-query cutoff_earnings
			// for each accrual. This preserves byte-equivalence with the old per-accrual loop.
			const { rows: accrualRows } = await client.query<{
				id: string;
				pair_id: string;
				beneficiary_id: string;
				rn: string;
			}>(
				`SELECT pa.id, pa.pair_id, pa.beneficiary_id,
				        row_number() OVER (PARTITION BY pa.beneficiary_id ORDER BY pa.id) AS rn
				 FROM pair_accruals pa
				 JOIN members m ON m.id = pa.beneficiary_id
				 WHERE m.is_qualified AND pa.status = 'pending'
				 ORDER BY pa.beneficiary_id, pa.id`,
			);
			console.log(`  ✓ Step 5 — qualified pending accruals to release: ${accrualRows.length}`);

			if (accrualRows.length > 0) {
				// ── Build bulk arrays in JS (one pass, zero extra round-trips) ────────

				// ledger_txns arrays
				const txnIds: string[] = [];
				const idemKeys: string[] = [];
				const refIds: string[] = []; // pair_accruals.id (reference_id)

				// D legs: bonus_expense (always present, always ₹1000)
				const debitTxnIds: string[] = [];
				const debitAmts: string[] = [];

				// C legs: member wallet (only where walletAmt > 0)
				const walletLegTxnIds: string[] = [];
				const walletLegAccIds: string[] = [];
				const walletLegAmts: string[] = [];

				// C legs: bonus_forfeited (only where overflow > 0)
				const forfeitLegTxnIds: string[] = [];
				const forfeitLegAmts: string[] = [];

				// Aggregates for bulk UPDATE (summed per beneficiary)
				const walletBalMap = new Map<string, bigint>(); // beneficiary_id → Σ walletAmt paise
				const ceMap = new Map<string, bigint>();         // beneficiary_id → Σ walletAmt paise

				for (const row of accrualRows) {
					const rn = BigInt(row.rn);
					// earnedBefore = amount already credited to this member's wallet in prior accruals.
					// Since all accruals are ₹1000, this is simply (rn-1) × PAIR_BONUS_PAISE.
					const earnedBefore = (rn - 1n) * PAIR_BONUS_PAISE;
					const headroom = CUTOFF_CAP_PAISE - earnedBefore;
					// splitAgainstCap logic (mirrors workers/ledger.ts)
					const walletAmt =
						PAIR_BONUS_PAISE < headroom
							? PAIR_BONUS_PAISE
							: headroom > 0n
								? headroom
								: 0n;
					const overflow = PAIR_BONUS_PAISE - walletAmt;

					const idemKey = `pairbonus:${row.pair_id}:${row.beneficiary_id}`;
					const txnId = txnUuid(idemKey);

					txnIds.push(txnId);
					idemKeys.push(idemKey);
					refIds.push(row.id);

					// D leg (always — bonus_expense debited ₹1000 per pair)
					debitTxnIds.push(txnId);
					debitAmts.push(fromPaise(PAIR_BONUS_PAISE));

					// C wallet leg (only if walletAmt > 0; skip zero so no amount=0 rows)
					if (walletAmt > 0n) {
						const walletAccId = walletAccMap.get(row.beneficiary_id);
						if (!walletAccId) {
							throw new Error(
								`No wallet account found for beneficiary ${row.beneficiary_id} — precondition check should have caught this`,
							);
						}
						walletLegTxnIds.push(txnId);
						walletLegAccIds.push(walletAccId.toString());
						walletLegAmts.push(fromPaise(walletAmt));

						walletBalMap.set(
							row.beneficiary_id,
							(walletBalMap.get(row.beneficiary_id) ?? 0n) + walletAmt,
						);
						ceMap.set(
							row.beneficiary_id,
							(ceMap.get(row.beneficiary_id) ?? 0n) + walletAmt,
						);
					}

					// C forfeited leg (only if overflow > 0; skip zero)
					if (overflow > 0n) {
						forfeitLegTxnIds.push(txnId);
						forfeitLegAmts.push(fromPaise(overflow));
					}
				}

				// ── Step 7: Bulk INSERT ledger_txns ───────────────────────────────
				// One txn per accrual; idempotency_key = 'pairbonus:{pair_id}:{beneficiary_id}'.
				await client.query(
					`INSERT INTO ledger_txns (txn_id, idempotency_key, reference_type, reference_id)
					 SELECT unnest($1::uuid[]), unnest($2::text[]), 'pair', unnest($3::bigint[])`,
					[txnIds, idemKeys, refIds],
				);
				console.log(`  ✓ Step 7 — ledger_txns inserted: ${txnIds.length}`);

				// ── Step 8a: Bulk INSERT D-legs (bonus_expense debit, always ₹1000) ──
				await client.query(
					`INSERT INTO ledger_entries (txn_id, account_id, direction, amount)
					 SELECT unnest($1::uuid[]), $2::bigint, 'D', unnest($3::numeric[])`,
					[debitTxnIds, expenseAccId.toString(), debitAmts],
				);
				console.log(`  ✓ Step 8a — D-legs inserted: ${debitTxnIds.length}`);

				// ── Step 8b: Bulk INSERT C wallet legs ─────────────────────────────
				if (walletLegTxnIds.length > 0) {
					await client.query(
						`INSERT INTO ledger_entries (txn_id, account_id, direction, amount)
						 SELECT unnest($1::uuid[]), unnest($2::bigint[]), 'C', unnest($3::numeric[])`,
						[walletLegTxnIds, walletLegAccIds, walletLegAmts],
					);
					console.log(`  ✓ Step 8b — C-wallet legs inserted: ${walletLegTxnIds.length}`);
				}

				// ── Step 8c: Bulk INSERT C forfeited legs ──────────────────────────
				if (forfeitLegTxnIds.length > 0) {
					await client.query(
						`INSERT INTO ledger_entries (txn_id, account_id, direction, amount)
						 SELECT unnest($1::uuid[]), $2::bigint, 'C', unnest($3::numeric[])`,
						[forfeitLegTxnIds, forfeitedAccId.toString(), forfeitLegAmts],
					);
					console.log(`  ✓ Step 8c — C-forfeited legs inserted: ${forfeitLegTxnIds.length}`);
				}

				// ── Step 9: Bulk UPDATE wallet_balances (member wallet accounts only) ──
				// system bonus_expense and bonus_forfeited accounts do NOT have wallet_balances rows.
				if (walletBalMap.size > 0) {
					const wbOwnerIds = Array.from(walletBalMap.keys());
					const wbAmts = wbOwnerIds.map((id) => fromPaise(walletBalMap.get(id)!));
					await client.query(
						`UPDATE wallet_balances wb
						 SET balance = balance + v.amt::numeric, updated_at = now()
						 FROM (
						   SELECT unnest($1::bigint[]) AS owner_id,
						          unnest($2::numeric[]) AS amt
						 ) v
						 JOIN accounts a ON a.owner_id = v.owner_id AND a.kind = 'wallet'
						 WHERE wb.account_id = a.id`,
						[wbOwnerIds, wbAmts],
					);
					console.log(`  ✓ Step 9 — wallet_balances updated: ${walletBalMap.size} member(s)`);
				}

				// ── Step 10: Bulk UPDATE cutoff_earnings ──────────────────────────
				// Each member's earned amount = Σ walletAmt ≤ CUTOFF_CAP (satisfies chk_cap).
				if (ceMap.size > 0) {
					const ceMemberIds = Array.from(ceMap.keys());
					const ceAmts = ceMemberIds.map((id) => fromPaise(ceMap.get(id)!));
					await client.query(
						`UPDATE cutoff_earnings ce
						 SET earned = earned + v.amt::numeric
						 FROM (
						   SELECT unnest($1::bigint[]) AS member_id,
						          unnest($2::numeric[]) AS amt
						 ) v
						 WHERE ce.member_id = v.member_id AND ce.cutoff_id = $3`,
						[ceMemberIds, ceAmts, openCutoffId.toString()],
					);
					console.log(`  ✓ Step 10 — cutoff_earnings updated: ${ceMap.size} member(s)`);
				}

				// ── Step 11: Mark qualified pending accruals as released ──────────
				const { rowCount: releasedCount } = await client.query(
					`UPDATE pair_accruals pa
					 SET status = 'released', released_at = now()
					 FROM members m
					 WHERE m.id = pa.beneficiary_id
					   AND m.is_qualified
					   AND pa.status = 'pending'`,
				);
				console.log(`  ✓ Step 11 — pair_accruals released: ${releasedCount ?? 0}`);
			}

			await client.query("COMMIT");
			console.log("  ✓ Phase 3 committed (single transaction)");
		} catch (err) {
			await client.query("ROLLBACK").catch(() => null);
			throw err;
		}

		// ── final summary ────────────────────────────────────────────────────────
		const { rows: walletTotals } = await client.query<{
			wallet_total: string;
			wallets_nonzero: string;
		}>(
			`SELECT count(*) FILTER (WHERE wb.balance > 0) AS wallets_nonzero,
			        SUM(wb.balance) AS wallet_total
			 FROM wallet_balances wb
			 JOIN accounts a ON a.id = wb.account_id
			 WHERE a.kind = 'wallet'`,
		);

		const { rows: accrualTotals } = await client.query<{
			status: string;
			cnt: string;
		}>(
			"SELECT status, count(*) AS cnt FROM pair_accruals GROUP BY status ORDER BY status",
		);

		const { rows: pairTotals } = await client.query<{ total_pairs: string }>(
			"SELECT count(*) AS total_pairs FROM pairs",
		);

		const { rows: ledgerCheck } = await client.query<{ txns: string; entries: string }>(
			`SELECT count(DISTINCT txn_id) AS txns,
			        count(*) AS entries
			 FROM ledger_entries`,
		);

		console.log(`
  ═══════════════════════════════════════════
  Phase 3 complete (set-based)
  Total pairs         : ${pairTotals[0]?.total_pairs ?? 0}
  Wallet total (DB)   : ₹${Number(walletTotals[0]?.wallet_total ?? 0).toFixed(2)}
  Wallets non-zero    : ${walletTotals[0]?.wallets_nonzero ?? 0}
  Accrual status      : ${accrualTotals.map((r) => `${r.status}=${r.cnt}`).join(", ")}
  Ledger txns/entries : ${ledgerCheck[0]?.txns ?? 0} txns / ${ledgerCheck[0]?.entries ?? 0} entries
  ═══════════════════════════════════════════

  ✓ Writeback complete.

  NEXT STEPS (do not skip):
  1. Run the reconciler — must show 0 alerts before restarting workers:
       DATABASE_URL=<prod> npx tsx scripts/runReconcile.ts
  2. Run the v2 balance report to confirm wallet totals:
       PROD_DATABASE_URL=<prod> npx tsx scripts/reportV2Balances.ts
  3. ONLY after 0 reconciler alerts: restart the avg-workers Railway service.
══════════════════════════════════════════════════════════════`);
	} finally {
		await client.end();
	}
}

main().catch((err) => {
	console.error("[writebackV2Balances] fatal:", err);
	process.exit(1);
});
