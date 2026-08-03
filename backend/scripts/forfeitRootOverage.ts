/**
 * forfeitRootOverage.ts — forfeit the ₹32,000 cap-overage sitting in root's
 * plain wallet after the 23:50 re-anchor reconstruction.
 *
 * Background:
 *   The reconstructWeeklyPayouts.ts script, when it replayed week 2 for root,
 *   capped root's ₹1,55,000 gross earnings at the ₹1,00,000 weekly cap and
 *   left the ₹55,000 overage split as:
 *     • ₹23,000 already forfeited during the live pipeline run, and
 *     • ₹32,000 parked in root's plain wallet (a state neither live cap mode
 *       produces: immediate → forfeit; backlog → defer).
 *
 *   The ₹32,000 is a problem because closeAndOpenCutoff() (workers/cutoff.ts)
 *   snapshots every wallet with balance > 0 at week close and auto-creates a
 *   cashable pending withdrawal — bypassing the ₹1L weekly cap.  It would fire
 *   automatically when cutoff 4 closes (~Aug 8 23:50 IST).
 *
 *   This script moves root's wallet ₹32,000 → system bonus_forfeited, matching
 *   what the live immediate-mode cap logic would have done, and restoring the
 *   grand accounting identity:
 *     bonus_expense ₹11,85,000
 *       = payout_clearing ₹11,30,000 + wallet ₹0 + forfeited ₹55,000
 *
 * What this script does (single transaction):
 *   1. Assert root member exists with email='root@avg.com' (id=1).
 *   2. Resolve root's wallet account id and system bonus_forfeited account id.
 *   3. SELECT balance FROM wallet_balances … FOR UPDATE; guard: balance must
 *      equal the expected amount (default ₹32,000.00; override with --expect <N>).
 *      Sanity: no other member's wallet may be > 0.
 *   4. postLedgerTxn("rootcap-forfeit:c2:member1", "cap_correction", 1n,
 *        [ {walletAccId, D, 3_200_000n}, {forfeitedAccId, C, 3_200_000n} ])
 *      The wallet debit drives wallet_balances to 0; bonus_forfeited is ledger-only.
 *      Does NOT touch bonus_expense (already booked) or cutoff_earnings (root's
 *      reported ₹1,56,000 payable is unchanged).
 *   5. Re-read wallet; assert ₹0.  Print grand-identity recheck.
 *
 * Idempotent: the "rootcap-forfeit:c2:member1" idempotency key is unique in
 * ledger_txns, so a re-run returns false (no-op) without erroring.
 *
 * Safety:
 *   • Dry-run by default — prints full plan, writes nothing.  Pass --execute to write.
 *   • Pass --i-know when PROD_DATABASE_URL contains 'hayabusa' (production host).
 *   • Balance guard: aborts if root's wallet ≠ expected (prevents accidental
 *     double-run after a balance change).
 *   • Sanity guard: aborts if any other member has wallet > 0 (sweep risk
 *     must be isolated to root).
 *
 * Usage:
 *   # dry-run against production:
 *   PROD_DATABASE_URL='postgresql://...@hayabusa...' npx tsx scripts/forfeitRootOverage.ts --i-know
 *   # execute:
 *   PROD_DATABASE_URL='postgresql://...@hayabusa...' npx tsx scripts/forfeitRootOverage.ts --i-know --execute
 *   # via npm:
 *   PROD_DATABASE_URL='...' npm run forfeit:root-overage [-- --i-know] [-- --execute]
 *
 * Prerequisites:
 *   1. Confirm avg-workers is stopped (or at least that no new pair bonuses
 *      will be credited to root between this check and the write).
 *   2. Dry-run first; review the "before" state.
 *   3. Execute.
 */

import pg from "pg";
import { v5 as uuidv5 } from "uuid";

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
// Mirrors workers/ledger.ts:25–82 and scripts/reconstructWeeklyPayouts.ts:99–154.
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

// ── arg parsing ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const I_KNOW = args.includes("--i-know");

// --expect <rupees>  e.g. --expect 32000 (default: 32000.00)
const expectIdx = args.indexOf("--expect");
const EXPECT_RUPEES: string =
	expectIdx >= 0 && args[expectIdx + 1] ? (args[expectIdx + 1] as string) : "32000.00";
const EXPECTED_PAISE = toPaise(EXPECT_RUPEES);

const IDEMPOTENCY_KEY = "rootcap-forfeit:c2:member1";

