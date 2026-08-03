/**
 * diagnoseInactivePayout.ts — READ-ONLY diagnostic for the "forgot to activate
 * before the last payout" case.
 *
 * Background:
 *   Four members paid before the last cutoff closed, but management forgot to
 *   activate them (members.is_active stayed FALSE).  Because they were inactive,
 *   the counter/pair pipeline never ran for their activation, so the pair income
 *   that WOULD have flowed (mostly to their UPLINE) never landed in the last
 *   payout cycle.  We want to give them the "as-if-active-before-the-last-payout"
 *   treatment, attributed to the previous (already-closed) cutoff.
 *
 *   Before writing any correction we must SEE the real production state — this
 *   codebase's dev copy does not contain these members, and activation cascades
 *   through the placement tree in a way that depends entirely on live counters.
 *
 * What this script prints (writes NOTHING — no --execute, no ledger, no updates):
 *   For each target member:
 *     • member row: is_active, activated_at, kyc_status, bank_status, placement
 *     • their orders (did they pay? when? status?)
 *     • their balances: wallet / withdrawable / deferred_bonus
 *     • their own member_counters + pair_accruals (pending/released)
 *     • their withdrawals rows (with source_cutoff_id + status)
 *   The previous (last closed) cutoff and the current open cutoff.
 *   An UPLINE CASCADE ESTIMATE: for each ancestor of the (currently inactive)
 *     targets, the +L/+R their activation would add, the resulting new pairs
 *     (LEAST(l',r') − pairs_matched), and the estimated ₹ accrual — plus that
 *     ancestor's is_qualified / is_active / kyc / bank (which gate release + pay).
 *
 * IMPORTANT — the cascade number is an ESTIMATE.  It does not model the
 *   qualification gate, the ₹1,00,000 weekly cap, deferred/forfeited overage,
 *   or accruals already pending.  It exists to size the correction and to be
 *   sanity-checked against real numbers before the correction script is written.
 *
 * Usage (read-only; safe to run against production):
 *   # dev copy:
 *   PROD_DATABASE_URL="$DATABASE_URL" npx tsx scripts/diagnoseInactivePayout.ts
 *   # production:
 *   PROD_DATABASE_URL='postgresql://...@hayabusa...' npx tsx scripts/diagnoseInactivePayout.ts
 *   # override the member list:
 *   PROD_DATABASE_URL='...' npx tsx scripts/diagnoseInactivePayout.ts AVG100156 AVG100303
 *
 * No writes are performed, so no --execute / --i-know flag is required.
 */

import pg from "pg";

const PAIR_BONUS_RUPEES = 1000; // CFG.PAIR_BONUS_PAISE = 100000 paise
const MIN_PAYOUT_RUPEES = 500; // CFG.MIN_PAYOUT_PAISE = 50000 paise
const WEEKLY_CAP_RUPEES = 100000; // CFG.CUTOFF_CAP_PAISE = 10000000 paise

const DEFAULT_CODES = ["AVG100156", "AVG100303", "AVG100833", "AVG100832"];

