/**
 * reconstructWeekly.ts — read-only exact reconstruction of per-week earnings
 *
 * The reseed stamped all pair bonus releases into the single open cutoff window,
 * making the live admin report show ₹0 for prior weeks.  But the causal inputs
 * all survived with real timestamps:
 *   • members.activated_at  — spread Jul 14–31 (backdated by simulation)
 *   • members.qualified_at  — 124 rows, 11 distinct days Jul 14–31
 *   • pairs.left_member_id / right_member_id — exact activation-log sequence
 *     (counterPair.ts:119–145 resolves from leg_activations by seq; pair k =
 *     k-th left activator × k-th right activator — causally exact, not a proxy)
 *   • No withdrawals / no payouts → no reconciliation needed
 *
 * Method:
 *   1. Released-only pair_accruals (pending = unqualified = not earned in any week).
 *   2. release_at = GREATEST(pair_completion_at, beneficiary.qualified_at)
 *      — earnings land at release time (ledger.ts), not completion time alone.
 *   3. Bucket release_at into existing cutoff windows (0 orphans confirmed).
 *   4. Per-member × per-week sum, apply ₹1,00,000/member/week cap.
 *
 * Fidelity proof: applying the same method to the crammed single window reproduces
 * the stored wallet balance (₹9,70,000) and forfeiture (₹1,08,000) byte-for-byte.
 * The script asserts this and prints PASS / FAIL.
 *
 * Product price note: all products are priced at ₹10,000.  31 early orders exist
 * at ₹11,800 (the old GST-inclusive price before GST was removed).  The pair-matching
 * system is price-agnostic — any confirmed order makes a member is_active=true, one
 * activation, regardless of amount.  For the product_cost_rupees column in the CSV we
 * always output 10000 (the standard price), treating 11800 as 10000.
 *
 * WRITES NOTHING.  All queries run inside BEGIN READ ONLY; any accidental write
 * throws immediately.  Connects via PROD_DATABASE_URL (not .env DATABASE_URL)
 * so it cannot be aimed at the wrong host by accident.
 *
 * Output:
 *   • Per-week summary to console
 *   • scripts/out/weekly-earnings-reconstructed.csv — per-member per-week CSV
 *
 * Usage:
 *   # against dev copy first (smoke test):
 *   PROD_DATABASE_URL="$DATABASE_URL" npx tsx scripts/reconstructWeekly.ts
 *
 *   # against production (read-only):
 *   PROD_DATABASE_URL='postgresql://postgres:<pw>@hayabusa.proxy.rlwy.net:53263/railway' \
 *     npx tsx scripts/reconstructWeekly.ts
 *
 *   # or via npm:
 *   PROD_DATABASE_URL='...' npm run report:weekly
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

// ── constants (mirrors src/config.ts; no env-import so this script has zero side-effects) ──
const PAIR_BONUS_PAISE = 100_000;        // ₹1,000 per pair
const CUTOFF_CAP_PAISE = 10_000_000;     // ₹1,00,000 per member per week

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── helpers ──────────────────────────────────────────────────────────────────
const toRupees = (paise: bigint): string =>
	`₹${(Number(paise) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;

const pad = (s: string, n: number): string => s.padEnd(n);

// ── main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
	const url = process.env.PROD_DATABASE_URL;
	if (!url) {
		console.error(
			"[reconstructWeekly] PROD_DATABASE_URL env var is required.\n" +
				"  Dev copy:   PROD_DATABASE_URL=$DATABASE_URL npx tsx scripts/reconstructWeekly.ts\n" +
				"  Production: PROD_DATABASE_URL='postgresql://...' npx tsx scripts/reconstructWeekly.ts\n" +
				"  npm shortcut: PROD_DATABASE_URL='...' npm run report:weekly",
		);
		process.exit(1);
	}

	const client = new pg.Client({ connectionString: url });
	await client.connect();

	try {
		// Force session read-only — any write would throw immediately
		await client.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
		await client.query("BEGIN READ ONLY");

		// ── 1. Core reconstruction query ──────────────────────────────────────────
		// release_at = MAX(pair completion, earner qualification)
		// Only released accruals count — pending = unqualified = not earned yet.
		const { rows: coreRows } = await client.query<{
			window_id: string;
			window_start: Date;
			window_end: Date;
			status: string;
			beneficiary: string;
			member_code: string;
			name: string;
			gross_paise: string;
		}>(`
      WITH rel AS (
        SELECT p.member_id           AS beneficiary,
               GREATEST(
                 GREATEST(lm.activated_at, rm.activated_at),
                 b.qualified_at
               )                     AS release_at
          FROM pair_accruals pa
          JOIN pairs   p  ON p.id  = pa.pair_id
          JOIN members lm ON lm.id = p.left_member_id
          JOIN members rm ON rm.id = p.right_member_id
          JOIN members b  ON b.id  = p.member_id
         WHERE pa.status = 'released'
      )
      SELECT c.id             AS window_id,
             c.window_start,
             c.window_end,
             c.status,
             r.beneficiary,
             m.member_code,
             m.name,
             -- COUNT(*) * PAIR_BONUS_PAISE — use int arithmetic in SQL to stay exact
             (COUNT(*) * ${PAIR_BONUS_PAISE})::bigint AS gross_paise
        FROM rel r
        JOIN cutoffs c
          ON r.release_at >= c.window_start
         AND r.release_at <  c.window_end
        JOIN members m ON m.id = r.beneficiary
       GROUP BY c.id, c.window_start, c.window_end, c.status, r.beneficiary, m.member_code, m.name
       ORDER BY c.window_start, m.member_code
    `);

		// ── 2. Apply per-member-per-week cap ──────────────────────────────────────
		type MemberWeekRow = {
			window_id: bigint;
			window_start: Date;
			window_end: Date;
			status: string;
			member_code: string;
			name: string;
			gross_paise: bigint;
			net_earned_paise: bigint;
			forfeited_paise: bigint;
		};

		const rows: MemberWeekRow[] = coreRows.map((r) => {
			const gross = BigInt(r.gross_paise);
			const cap = BigInt(CUTOFF_CAP_PAISE);
			const net = gross < cap ? gross : cap;
			return {
				window_id: BigInt(r.window_id),
				window_start: r.window_start,
				window_end: r.window_end,
				status: r.status,
				member_code: r.member_code,
				name: r.name,
				gross_paise: gross,
				net_earned_paise: net,
				forfeited_paise: gross - net,
			};
		});

		// ── 3. Per-window aggregates ───────────────────────────────────────────────
		type WindowSummary = {
			window_id: bigint;
			window_start: Date;
			window_end: Date;
			status: string;
			earners: number;
			gross: bigint;
			net: bigint;
			forfeited: bigint;
		};
		const byWindow = new Map<bigint, WindowSummary>();
		for (const r of rows) {
			let ws = byWindow.get(r.window_id);
			if (!ws) {
				ws = {
					window_id: r.window_id,
					window_start: r.window_start,
					window_end: r.window_end,
					status: r.status,
					earners: 0,
					gross: 0n,
					net: 0n,
					forfeited: 0n,
				};
				byWindow.set(r.window_id, ws);
			}
			ws.earners++;
			ws.gross += r.gross_paise;
			ws.net += r.net_earned_paise;
			ws.forfeited += r.forfeited_paise;
		}
		const windows = [...byWindow.values()].sort((a, b) =>
			a.window_start < b.window_start ? -1 : 1,
		);

		const grandGross = windows.reduce((s, w) => s + w.gross, 0n);
		const grandNet = windows.reduce((s, w) => s + w.net, 0n);
		const grandForfeited = windows.reduce((s, w) => s + w.forfeited, 0n);

		// ── 4. Orphan check ───────────────────────────────────────────────────────
		const { rows: orphanRows } = await client.query<{ orphans: string }>(`
      SELECT COUNT(*) AS orphans
        FROM pair_accruals pa
        JOIN pairs   p  ON p.id  = pa.pair_id
        JOIN members lm ON lm.id = p.left_member_id
        JOIN members rm ON rm.id = p.right_member_id
        JOIN members b  ON b.id  = p.member_id
       WHERE pa.status = 'released'
         AND NOT EXISTS (
           SELECT 1 FROM cutoffs c
            WHERE GREATEST(GREATEST(lm.activated_at, rm.activated_at), b.qualified_at)
                  >= c.window_start
              AND GREATEST(GREATEST(lm.activated_at, rm.activated_at), b.qualified_at)
                  <  c.window_end
         )
    `);
		const orphans = BigInt(orphanRows[0].orphans);

		// ── 5. Fidelity self-check ─────────────────────────────────────────────────
		// Re-bucket all released accruals into one pot (ignoring window), apply cap
		// per member globally → must reproduce the stored wallet total exactly.
		const { rows: groundTruth } = await client.query<{
			stored_wallet: string;
			stored_forfeited: string;
		}>(`
      SELECT
        (SELECT COALESCE(SUM(earned * 100), 0) FROM cutoff_earnings)::bigint AS stored_wallet,
        -- forfeited = released_gross - stored_wallet
        (
          (SELECT COALESCE(SUM(amount * 100), 0) FROM pair_accruals WHERE status='released')
          -
          (SELECT COALESCE(SUM(earned * 100), 0) FROM cutoff_earnings)
        )::bigint AS stored_forfeited
    `);
		const storedWallet = BigInt(groundTruth[0].stored_wallet);
		const storedForfeited = BigInt(groundTruth[0].stored_forfeited);

		// Recompute net by treating every member's total released pairs as a single bucket
		const perMemberGlobal = new Map<string, bigint>();
		for (const r of rows) {
			perMemberGlobal.set(
				r.member_code,
				(perMemberGlobal.get(r.member_code) ?? 0n) + r.gross_paise,
			);
		}
		const globalNet = [...perMemberGlobal.values()].reduce(
			(s, g) => s + (g < BigInt(CUTOFF_CAP_PAISE) ? g : BigInt(CUTOFF_CAP_PAISE)),
			0n,
		);
		const globalForfeited = grandGross - globalNet;

		const selfCheckPass =
			globalNet === storedWallet && globalForfeited === storedForfeited;

		await client.query("COMMIT");

		// ── 6. CSV output ─────────────────────────────────────────────────────────
		// Standard product cost — ₹10,000 for everyone.
		// 31 early orders exist at ₹11,800 (old GST price); we normalise all to ₹10,000.
		const PRODUCT_COST_RUPEES = "10000.00";

		const CSV_HEADER =
			"window,window_start,window_end,status,member_code,name,product_cost_rupees,gross_rupees,net_earned_rupees,forfeited_rupees";

		const formatDate = (d: Date): string => d.toISOString().slice(0, 10);
		const esc = (v: string): string =>
			/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
		const paiseToRupees = (p: bigint): string => (Number(p) / 100).toFixed(2);

		const csvLines = rows.map((r) =>
			[
				r.window_id.toString(),
				formatDate(r.window_start),
				formatDate(r.window_end),
				r.status,
				r.member_code,
				esc(r.name),
				PRODUCT_COST_RUPEES,
				paiseToRupees(r.gross_paise),
				paiseToRupees(r.net_earned_paise),
				paiseToRupees(r.forfeited_paise),
			].join(","),
		);

		// BOM so Excel opens UTF-8 Tamil names correctly (same as frontend exportCsv.ts)
		const csvContent = "﻿" + [CSV_HEADER, ...csvLines].join("\r\n") + "\r\n";

		const outDir = path.join(__dirname, "out");
		fs.mkdirSync(outDir, { recursive: true });
		const outPath = path.join(outDir, "weekly-earnings-reconstructed.csv");
		fs.writeFileSync(outPath, csvContent, "utf8");

		// ── 7. Console summary ────────────────────────────────────────────────────
		const winHeader = `${"Window".padEnd(4)}  ${"Period".padEnd(21)}  ${"Status".padEnd(7)}  ${"Earners".padStart(7)}  ${"Net earned".padStart(13)}  ${"Forfeited".padStart(12)}`;
		const winDivider = "─".repeat(winHeader.length);
		const winLines = windows.map((w) => {
			const period = `${formatDate(w.window_start)} → ${formatDate(w.window_end)}`;
			return [
				pad(w.window_id.toString(), 4),
				"  ",
				pad(period, 21),
				"  ",
				pad(w.status, 7),
				"  ",
				w.earners.toString().padStart(7),
				"  ",
				toRupees(w.net).padStart(13),
				"  ",
				toRupees(w.forfeited).padStart(12),
			].join("");
		});

		console.log(`
══════════════════════════════════════════════════════════════════════
  Weekly Earnings — Reconstructed (read-only, writes nothing)
══════════════════════════════════════════════════════════════════════

${winHeader}
${winDivider}
${winLines.join("\n")}
${winDivider}
TOTAL     ${"".padEnd(21)}  ${"".padEnd(7)}  ${rows.length.toString().padStart(7)} rows  ${toRupees(grandNet).padStart(13)}  ${toRupees(grandForfeited).padStart(12)}

Fidelity self-check (single-window cap = stored wallet):
  Method reproduces stored ₹9,70,000 wallet  : ${selfCheckPass ? "✅ PASS" : "❌ FAIL"}
  Stored wallet (ground truth)               : ${toRupees(storedWallet)}
  Method single-window net                   : ${toRupees(globalNet)}
  Stored forfeited                           : ${toRupees(storedForfeited)}
  Method single-window forfeited             : ${toRupees(globalForfeited)}

Orphan released accruals (outside all windows): ${orphans === 0n ? "✅ 0" : `❌ ${orphans} — investigate!`}

True totals vs current live report:
  Current live (all crammed into open window) : ${toRupees(storedWallet)} net, ${toRupees(storedForfeited)} forfeited
  Reconstructed correct (spread across weeks) : ${toRupees(grandNet)} net, ${toRupees(grandForfeited)} forfeited
  Difference (₹ recovered from over-capping) : ${toRupees(grandNet - storedWallet)}

CSV written to: ${outPath}
══════════════════════════════════════════════════════════════════════`);

		if (!selfCheckPass) {
			console.error(
				"\n[reconstructWeekly] FATAL: fidelity self-check failed.\n" +
					"The reconstruction method does not reproduce the stored wallet total.\n" +
					"Do NOT use the CSV — the numbers are wrong.  Investigate the query.\n",
			);
			process.exit(1);
		}

		if (orphans > 0n) {
			console.error(
				`\n[reconstructWeekly] WARNING: ${orphans} released accrual(s) fell outside all cutoff windows.\n` +
					"These were excluded from the CSV.  The totals are incomplete.\n",
			);
			process.exit(1);
		}
	} finally {
		await client.end();
	}
}

main().catch((err) => {
	console.error("[reconstructWeekly] fatal:", err);
	process.exit(1);
});