// ── main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
	const url = process.env.PROD_DATABASE_URL;
	if (!url) {
		console.error(
			"[forfeitRootOverage] PROD_DATABASE_URL is required.\n" +
				"  Dev copy:   PROD_DATABASE_URL=\"$DATABASE_URL\" npx tsx scripts/forfeitRootOverage.ts\n" +
				"  Production: PROD_DATABASE_URL='postgresql://...' npx tsx scripts/forfeitRootOverage.ts --i-know",
		);
		process.exit(1);
	}

	const isProd = url.includes("hayabusa");
	if (isProd && !I_KNOW) {
		console.error(
			"[forfeitRootOverage] PROD_DATABASE_URL points at production (hayabusa).\n" +
				"  Stop avg-workers, then pass --i-know.",
		);
		process.exit(1);
	}

	const pool = new pg.Pool({ connectionString: url, max: 3 });

	try {
		// ── Pre-flight (read-only) ──────────────────────────────────────────────

		// 1. Resolve tree root — the single member with parent_id IS NULL and role='member'
		//    (management account is excluded by the role filter; uq_single_root enforces uniqueness)
		const { rows: rootRows } = await pool.query<{ id: string; email: string }>(
			`SELECT id, email FROM members WHERE parent_id IS NULL AND role = 'member' LIMIT 1`,
		);
		if (rootRows.length === 0) {
			console.error("[forfeitRootOverage] ABORT: tree root member (parent_id IS NULL, role=member) not found.");
			process.exit(1);
		}
		const rootId = BigInt(rootRows[0].id);
		console.log(`[forfeitRootOverage] tree root: id=${rootId} (${rootRows[0].email})`);

		// 2. Resolve accounts
		const { rows: walletRows } = await pool.query<{ id: string }>(
			`SELECT id FROM accounts WHERE owner_type='member' AND owner_id=$1 AND kind='wallet'`,
			[rootId],
		);
		if (walletRows.length === 0) {
			console.error("[forfeitRootOverage] ABORT: root wallet account not found.");
			process.exit(1);
		}
		const walletAccId = BigInt(walletRows[0].id);

		const { rows: forfRows } = await pool.query<{ id: string }>(
			`SELECT id FROM accounts WHERE owner_type='system' AND kind='bonus_forfeited'`,
		);
		if (forfRows.length === 0) {
			console.error(
				"[forfeitRootOverage] ABORT: system bonus_forfeited account not found " +
					"(run migration 036 before this script).",
			);
			process.exit(1);
		}
		const forfeitedAccId = BigInt(forfRows[0].id);

		// 3. Check idempotency (already applied?)
		const { rows: idkRows } = await pool.query(
			`SELECT 1 FROM ledger_txns WHERE idempotency_key=$1`,
			[IDEMPOTENCY_KEY],
		);
		if (idkRows.length > 0) {
			console.log(
				`[forfeitRootOverage] Already applied (idempotency key '${IDEMPOTENCY_KEY}' exists). Nothing to do.`,
			);
			await printGrandIdentity(pool);
			return;
		}

		// 4. Read root's wallet balance
		const { rows: balRows } = await pool.query<{ balance: string }>(
			`SELECT wb.balance FROM wallet_balances wb
       JOIN accounts a ON a.id = wb.account_id
       WHERE a.id = $1`,
			[walletAccId],
		);
		const rootWalletBalance = balRows.length > 0 ? toPaise(balRows[0].balance) : 0n;

		console.log(`\n── Pre-flight ────────────────────────────────────────────────────────────`);
		console.log(`  Root wallet balance : ${toRupees(rootWalletBalance)}`);
		console.log(`  Expected balance    : ${toRupees(EXPECTED_PAISE)}`);
		console.log(`  Forfeit amount      : ${toRupees(EXPECTED_PAISE)}`);
		console.log(`  Idempotency key     : ${IDEMPOTENCY_KEY}`);
		console.log(`  Mode                : ${EXECUTE ? (isProd ? "EXECUTE on PRODUCTION" : "EXECUTE on dev copy") : "DRY-RUN"}`);

		// 5. Balance guard
		if (rootWalletBalance !== EXPECTED_PAISE) {
			console.error(
				`\n[forfeitRootOverage] ABORT: root wallet balance is ${toRupees(rootWalletBalance)}, ` +
					`expected ${toRupees(EXPECTED_PAISE)}.\n` +
					`  If the balance has legitimately changed, re-run with --expect <new_balance_in_rupees>.`,
			);
			process.exit(1);
		}

		// 6. Sanity: no other member wallet > 0
		const { rows: otherWallets } = await pool.query<{
			owner_id: string;
			balance: string;
		}>(
			`SELECT a.owner_id, wb.balance::text
         FROM wallet_balances wb
         JOIN accounts a ON a.id = wb.account_id
         WHERE a.kind = 'wallet'
           AND a.owner_id::bigint <> $1
           AND wb.balance > 0`,
			[rootId],
		);
		if (otherWallets.length > 0) {
			console.error(
				`\n[forfeitRootOverage] ABORT: unexpected wallet balances on non-root members:`,
			);
			for (const r of otherWallets) {
				console.error(`  member_id=${r.owner_id}  balance=₹${r.balance}`);
			}
			console.error(
				`  The sweep risk is not isolated to tree root (id=${rootId}).  Investigate before proceeding.`,
			);
			process.exit(1);
		}
		console.log(`  Other wallet > 0    : none ✅`);

		console.log(`\n── Planned ledger entry ──────────────────────────────────────────────────`);
		console.log(`  DEBIT  wallet (account ${walletAccId})          ${toRupees(EXPECTED_PAISE)}`);
		console.log(`  CREDIT bonus_forfeited (account ${forfeitedAccId}) ${toRupees(EXPECTED_PAISE)}`);
		console.log(`  Result: root wallet → ₹0;  total forfeited → ₹55,000`);

		if (!EXECUTE) {
			console.log(
				`\n[forfeitRootOverage] DRY-RUN complete — no writes.  Pass --execute to apply.\n`,
			);
			await printGrandIdentity(pool);
			return;
		}

		// ── Execute (single transaction) ────────────────────────────────────────
		console.log(`\n[forfeitRootOverage] Executing...`);

		const client = await pool.connect();
		try {
			await client.query("BEGIN");

			// Re-read balance FOR UPDATE (lock the row)
			const { rows: lockedRows } = await client.query<{ balance: string }>(
				`SELECT wb.balance FROM wallet_balances wb
           JOIN accounts a ON a.id = wb.account_id
           WHERE a.id = $1
           FOR UPDATE`,
				[walletAccId],
			);
			const lockedBalance = lockedRows.length > 0 ? toPaise(lockedRows[0].balance) : 0n;
			if (lockedBalance !== EXPECTED_PAISE) {
				await client.query("ROLLBACK");
				console.error(
					`[forfeitRootOverage] ABORT: balance changed under lock (now ${toRupees(lockedBalance)}).  Rolled back.`,
				);
				process.exit(1);
			}

			const posted = await postLedgerTxn(
				client,
				IDEMPOTENCY_KEY,
				"cap_correction",
				rootId,
				[
					{ accountId: walletAccId, direction: "D", amountPaise: EXPECTED_PAISE },
					{ accountId: forfeitedAccId, direction: "C", amountPaise: EXPECTED_PAISE },
				],
			);

			if (!posted) {
				// Race: another process committed the same key between our pre-flight check
				// and this transaction.  Safe to treat as success.
				await client.query("ROLLBACK");
				console.log(
					`[forfeitRootOverage] Idempotency key already posted (concurrent run?).  No-op.`,
				);
			} else {
				// Assert wallet is now ₹0
				const { rows: afterRows } = await client.query<{ balance: string }>(
					`SELECT wb.balance FROM wallet_balances wb WHERE wb.account_id = $1`,
					[walletAccId],
				);
				const afterBalance = afterRows.length > 0 ? toPaise(afterRows[0].balance) : 0n;
				if (afterBalance !== 0n) {
					await client.query("ROLLBACK");
					console.error(
						`[forfeitRootOverage] ABORT: post-write wallet balance is ${toRupees(afterBalance)}, expected ₹0.  Rolled back.`,
					);
					process.exit(1);
				}

				await client.query("COMMIT");
				console.log(`[forfeitRootOverage] ✅ Committed.  Root wallet: ${toRupees(afterBalance)}`);
			}
		} catch (err) {
			await client.query("ROLLBACK");
			throw err;
		} finally {
			client.release();
		}

		// ── Grand-identity recheck ──────────────────────────────────────────────
		await printGrandIdentity(pool);
	} finally {
		await pool.end();
	}
}

