/**
 * reportV2Balances.ts — read-only simulation: what should each member's wallet be
 * under the correct v2 carry-forward pair-matching income model?
 *
 * v1 (currently on production) was WRONG: it fanned ₹1000 out to the pair owner AND
 * every ancestor.  v2 (PLAN.md BR-7 / migration 038) pays the matching node ONLY.
 * This script computes the correct v2 wallet for every member and compares it against
 * the current (wrong) v1 wallet — purely for review; it writes NOTHING.
 *
 * Inputs (all read from the DB; all durable / append-only):
 *   member_counters.left_active / right_active  — verified == leg_activations MAX(seq)
 *   v2 qualification gate (services/qualification.ts:22-31, recomputed fresh)
 *   wallet_balances + accounts (current v1 wallet, for comparison only)
 *
 * Cap note: CUTOFF_CAP_PAISE = 10 000 000 paise = ₹1,00,000 = 100 pairs.
 *   ~2 nodes exceed the cap.  For those members the gross v2 number shown is the
 *   theoretical UNCAPPED amount; mark them over_cap_flag=true for manual review.
 *   The true capped amount depends on historical weekly cutoff attribution which
 *   cannot be reconstructed without a full write-back migration — out of scope here.
 *
 * Connects via PROD_DATABASE_URL (deliberately NOT the .env DATABASE_URL so it cannot
 * be pointed at the wrong host by accident) and forces the session READ ONLY — any
 * accidental write attempt will fail with "cannot execute ... in a read-only transaction".
 *
 * Output: per-member CSV to stdout and scripts/out/v2-balance-report.csv + summary.
 *
 * Usage:
 *   # against development copy (validate first):
 *   PROD_DATABASE_URL="$DATABASE_URL" npx tsx scripts/reportV2Balances.ts
 *
 *   # against production (read-only, explicit host required):
 *   PROD_DATABASE_URL='postgresql://postgres:<pw>@hayabusa.proxy.rlwy.net:53263/railway' \
 *     npx tsx scripts/reportV2Balances.ts
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

// ── constants (mirrors src/config.ts; no env-import so this script has zero side effects) ──
const PAIR_BONUS_PAISE = parseInt(process.env.PAIR_BONUS_PAISE ?? "100000", 10);  // ₹1000
const CUTOFF_CAP_PAISE = parseInt(process.env.CUTOFF_CAP_PAISE ?? "10000000", 10); // ₹1,00,000

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
	const url = process.env.PROD_DATABASE_URL;
	if (!url) {
		console.error(
			"[reportV2Balances] PROD_DATABASE_URL env var is required.\n" +
				"  Dev copy:   PROD_DATABASE_URL=$DATABASE_URL npx tsx scripts/reportV2Balances.ts\n" +
				"  Production: PROD_DATABASE_URL='postgresql://...' npx tsx scripts/reportV2Balances.ts",
		);
		process.exit(1);
	}

	const client = new pg.Client({ connectionString: url });
	await client.connect();

	try {
		// Force session read-only — any write would throw immediately
		await client.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
		await client.query("BEGIN READ ONLY");

		// ── single query: per-member v2 simulation ──────────────────────────────
		// Recomputes qualification from the v2 gate (services/qualification.ts:22-31)
		// without the NOT is_qualified transition guard — this is a static predicate.
		const { rows } = await client.query<{
			member_id: string;
			member_code: string;
			name: string;
			is_active: boolean;
			qualified_stored: boolean;
			qualified_recomputed: boolean;
			matchable_pairs: string;
			current_v1_wallet_paise: string | null;
		}>(`
      SELECT
        m.id                                        AS member_id,
        m.member_code,
        m.name,
        m.is_active,
        m.is_qualified                              AS qualified_stored,
        -- Recompute v2 gate (qualification.ts:22-31, without NOT is_qualified):
        -- active AND >=2 active sponsor-directs AND exists active grandchild under active direct
        (
          m.is_active
          AND (SELECT COUNT(*) FROM members r
                WHERE r.sponsor_id = m.id AND r.is_active) >= 2
          AND EXISTS (
            SELECT 1 FROM members r
            JOIN members g ON g.sponsor_id = r.id AND g.is_active
            WHERE r.sponsor_id = m.id AND r.is_active
          )
        )                                           AS qualified_recomputed,
        -- v2 matchable pairs from stored (verified) counters
        LEAST(mc.left_active, mc.right_active)      AS matchable_pairs,
        -- current (wrong) v1 wallet balance — may be NULL if no wallet account yet
        (
          SELECT wb.balance
            FROM wallet_balances wb
            JOIN accounts a ON a.id = wb.account_id
           WHERE a.owner_id = m.id AND a.kind = 'wallet'
           LIMIT 1
        )                                           AS current_v1_wallet_paise
      FROM members m
      JOIN member_counters mc ON mc.member_id = m.id
      -- exclude the off-tree management account (role=management, parent_id IS NULL)
      WHERE m.role <> 'management'
      ORDER BY m.id
    `);

		await client.query("COMMIT");

		// ── per-row computation ──────────────────────────────────────────────────
		type Row = {
			member_code: string;
			name: string;
			is_active: boolean;
			qualified_recomputed: boolean;
			qualified_stored: boolean;
			matchable_pairs: bigint;
			correct_v2_wallet_paise: bigint;
			held_pending_paise: bigint;
			current_v1_wallet_paise: bigint;
			delta_paise: bigint;
			over_cap_flag: boolean;
		};

		const computed: Row[] = [];
		let qualStoredMismatch = 0;

		for (const r of rows) {
			const matchable = BigInt(r.matchable_pairs);
			const qualified = r.qualified_recomputed;
			const grossPaise = matchable * BigInt(PAIR_BONUS_PAISE);

			// over_cap: gross exceeds one cutoff's cap
			const over_cap_flag = grossPaise > BigInt(CUTOFF_CAP_PAISE);

			// If qualified, gross goes to wallet (flag if over cap — actual capped value
			// cannot be reconstructed without historical attribution).
			// If not qualified, it stays held/pending.
			const correct_v2_wallet_paise = qualified ? grossPaise : 0n;
			const held_pending_paise = qualified ? 0n : grossPaise;

			// Current v1 wallet (NUMERIC(14,2) rupees in DB → stored as decimal string)
			// Convert from rupees to paise by multiplying by 100.
			const v1RupeeStr = r.current_v1_wallet_paise ?? "0";
			// NUMERIC(14,2) always has exactly 2 decimal places; strip dot and parse.
			const v1Paise = BigInt(v1RupeeStr.replace(".", ""));

			const delta_paise = correct_v2_wallet_paise - v1Paise;

			if (r.qualified_stored !== qualified) {
				qualStoredMismatch++;
				console.warn(
					`[WARN] qualification mismatch for ${r.member_code}: stored=${r.qualified_stored}, recomputed=${qualified}`,
				);
			}

			computed.push({
				member_code: r.member_code,
				name: r.name,
				is_active: r.is_active,
				qualified_recomputed: qualified,
				qualified_stored: r.qualified_stored,
				matchable_pairs: matchable,
				correct_v2_wallet_paise,
				held_pending_paise,
				current_v1_wallet_paise: v1Paise,
				delta_paise,
				over_cap_flag,
			});
		}

		// ── CSV output ───────────────────────────────────────────────────────────
		const CSV_HEADER =
			"member_code,name,is_active,qualified_recomputed,qualified_stored," +
			"matchable_pairs,correct_v2_wallet_paise,held_pending_paise," +
			"current_v1_wallet_paise,delta_paise,over_cap_flag";

		const csvLines = computed.map((r) =>
			[
				r.member_code,
				`"${r.name.replace(/"/g, '""')}"`,
				r.is_active,
				r.qualified_recomputed,
				r.qualified_stored,
				r.matchable_pairs.toString(),
				r.correct_v2_wallet_paise.toString(),
				r.held_pending_paise.toString(),
				r.current_v1_wallet_paise.toString(),
				r.delta_paise.toString(),
				r.over_cap_flag,
			].join(","),
		);

		const csvContent = [CSV_HEADER, ...csvLines].join("\n") + "\n";

		const outPath = path.join(__dirname, "out", "v2-balance-report.csv");
		fs.mkdirSync(path.dirname(outPath), { recursive: true });
		fs.writeFileSync(outPath, csvContent, "utf8");
		console.log(`\nCSV written to: ${outPath}`);

		// ── summary ───────────────────────────────────────────────────────────────
		const totalCorrectV2Wallet = computed.reduce((s, r) => s + r.correct_v2_wallet_paise, 0n);
		const totalHeldPending = computed.reduce((s, r) => s + r.held_pending_paise, 0n);
		const totalCurrentV1 = computed.reduce((s, r) => s + r.current_v1_wallet_paise, 0n);
		const totalDelta = computed.reduce((s, r) => s + r.delta_paise, 0n);

		const membersUp = computed.filter((r) => r.delta_paise > 0n).length;
		const membersDown = computed.filter((r) => r.delta_paise < 0n).length;
		const membersUnchanged = computed.filter((r) => r.delta_paise === 0n && r.matchable_pairs > 0n).length;
		const membersZero = computed.filter((r) => r.delta_paise === 0n && r.matchable_pairs === 0n).length;
		const overCapMembers = computed.filter((r) => r.over_cap_flag);

		const toRupees = (paise: bigint): string =>
			`₹${(Number(paise) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;

		const recomputedQualCount = computed.filter((r) => r.qualified_recomputed).length;
		const storedQualCount = computed.filter((r) => r.qualified_stored).length;

		console.log(`
══════════════════════════════════════════════════════════════
  v2 Balance Report — read-only simulation (writes nothing)
══════════════════════════════════════════════════════════════

Members analysed          : ${computed.length}
  Active                  : ${computed.filter((r) => r.is_active).length}
  Qualified (stored)      : ${storedQualCount}
  Qualified (recomputed)  : ${recomputedQualCount}  ${qualStoredMismatch > 0 ? `⚠️  ${qualStoredMismatch} mismatch(es)` : "✓ matches stored"}

Correct v2 wallet total   : ${toRupees(totalCorrectV2Wallet)}  (${(totalCorrectV2Wallet / BigInt(PAIR_BONUS_PAISE))} pairs × ₹1000)
Held pending (unqualified): ${toRupees(totalHeldPending)}
Current v1 wallet total   : ${toRupees(totalCurrentV1)}  (WRONG — includes ancestor fan-out)
Net delta (v2 − v1)       : ${toRupees(totalDelta)}

Members who gain (v2 > v1): ${membersUp}
Members who lose (v2 < v1): ${membersDown}
Members unchanged w/ pairs: ${membersUnchanged}
Members with 0 matchable  : ${membersZero}

Over-cap members (gross > ₹1,00,000 — manual review needed):
${
	overCapMembers.length === 0
		? "  (none)"
		: overCapMembers
				.map(
					(r) =>
						`  ${r.member_code}  ${r.name}  — ${r.matchable_pairs} pairs / gross ${toRupees(r.correct_v2_wallet_paise)} / stored v1 ${toRupees(r.current_v1_wallet_paise)}`,
				)
				.join("\n")
}

Note: over-cap members show UNCAPPED gross v2 amount.  The true
capped wallet under v2 depends on historical weekly cutoff attribution
and can only be determined during the write-back migration phase.

Verification anchors (should match prior session diagnostics):
  correct-v2 wallet ≈ ₹10,48,000 | held-pending ≈ ₹46,000 | v1 wallet ≈ ₹9,87,000
  recomputed qualified = stored = 119 | over-cap members = 2
══════════════════════════════════════════════════════════════`);
	} finally {
		await client.end();
	}
}

main().catch((err) => {
	console.error("[reportV2Balances] fatal:", err);
	process.exit(1);
});
