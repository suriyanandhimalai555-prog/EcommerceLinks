/**
 * reattributeActivationToPrevCutoff.ts — Part 2 of the "forgot to activate before
 * the last payout" fix.
 *
 * CONTEXT
 *   Four members (default AVG100156 AVG100303 AVG100833 AVG100832) paid offline
 *   before the previous cutoff closed, but were never activated.  Management now
 *   activates them via the built-in Record Payment flow (POST /admin/orders/on-behalf),
 *   which runs the real, tested pipeline and credits the resulting pair income to
 *   their UPLINE — but attributes it to the CURRENT open cutoff.
 *
 *   This script moves ONLY that newly-created income from the current open cutoff
 *   back to the previous (already-closed) cutoff, so it is paid as part of the
 *   previous cycle, and bumps each earner's existing PENDING previous-cutoff
 *   withdrawal by the same amount.
 *
 * WHY THIS IS SAFE HERE (verified against production before writing):
 *   • Every affected upline earner already has a *pending* withdrawal for the
 *     previous cutoff → we augment it (UPDATE amount), no insert, no unique-index
 *     conflict, no reversal of a paid row.
 *   • cutoff_earnings(prev) == that pending withdrawal's amount for each earner
 *     (clean 1:1 invariant we preserve).
 *   • Before activation, every affected member has cutoff_earnings(open)=0 and
 *     wallet=0, so the delta produced by activation is trivially isolatable.
 *   • The set of members that activation can possibly affect is bounded to the
 *     4 targets + their placement-path ancestors (activation only touches ancestor
 *     counters / the ancestors' own qualification).  We diff ONLY that set, so
 *     concurrent unrelated pipeline activity cannot pollute the result.
 *
 * MECHANISM per earner E with wallet delta d (= new income landed in E's wallet):
 *   1. Ledger (balanced, idempotency-keyed — mirrors the real sweep):
 *        reattr:c<prev>c<open>:sweep:E   D wallet d / C withdrawable d
 *        reattr:c<prev>c<open>:hold:E    D withdrawable d / C payout_clearing d
 *      → d ends up held in payout_clearing, exactly like the other prev-cutoff
 *        withdrawals; E's wallet returns to 0.
 *   2. cutoff_earnings: earned(E, open) -= d ; earned(E, prev) += d (cap-guarded).
 *   3. withdrawals: existing pending prev-cutoff row → amount += d ; else if
 *        d >= MIN_PAYOUT insert (E, d, 'pending', prevCutoffId).
 *   The grand accounting identity is unchanged (only balanced ledger txns + an
 *   internal cutoff_earnings reclass).
 *
 * IDEMPOTENT: the whole per-member apply is gated on whether
 *   reattr:...:sweep:E already exists in ledger_txns — a re-run skips that member.
 *   (Also, after a successful run the wallet delta is 0, so a re-run is a no-op.)
 *
 * ── WORKFLOW (do these in order) ────────────────────────────────────────────
 *   1. BEFORE activating, capture the baseline (read-only):
 *        PROD_DATABASE_URL='...@hayabusa...' \
 *          npx tsx scripts/reattributeActivationToPrevCutoff.ts --snapshot
 *   2. Management activates the 4 via the Record Payment tab; wait ~1–2 min for
 *      the workers to settle.
 *   3. Dry-run the apply and review the per-earner plan:
 *        PROD_DATABASE_URL='...@hayabusa...' \
 *          npx tsx scripts/reattributeActivationToPrevCutoff.ts --apply --i-know
 *   4. Execute:
 *        PROD_DATABASE_URL='...@hayabusa...' \
 *          npx tsx scripts/reattributeActivationToPrevCutoff.ts --apply --i-know --execute
 *
 * FLAGS
 *   --snapshot            capture baseline JSON, write nothing to the DB (read-only)
 *   --apply               compute + show (dry-run) or perform (--execute) the move
 *   --execute             actually write (only with --apply)
 *   --i-know              required when PROD_DATABASE_URL points at production
 *   --file <path>         baseline JSON path (default scripts/out/reattr-baseline.json)
 *   --codes A,B,C,D       override target member codes (comma-separated)
 */