function rupees(n: number | string): string {
	return `₹${Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;
}

async function main(): Promise<void> {
	const url = process.env.PROD_DATABASE_URL;
	if (!url) {
		console.error(
			"[diagnose] PROD_DATABASE_URL is required.\n" +
				'  dev copy:   PROD_DATABASE_URL="$DATABASE_URL" npx tsx scripts/diagnoseInactivePayout.ts\n' +
				"  production: PROD_DATABASE_URL='postgresql://...@hayabusa...' npx tsx scripts/diagnoseInactivePayout.ts",
		);
		process.exit(1);
	}
	const codes = process.argv.slice(2).filter((a) => !a.startsWith("--"));
	const targetCodes = codes.length > 0 ? codes : DEFAULT_CODES;

	const host = url.includes("hayabusa") ? "PRODUCTION (hayabusa)" : url.includes("tokaido") ? "dev copy (tokaido)" : "unknown host";
	console.log(`[diagnose] READ-ONLY. host=${host}`);
	console.log(`[diagnose] targets: ${targetCodes.join(", ")}\n`);

	const pool = new pg.Pool({ connectionString: url, max: 3 });
	try {
		// ── Cutoffs: previous (last closed) + current (open) ────────────────────
		const { rows: prevRows } = await pool.query(
			`SELECT id, window_start, window_end, payout_date, status
			   FROM cutoffs WHERE status='closed' ORDER BY window_end DESC LIMIT 1`,
		);
		const { rows: openRows } = await pool.query(
			`SELECT id, window_start, window_end, payout_date, status
			   FROM cutoffs WHERE status='open' ORDER BY window_end DESC LIMIT 1`,
		);
		const prev = prevRows[0];
		console.log("── Cutoffs ──────────────────────────────────────────────────────────────");
		console.log(
			`  PREVIOUS (last closed): ${prev ? `id=${prev.id}  ${prev.window_start.toISOString?.() ?? prev.window_start} → ${prev.window_end.toISOString?.() ?? prev.window_end}  payout_date=${prev.payout_date}` : "NONE FOUND"}`,
		);
		console.log(
			`  CURRENT (open)        : ${openRows[0] ? `id=${openRows[0].id}  ${openRows[0].window_start.toISOString?.() ?? openRows[0].window_start} → ${openRows[0].window_end.toISOString?.() ?? openRows[0].window_end}` : "NONE"}`,
		);
		console.log("");

		// ── Target members ──────────────────────────────────────────────────────
		const { rows: members } = await pool.query(
			`SELECT id, member_code, name, email, phone, is_active, activated_at,
			        is_qualified, qualified_at, kyc_status, bank_status,
			        sponsor_id, parent_id, position, placement_path, placement_sides, created_at
			   FROM members WHERE member_code = ANY($1) ORDER BY member_code`,
			[targetCodes],
		);
		const foundCodes = new Set(members.map((m) => m.member_code));
		for (const c of targetCodes) if (!foundCodes.has(c)) console.log(`  ⚠️  NOT FOUND: ${c}`);

		const targetIds: bigint[] = members.map((m) => BigInt(m.id));

		// Accumulate cascade deltas per ancestor across all inactive targets.
		const ancDelta = new Map<string, { dL: number; dR: number; from: string[] }>();

		for (const m of members) {
			const id = BigInt(m.id);
			console.log("══════════════════════════════════════════════════════════════════════════");
			console.log(`  ${m.member_code}  ${m.name}  <${m.email ?? "no-email"}>  phone=${m.phone}`);
			console.log(`  id=${id}  is_active=${m.is_active}  activated_at=${m.activated_at ?? "—"}`);
			console.log(`  is_qualified=${m.is_qualified}  kyc=${m.kyc_status}  bank=${m.bank_status}`);
			console.log(`  sponsor_id=${m.sponsor_id ?? "—"}  parent_id=${m.parent_id ?? "—"}  position=${m.position ?? "—"}  created_at=${m.created_at?.toISOString?.() ?? m.created_at}`);
			console.log(`  placement_path=[${(m.placement_path ?? []).join(", ")}]`);
			console.log(`  placement_sides=[${(m.placement_sides ?? []).join(", ")}]`);

			// Orders (did they pay? when?)
			const { rows: orders } = await pool.query(
				`SELECT id, status, total_amount, payment_ref, created_at, confirmed_at
				   FROM orders WHERE member_id=$1 ORDER BY created_at`,
				[id],
			);
			console.log(`  orders (${orders.length}):`);
			for (const o of orders)
				console.log(`    #${o.id}  status=${o.status}  total=${rupees(o.total_amount)}  payment_ref=${o.payment_ref ?? "—"}  created=${o.created_at?.toISOString?.() ?? o.created_at}  confirmed=${o.confirmed_at?.toISOString?.() ?? o.confirmed_at ?? "—"}`);

			// Balances
			const { rows: bals } = await pool.query(
				`SELECT a.kind, wb.balance FROM accounts a
				   JOIN wallet_balances wb ON wb.account_id=a.id
				  WHERE a.owner_type='member' AND a.owner_id=$1
				    AND a.kind IN ('wallet','withdrawable','deferred_bonus') ORDER BY a.kind`,
				[id],
			);
			console.log(`  balances: ${bals.length ? bals.map((b) => `${b.kind}=${rupees(b.balance)}`).join("  ") : "(no accounts)"}`);

			// Own counters
			const { rows: ctr } = await pool.query(
				`SELECT left_active, right_active, pairs_matched, left_qualified, right_qualified
				   FROM member_counters WHERE member_id=$1`,
				[id],
			);
			console.log(`  own counters: ${ctr[0] ? `L_active=${ctr[0].left_active} R_active=${ctr[0].right_active} pairs_matched=${ctr[0].pairs_matched} L_qual=${ctr[0].left_qualified} R_qual=${ctr[0].right_qualified}` : "(none)"}`);

			// Own pair_accruals as beneficiary
			const { rows: acc } = await pool.query(
				`SELECT status, count(*)::int AS n, COALESCE(SUM(amount),0) AS total
				   FROM pair_accruals WHERE beneficiary_id=$1 GROUP BY status ORDER BY status`,
				[id],
			);
			console.log(`  own accruals: ${acc.length ? acc.map((a) => `${a.status}: ${a.n} rows / ${rupees(a.total)}`).join("  ") : "(none)"}`);

			// Own withdrawals
			const { rows: wd } = await pool.query(
				`SELECT id, amount, status, source_cutoff_id, processed_at, requested_at
				   FROM withdrawals WHERE member_id=$1 ORDER BY source_cutoff_id NULLS FIRST, id`,
				[id],
			);
			console.log(`  withdrawals (${wd.length}):`);
			for (const w of wd)
				console.log(`    #${w.id}  ${rupees(w.amount)}  status=${w.status}  source_cutoff_id=${w.source_cutoff_id ?? "—"}  processed_at=${w.processed_at ?? "—"}`);

			// Accumulate cascade delta for ancestors (only if this member is inactive)
			if (!m.is_active) {
				const path: (string | number)[] = m.placement_path ?? [];
				const sides: string[] = m.placement_sides ?? [];
				for (let i = 0; i < path.length; i++) {
					const anc = String(path[i]);
					const side = sides[i];
					const cur = ancDelta.get(anc) ?? { dL: 0, dR: 0, from: [] };
					if (side === "L") cur.dL++;
					else if (side === "R") cur.dR++;
					cur.from.push(`${m.member_code}(${side})`);
					ancDelta.set(anc, cur);
				}
			}
			console.log("");
		}

		// ── Upline cascade estimate ───────────────────────────────────────────────
		console.log("══════════════════════════════════════════════════════════════════════════");
		console.log("  UPLINE CASCADE ESTIMATE (naive — ignores qualification gate, weekly cap,");
		console.log("  deferral, and already-pending accruals). Sizes the correction only.");
		console.log("══════════════════════════════════════════════════════════════════════════");
		if (ancDelta.size === 0) {
			console.log("  No inactive targets with ancestors — nothing to cascade.");
		} else {
			const ancIds = [...ancDelta.keys()];
			const { rows: ancRows } = await pool.query(
				`SELECT m.id, m.member_code, m.name, m.is_active, m.is_qualified, m.kyc_status, m.bank_status,
				        c.left_active, c.right_active, c.pairs_matched
				   FROM members m
				   LEFT JOIN member_counters c ON c.member_id = m.id
				  WHERE m.id = ANY($1::bigint[])`,
				[ancIds],
			);
			const byId = new Map(ancRows.map((r) => [String(r.id), r]));
			let totalNewPairs = 0;
			let totalEst = 0;
			// Print deepest-first is not necessary; sort by member_code for readability.
			const sorted = [...ancDelta.entries()].sort((a, b) => {
				const ra = byId.get(a[0]);
				const rb = byId.get(b[0]);
				return String(ra?.member_code ?? a[0]).localeCompare(String(rb?.member_code ?? b[0]));
			});
			for (const [anc, d] of sorted) {
				const r = byId.get(anc);
				const isTarget = targetIds.some((t) => String(t) === anc);
				const L = Number(r?.left_active ?? 0);
				const R = Number(r?.right_active ?? 0);
				const pm = Number(r?.pairs_matched ?? 0);
				const newPairsTotal = Math.min(L + d.dL, R + d.dR);
				const deltaPairs = Math.max(0, newPairsTotal - pm);
				const est = deltaPairs * PAIR_BONUS_RUPEES;
				totalNewPairs += deltaPairs;
				totalEst += est;
				console.log(
					`  ${r?.member_code ?? `id=${anc}`}${isTarget ? " (also a target)" : ""}  ${r?.name ?? ""}`,
				);
				console.log(
					`      counters L=${L} R=${R} pairs_matched=${pm}  |  +${d.dL}L +${d.dR}R  →  new pairs ≈ ${deltaPairs}  ≈ ${rupees(est)}`,
				);
				console.log(
					`      qualified=${r?.is_qualified}  active=${r?.is_active}  kyc=${r?.kyc_status}  bank=${r?.bank_status}  |  from: ${d.from.join(", ")}`,
				);
			}
			console.log("  ────────────────────────────────────────────────────────────────────");
			console.log(`  TOTAL estimated new pairs ≈ ${totalNewPairs}   estimated accrual ≈ ${rupees(totalEst)}`);
			console.log(`  (pair bonus ${rupees(PAIR_BONUS_RUPEES)}/pair, min payout ${rupees(MIN_PAYOUT_RUPEES)}, weekly cap ${rupees(WEEKLY_CAP_RUPEES)})`);
		}
		console.log("\n[diagnose] Done. No writes performed.");
	} finally {
		await pool.end();
	}
}

main().catch((err) => {
	console.error("[diagnose] Fatal:", err);
	process.exit(1);
});