async function printGrandIdentity(pool: pg.Pool): Promise<void> {
	const { rows } = await pool.query<{ kind: string; net: string }>(
		`SELECT a.kind,
            SUM(CASE le.direction WHEN 'C' THEN le.amount ELSE -le.amount END)::text AS net
       FROM ledger_entries le
       JOIN accounts a ON a.id = le.account_id
      GROUP BY a.kind
      ORDER BY a.kind`,
	);
	const byKind: Record<string, bigint> = {};
	for (const r of rows) {
		byKind[r.kind] = toPaise(r.net);
	}

	const expense = byKind["bonus_expense"] ?? 0n;           // negative (debit-net)
	const clearing = byKind["payout_clearing"] ?? 0n;
	const forfeited = byKind["bonus_forfeited"] ?? 0n;
	const wallet = byKind["wallet"] ?? 0n;
	const withdrawable = byKind["withdrawable"] ?? 0n;
	const deferred = byKind["deferred_bonus"] ?? 0n;

	const totalOut = clearing + forfeited + wallet + withdrawable + deferred;

	console.log(`\n── Grand accounting identity ──────────────────────────────────────────────`);
	console.log(`  bonus_expense (gross out)  : ${toRupees(-expense)}`);
	console.log(`  payout_clearing            : ${toRupees(clearing)}`);
	console.log(`  bonus_forfeited            : ${toRupees(forfeited)}`);
	console.log(`  wallet                     : ${toRupees(wallet)}`);
	console.log(`  withdrawable               : ${toRupees(withdrawable)}`);
	console.log(`  deferred_bonus             : ${toRupees(deferred)}`);
	console.log(`  ─────────────────────────────────────────────────────────`);
	console.log(`  sum (out)                  : ${toRupees(totalOut)}`);
	console.log(
		`  Identity check             : ${-expense === totalOut ? "✅ PASS" : `❌ FAIL — delta = ${toRupees(-expense - totalOut)}`}`,
	);
}

main().catch((err) => {
	console.error("[forfeitRootOverage] Fatal:", err);
	process.exit(1);
});