import pg from "pg";
import { v5 as uuidv5 } from "uuid";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";

// ── id + money helpers (mirror lib/ids.ts + lib/money.ts; kept inline) ────────
const UUID_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const txnUuid = (key: string): string => uuidv5(key, UUID_NAMESPACE);
const fromPaise = (p: bigint): string => (Number(p) / 100).toFixed(2);
const toPaise = (s: string | number): bigint => BigInt(Math.round(Number(s) * 100));
const toRupees = (p: bigint): string =>
	`₹${(Number(p) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;

const MIN_PAYOUT_PAISE = 50000n; // CFG.MIN_PAYOUT_PAISE (₹500)
const CUTOFF_CAP_PAISE = 10000000n; // CFG.CUTOFF_CAP_PAISE (₹1,00,000)

const DEFAULT_CODES = ["AVG100156", "AVG100303", "AVG100833", "AVG100832"];

// ── inline postLedgerTxn (mirrors workers/ledger.ts:25–82) ────────────────────
interface LedgerLeg { accountId: bigint; direction: "D" | "C"; amountPaise: bigint }

async function postLedgerTxn(
	c: pg.PoolClient,
	idempotencyKey: string,
	referenceType: string,
	referenceId: bigint | null,
	legs: LedgerLeg[],
): Promise<boolean> {
	const { rows: existing } = await c.query(
		"SELECT 1 FROM ledger_txns WHERE idempotency_key=$1",
		[idempotencyKey],
	);
	if (existing.length > 0) return false;

	const debit = legs.filter((l) => l.direction === "D").reduce((s, l) => s + l.amountPaise, 0n);
	const credit = legs.filter((l) => l.direction === "C").reduce((s, l) => s + l.amountPaise, 0n);
	if (debit !== credit || debit === 0n)
		throw new Error(`Ledger imbalance: D=${debit} C=${credit} key=${idempotencyKey}`);

	await c.query(
		`INSERT INTO ledger_txns (txn_id, idempotency_key, reference_type, reference_id)
		 VALUES ($1,$2,$3,$4)`,
		[txnUuid(idempotencyKey), idempotencyKey, referenceType, referenceId],
	);
	for (const leg of legs) {
		await c.query(
			`INSERT INTO ledger_entries (txn_id, account_id, direction, amount) VALUES ($1,$2,$3,$4)`,
			[txnUuid(idempotencyKey), leg.accountId, leg.direction, fromPaise(leg.amountPaise)],
		);
		const { rows: ac } = await c.query<{ kind: string }>(
			"SELECT kind FROM accounts WHERE id=$1",
			[leg.accountId],
		);
		if (["wallet", "deferred_bonus", "withdrawable"].includes(ac[0]?.kind)) {
			const signed = leg.direction === "C" ? fromPaise(leg.amountPaise) : "-" + fromPaise(leg.amountPaise);
			await c.query(
				`UPDATE wallet_balances SET balance = balance + $1::numeric, updated_at = now() WHERE account_id = $2`,
				[signed, leg.accountId],
			);
		}
	}
	return true;
}

// ── args ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const SNAPSHOT = args.includes("--snapshot");
const APPLY = args.includes("--apply");
const EXECUTE = args.includes("--execute");
const I_KNOW = args.includes("--i-know");
const fileIdx = args.indexOf("--file");
const FILE = fileIdx >= 0 && args[fileIdx + 1] ? (args[fileIdx + 1] as string) : "scripts/out/reattr-baseline.json";
const codesIdx = args.indexOf("--codes");
const CODES = codesIdx >= 0 && args[codesIdx + 1] ? (args[codesIdx + 1] as string).split(",") : DEFAULT_CODES;
// --expect "<memberId>:<rupees>,..."  — if set, the actionable set must match EXACTLY
// (same members, same per-member delta), else ABORT before any write. Guards against
// concurrent unrelated pipeline activity drifting an earner's balance between plan + execute.
const expectIdx = args.indexOf("--expect");
const EXPECT: Map<string, bigint> | null =
	expectIdx >= 0 && args[expectIdx + 1]
		? new Map(
				(args[expectIdx + 1] as string).split(",").map((p) => {
					const [id, rupees] = p.split(":");
					return [id, toPaise(rupees as string)] as [string, bigint];
				}),
			)
		: null;

interface Baseline {
	takenAt: string;
	prevCutoffId: string;
	openCutoffId: string;
	members: Record<string, {
		code: string;
		walletPaise: string;
		withdrawablePaise: string;
		deferredPaise: string;
		earnedOpenPaise: string;
		earnedPrevPaise: string;
		isQualified: boolean;
		bankStatus: string;
		prevWithdrawal: { id: string; amountPaise: string; status: string } | null;
	}>;
}

// ── shared: resolve the affected member set + per-member current state ─────────
async function resolveState(pool: pg.Pool): Promise<{
	prevCutoffId: bigint;
	openCutoffId: bigint;
	rows: Array<{
		id: bigint; code: string; walletPaise: bigint; withdrawablePaise: bigint;
		deferredPaise: bigint; earnedOpenPaise: bigint; earnedPrevPaise: bigint;
		isQualified: boolean; bankStatus: string;
		prevWithdrawal: { id: bigint; amountPaise: bigint; status: string } | null;
	}>;
}> {
	const { rows: prev } = await pool.query(
		`SELECT id FROM cutoffs WHERE status='closed' ORDER BY window_end DESC LIMIT 1`,
	);
	const { rows: open } = await pool.query(
		`SELECT id FROM cutoffs WHERE status='open' ORDER BY window_end DESC LIMIT 1`,
	);
	if (!prev[0]) throw new Error("No previous (closed) cutoff found.");
	if (!open[0]) throw new Error("No open cutoff found.");
	const prevCutoffId = BigInt(prev[0].id);
	const openCutoffId = BigInt(open[0].id);

	// Affected set = the target members + every ancestor in their placement_path.
	const { rows: targets } = await pool.query<{ id: string; placement_path: string[] }>(
		`SELECT id, placement_path FROM members WHERE member_code = ANY($1)`,
		[CODES],
	);
	const set = new Set<string>();
	for (const t of targets) {
		set.add(String(t.id));
		for (const anc of t.placement_path ?? []) set.add(String(anc));
	}
	const ids = [...set];

	const { rows } = await pool.query(
		`SELECT m.id, m.member_code AS code, m.is_qualified, m.bank_status,
		        COALESCE(w.balance,0)::text  AS wallet,
		        COALESCE(wd.balance,0)::text AS withdrawable,
		        COALESCE(df.balance,0)::text AS deferred,
		        COALESCE(ceo.earned,0)::text AS earned_open,
		        COALESCE(cep.earned,0)::text AS earned_prev,
		        pw.id::text     AS pw_id,
		        pw.amount::text AS pw_amount,
		        pw.status       AS pw_status
		   FROM members m
		   LEFT JOIN accounts aw  ON aw.owner_type='member'  AND aw.owner_id=m.id AND aw.kind='wallet'
		   LEFT JOIN wallet_balances w  ON w.account_id=aw.id
		   LEFT JOIN accounts awd ON awd.owner_type='member' AND awd.owner_id=m.id AND awd.kind='withdrawable'
		   LEFT JOIN wallet_balances wd ON wd.account_id=awd.id
		   LEFT JOIN accounts adf ON adf.owner_type='member' AND adf.owner_id=m.id AND adf.kind='deferred_bonus'
		   LEFT JOIN wallet_balances df ON df.account_id=adf.id
		   LEFT JOIN cutoff_earnings ceo ON ceo.member_id=m.id AND ceo.cutoff_id=$2
		   LEFT JOIN cutoff_earnings cep ON cep.member_id=m.id AND cep.cutoff_id=$3
		   LEFT JOIN withdrawals pw ON pw.member_id=m.id AND pw.source_cutoff_id=$3
		  WHERE m.id = ANY($1::bigint[])
		  ORDER BY m.member_code`,
		[ids, openCutoffId.toString(), prevCutoffId.toString()],
	);

	return {
		prevCutoffId,
		openCutoffId,
		rows: rows.map((r) => ({
			id: BigInt(r.id),
			code: r.code,
			walletPaise: toPaise(r.wallet),
			withdrawablePaise: toPaise(r.withdrawable),
			deferredPaise: toPaise(r.deferred),
			earnedOpenPaise: toPaise(r.earned_open),
			earnedPrevPaise: toPaise(r.earned_prev),
			isQualified: r.is_qualified,
			bankStatus: r.bank_status,
			prevWithdrawal: r.pw_id
				? { id: BigInt(r.pw_id), amountPaise: toPaise(r.pw_amount), status: r.pw_status }
				: null,
		})),
	};
}

async function accountId(pool: pg.Pool | pg.PoolClient, memberId: bigint, kind: string): Promise<bigint> {
	const { rows } = await pool.query<{ id: string }>(
		`SELECT id FROM accounts WHERE owner_type='member' AND owner_id=$1 AND kind=$2`,
		[memberId, kind],
	);
	if (!rows[0]) throw new Error(`account ${kind} not found for member ${memberId}`);
	return BigInt(rows[0].id);
}

async function grandIdentity(pool: pg.Pool): Promise<string> {
	const { rows } = await pool.query<{ kind: string; net: string }>(
		`SELECT a.kind, SUM(CASE le.direction WHEN 'C' THEN le.amount ELSE -le.amount END)::text AS net
		   FROM ledger_entries le JOIN accounts a ON a.id=le.account_id GROUP BY a.kind`,
	);
	const by: Record<string, bigint> = {};
	for (const r of rows) by[r.kind] = toPaise(r.net);
	const expense = by["bonus_expense"] ?? 0n;
	const out = (by["payout_clearing"] ?? 0n) + (by["bonus_forfeited"] ?? 0n) + (by["wallet"] ?? 0n) + (by["withdrawable"] ?? 0n) + (by["deferred_bonus"] ?? 0n);
	return `bonus_expense=${toRupees(-expense)}  out=${toRupees(out)}  ${-expense === out ? "✅ balanced" : `❌ delta ${toRupees(-expense - out)}`}`;
}

// ── main ────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
	const url = process.env.PROD_DATABASE_URL;
	if (!url) {
		console.error("[reattr] PROD_DATABASE_URL is required.");
		process.exit(1);
	}
	if (!SNAPSHOT && !APPLY) {
		console.error("[reattr] pass --snapshot (capture baseline) or --apply (perform the move).");
		process.exit(1);
	}
	const isProd = url.includes("hayabusa");
	if (isProd && !I_KNOW && (APPLY || SNAPSHOT)) {
		console.error("[reattr] PROD_DATABASE_URL points at production (hayabusa). Pass --i-know.");
		process.exit(1);
	}
	const host = isProd ? "PRODUCTION (hayabusa)" : url.includes("tokaido") ? "dev copy (tokaido)" : "unknown";
	const pool = new pg.Pool({ connectionString: url, max: 3 });

	try {
		const state = await resolveState(pool);
		console.log(`[reattr] host=${host}  prevCutoff=${state.prevCutoffId}  openCutoff=${state.openCutoffId}  targets=${CODES.join(",")}`);
		console.log(`[reattr] affected set: ${state.rows.length} members (targets + ancestors)\n`);

		// ── SNAPSHOT ──────────────────────────────────────────────────────────
		if (SNAPSHOT) {
			const baseline: Baseline = {
				takenAt: new Date().toISOString(),
				prevCutoffId: state.prevCutoffId.toString(),
				openCutoffId: state.openCutoffId.toString(),
				members: {},
			};
			for (const r of state.rows) {
				baseline.members[r.id.toString()] = {
					code: r.code,
					walletPaise: r.walletPaise.toString(),
					withdrawablePaise: r.withdrawablePaise.toString(),
					deferredPaise: r.deferredPaise.toString(),
					earnedOpenPaise: r.earnedOpenPaise.toString(),
					earnedPrevPaise: r.earnedPrevPaise.toString(),
					isQualified: r.isQualified,
					bankStatus: r.bankStatus,
					prevWithdrawal: r.prevWithdrawal
						? { id: r.prevWithdrawal.id.toString(), amountPaise: r.prevWithdrawal.amountPaise.toString(), status: r.prevWithdrawal.status }
						: null,
				};
			}
			if (!existsSync(dirname(FILE))) mkdirSync(dirname(FILE), { recursive: true });
			writeFileSync(FILE, JSON.stringify(baseline, null, 2));
			const nonZero = state.rows.filter((r) => r.walletPaise !== 0n || r.earnedOpenPaise !== 0n);
			console.log(`[reattr] baseline written to ${FILE}`);
			if (nonZero.length)
				console.log(`[reattr] ⚠️  NOTE: ${nonZero.length} member(s) already have wallet>0 or open-cutoff earnings>0 at baseline; deltas will exclude these pre-existing amounts (correct), but review that this is expected.`);
			else
				console.log(`[reattr] baseline is clean (all affected members: wallet=0, open-cutoff earned=0).`);
			console.log(`\n[reattr] Now activate the 4 via Record Payment, wait for workers, then run --apply.`);
			return;
		}

		// ── APPLY ─────────────────────────────────────────────────────────────
		if (!existsSync(FILE)) {
			console.error(`[reattr] baseline file ${FILE} not found — run --snapshot BEFORE activating.`);
			process.exit(1);
		}
		const baseline: Baseline = JSON.parse(readFileSync(FILE, "utf8"));
		if (baseline.prevCutoffId !== state.prevCutoffId.toString() || baseline.openCutoffId !== state.openCutoffId.toString()) {
			console.error(`[reattr] ABORT: cutoffs changed since baseline (baseline prev=${baseline.prevCutoffId} open=${baseline.openCutoffId}; now prev=${state.prevCutoffId} open=${state.openCutoffId}). A cutoff closed mid-operation — re-plan.`);
			process.exit(1);
		}

		console.log(`── Per-earner plan (delta = now − baseline) ────────────────────────────────`);
		interface Plan {
			id: bigint; code: string; deltaPaise: bigint;
			newPrevEarnedPaise: bigint; prevWithdrawal: { id: bigint; amountPaise: bigint; status: string } | null;
			alreadyDone: boolean;
		}
		const plans: Plan[] = [];
		let anyBlock = false;

		for (const r of state.rows) {
			const base = baseline.members[r.id.toString()];
			const baseWallet = base ? BigInt(base.walletPaise) : 0n;
			const baseEarnedOpen = base ? BigInt(base.earnedOpenPaise) : 0n;
			const baseDeferred = base ? BigInt(base.deferredPaise) : 0n;

			const walletDelta = r.walletPaise - baseWallet;
			const earnedOpenDelta = r.earnedOpenPaise - baseEarnedOpen;
			const deferredDelta = r.deferredPaise - baseDeferred;
			if (walletDelta <= 0n && earnedOpenDelta <= 0n) continue; // no new income for this member

			// idempotency: has this member already been re-attributed?
			const { rows: doneRows } = await pool.query(
				`SELECT 1 FROM ledger_txns WHERE idempotency_key=$1`,
				[`reattr:c${state.prevCutoffId}c${state.openCutoffId}:sweep:${r.id}`],
			);
			const alreadyDone = doneRows.length > 0;

			const flags: string[] = [];
			if (deferredDelta !== 0n) flags.push(`deferred moved by ${toRupees(deferredDelta)} (unexpected — needs manual review)`);
			if (walletDelta !== earnedOpenDelta) flags.push(`wallet delta ${toRupees(walletDelta)} ≠ open-earned delta ${toRupees(earnedOpenDelta)} (cap/forfeit? review)`);
			const newPrevEarned = r.earnedPrevPaise + walletDelta;
			if (newPrevEarned > CUTOFF_CAP_PAISE) flags.push(`prev-cutoff earned would exceed weekly cap: ${toRupees(newPrevEarned)} > ${toRupees(CUTOFF_CAP_PAISE)}`);
			if (!r.prevWithdrawal && walletDelta < MIN_PAYOUT_PAISE) flags.push(`no existing prev withdrawal and delta < ₹500 min — cannot create withdrawal`);
			if (r.prevWithdrawal && r.prevWithdrawal.status !== "pending") flags.push(`existing prev withdrawal #${r.prevWithdrawal.id} is '${r.prevWithdrawal.status}', not 'pending' — cannot safely augment`);
			if (walletDelta > 0n && r.bankStatus !== "verified") flags.push(`bank_status=${r.bankStatus} (not verified — will not be payable, but re-attribution still valid)`);

			console.log(`  ${r.code} (id=${r.id})  delta=${toRupees(walletDelta)}${alreadyDone ? "  [already applied — will skip]" : ""}`);
			console.log(`      prev withdrawal: ${r.prevWithdrawal ? `#${r.prevWithdrawal.id} ${toRupees(r.prevWithdrawal.amountPaise)} (${r.prevWithdrawal.status}) → ${toRupees(r.prevWithdrawal.amountPaise + walletDelta)}` : `none → will INSERT ${toRupees(walletDelta)} pending`}`);
			console.log(`      cutoff_earnings prev ${toRupees(r.earnedPrevPaise)} → ${toRupees(newPrevEarned)} ; open ${toRupees(r.earnedOpenPaise)} → ${toRupees(r.earnedOpenPaise - walletDelta)}`);
			if (flags.length) { console.log(`      ⚠️  ${flags.join("; ")}`); if (flags.some((f) => !f.includes("not verified"))) anyBlock = true; }

			plans.push({ id: r.id, code: r.code, deltaPaise: walletDelta, newPrevEarnedPaise: newPrevEarned, prevWithdrawal: r.prevWithdrawal, alreadyDone });
		}

		const actionable = plans.filter((p) => !p.alreadyDone && p.deltaPaise > 0n);
		const totalDelta = actionable.reduce((s, p) => s + p.deltaPaise, 0n);
		console.log(`\n  ${actionable.length} member(s) to re-attribute; total ${toRupees(totalDelta)}`);
		console.log(`  grand identity BEFORE: ${await grandIdentity(pool)}`);

		// --expect guard: the live actionable set must match the pre-verified plan exactly.
		if (EXPECT) {
			const problems: string[] = [];
			for (const p of actionable) {
				const exp = EXPECT.get(p.id.toString());
				if (exp === undefined)
					problems.push(`unexpected earner ${p.code} (id=${p.id}) delta ${toRupees(p.deltaPaise)}`);
				else if (exp !== p.deltaPaise)
					problems.push(`${p.code} (id=${p.id}) delta ${toRupees(p.deltaPaise)} ≠ expected ${toRupees(exp)}`);
			}
			for (const [id, exp] of EXPECT)
				if (!actionable.some((p) => p.id.toString() === id))
					problems.push(`expected earner id=${id} (${toRupees(exp)}) missing from actionable set`);
			if (problems.length) {
				console.error(`\n[reattr] ABORT (--expect guard failed):\n  ${problems.join("\n  ")}`);
				process.exit(1);
			}
			const expTotal = [...EXPECT.values()].reduce((s, v) => s + v, 0n);
			console.log(`  --expect guard: ✅ ${actionable.length} earner(s) match exactly (total ${toRupees(expTotal)})`);
		}

		if (anyBlock) {
			console.error(`\n[reattr] ABORT: one or more blocking conditions above. Resolve before executing.`);
			process.exit(1);
		}
		if (actionable.length === 0) {
			console.log(`\n[reattr] Nothing to do (no new income detected, or all already applied). If you just activated, ensure workers have settled and the baseline was captured BEFORE activation.`);
			return;
		}
		if (!EXECUTE) {
			console.log(`\n[reattr] DRY-RUN — no writes. Re-run with --execute to apply.`);
			return;
		}

		// ── Execute (single transaction) ──────────────────────────────────────
		console.log(`\n[reattr] Executing on ${host} ...`);
		const client = await pool.connect();
		try {
			await client.query("BEGIN");
			for (const p of actionable) {
				// re-check idempotency under transaction
				const sweepKey = `reattr:c${state.prevCutoffId}c${state.openCutoffId}:sweep:${p.id}`;
				const holdKey = `reattr:c${state.prevCutoffId}c${state.openCutoffId}:hold:${p.id}`;

				// Lock wallet row; re-read balance and require it still covers the delta.
				const walletAcc = await accountId(client, p.id, "wallet");
				const { rows: lockW } = await client.query<{ balance: string }>(
					`SELECT balance FROM wallet_balances WHERE account_id=$1 FOR UPDATE`, [walletAcc],
				);
				const liveWallet = lockW[0] ? toPaise(lockW[0].balance) : 0n;
				if (liveWallet < p.deltaPaise) {
					throw new Error(`${p.code}: live wallet ${toRupees(liveWallet)} < delta ${toRupees(p.deltaPaise)} under lock — aborting all.`);
				}

				const withdrawableAcc = await accountId(client, p.id, "withdrawable");
				const clearingRes = await client.query<{ id: string }>(
					`SELECT id FROM accounts WHERE owner_type='system' AND kind='payout_clearing'`,
				);
				const clearingAcc = BigInt(clearingRes.rows[0].id);

				// 1. wallet → withdrawable → payout_clearing (balanced, keyed)
				await postLedgerTxn(client, sweepKey, "reattr_sweep", p.id, [
					{ accountId: walletAcc, direction: "D", amountPaise: p.deltaPaise },
					{ accountId: withdrawableAcc, direction: "C", amountPaise: p.deltaPaise },
				]);
				await postLedgerTxn(client, holdKey, "reattr_hold", p.id, [
					{ accountId: withdrawableAcc, direction: "D", amountPaise: p.deltaPaise },
					{ accountId: clearingAcc, direction: "C", amountPaise: p.deltaPaise },
				]);

				// 2. cutoff_earnings: open -= delta ; prev += delta
				await client.query(
					`UPDATE cutoff_earnings SET earned = earned - $1::numeric WHERE member_id=$2 AND cutoff_id=$3`,
					[fromPaise(p.deltaPaise), p.id, state.openCutoffId.toString()],
				);
				await client.query(
					`INSERT INTO cutoff_earnings (member_id, cutoff_id, earned, deferred)
					 VALUES ($1,$2,$3,0)
					 ON CONFLICT (member_id, cutoff_id) DO UPDATE SET earned = cutoff_earnings.earned + EXCLUDED.earned`,
					[p.id, state.prevCutoffId.toString(), fromPaise(p.deltaPaise)],
				);

				// 3. withdrawals: augment pending prev row, or insert a new one
				if (p.prevWithdrawal) {
					const upd = await client.query(
						`UPDATE withdrawals SET amount = amount + $1::numeric
						  WHERE id=$2 AND status='pending' AND source_cutoff_id=$3`,
						[fromPaise(p.deltaPaise), p.prevWithdrawal.id.toString(), state.prevCutoffId.toString()],
					);
					if (upd.rowCount !== 1) throw new Error(`${p.code}: expected to augment withdrawal #${p.prevWithdrawal.id}, rowCount=${upd.rowCount}`);
				} else {
					await client.query(
						`INSERT INTO withdrawals (member_id, amount, status, source_cutoff_id)
						 VALUES ($1,$2,'pending',$3)`,
						[p.id, fromPaise(p.deltaPaise), state.prevCutoffId.toString()],
					);
				}
				console.log(`  ✓ ${p.code}  +${toRupees(p.deltaPaise)} → prev cutoff ${state.prevCutoffId}`);
			}
			await client.query("COMMIT");
			console.log(`[reattr] ✅ Committed ${actionable.length} member(s).`);
		} catch (err) {
			await client.query("ROLLBACK");
			console.error(`[reattr] ROLLED BACK: ${(err as Error).message}`);
			throw err;
		} finally {
			client.release();
		}

		console.log(`  grand identity AFTER : ${await grandIdentity(pool)}`);
	} finally {
		await pool.end();
	}
}

main().catch((err) => {
	console.error("[reattr] Fatal:", err);
	process.exit(1);
});
