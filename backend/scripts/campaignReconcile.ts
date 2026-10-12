/**
 * campaignReconcile.ts — READ-ONLY per-node audit of campaign pair-matching accuracy.
 *
 * For every node with campaign activity this script computes:
 *
 *   actual   = member_counters.pairs_matched
 *            + campaign_member_counters.campaign_pairs_matched
 *   expected = LEAST(campaign_member_counters.left_units, right_units)   ← §4 formula
 *   drift    = actual − expected
 *
 *   drift =  0  → exact match
 *   drift >  0  → accepted over-pay (GREATEST clamp kept a pair the formula no longer
 *                 justifies; inherent — can't be avoided without clawback)
 *   drift <  0  → pending top-up (will mint on the node's next in-window event)
 *
 * Exits 1 if any node has drift < 0 — doubles as a post-campaign completeness check.
 * Writes nothing — safe to run against production.
 *
 * NOTE (since campaign tier-cap rule, Oct 2026): this script audits MINTING only.
 * Under the tier cap, matched ≫ released is normal and expected.
 * The payout release invariant is separate:
 *   paid = min(campaign_pairs_matched, campaignExtraUnits(package_value_paise))
 *   where campaignExtraUnits: ₹10k→0, ₹30k→2, ₹50k→4 (lifetime, not per-week).
 *
 * Usage:
 *   # dev copy (reads DATABASE_URL from .env):
 *   npx tsx scripts/campaignReconcile.ts
 *   # production (read-only — no writes performed):
 *   PROD_DATABASE_URL='postgresql://...@hayabusa...' npx tsx scripts/campaignReconcile.ts
 *   # show ALL nodes including drift=0:
 *   npx tsx scripts/campaignReconcile.ts --all
 */

import "dotenv/config";
import pg from "pg";

function rupees(paise: number): string {
	return `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;
}

async function main(): Promise<void> {
	const url = process.env.PROD_DATABASE_URL ?? process.env.DATABASE_URL;
	if (!url) {
		console.error(
			"[campaign-reconcile] No DATABASE_URL or PROD_DATABASE_URL found.\n" +
				"  dev copy:   npx tsx scripts/campaignReconcile.ts\n" +
				"  production: PROD_DATABASE_URL='postgresql://...@hayabusa...' npx tsx scripts/campaignReconcile.ts",
		);
		process.exit(1);
	}

	const showAll = process.argv.includes("--all");
	const host = url.includes("hayabusa")
		? "PRODUCTION (hayabusa)"
		: url.includes("tokaido")
		? "dev copy (tokaido)"
		: "unknown host";

	console.log(`[campaign-reconcile] READ-ONLY  host=${host}`);
	console.log(`[campaign-reconcile] Reporting ${showAll ? "ALL nodes" : "nodes with drift ≠ 0 only (pass --all to see all)"}\n`);

	const pool = new pg.Pool({ connectionString: url, max: 3 });

	try {
		// Fetch every node that has any campaign or live pair activity.
		const { rows } = await pool.query<{
			member_id: string;
			member_code: string;
			name: string;
			live_pairs: string;
			campaign_pairs: string;
			left_units: string;
			right_units: string;
			left_members: string;
			right_members: string;
		}>(
			`SELECT
			   m.id                                              AS member_id,
			   m.member_code,
			   m.name,
			   COALESCE(mc.pairs_matched,              0)       AS live_pairs,
			   COALESCE(cmc.campaign_pairs_matched,    0)       AS campaign_pairs,
			   COALESCE(cmc.left_units,                0)       AS left_units,
			   COALESCE(cmc.right_units,               0)       AS right_units,
			   COALESCE(cmc.left_members,              0)       AS left_members,
			   COALESCE(cmc.right_members,             0)       AS right_members
			 FROM members m
			 LEFT JOIN member_counters          mc  ON mc.member_id  = m.id
			 LEFT JOIN campaign_member_counters cmc ON cmc.member_id = m.id
			 WHERE cmc.member_id IS NOT NULL
			   AND (
			         COALESCE(mc.pairs_matched, 0) > 0
			      OR cmc.campaign_pairs_matched     > 0
			      OR cmc.left_units                 > 0
			      OR cmc.right_units                > 0
			   )
			 ORDER BY m.member_code`,
		);

		let nodesDrifted = 0;
		let totalOverPay = 0;   // sum of positive drifts (units)
		let totalUnderPay = 0;  // sum of negative drifts (units, as positive number)
		const underPaidCodes: string[] = [];

		for (const row of rows) {
			const livePairs = Number(row.live_pairs);
			const campaignPairs = Number(row.campaign_pairs);
			const leftUnits = Number(row.left_units);
			const rightUnits = Number(row.right_units);
			const leftMembers = Number(row.left_members);
			const rightMembers = Number(row.right_members);

			const actual = livePairs + campaignPairs;
			const expected = Math.min(leftUnits, rightUnits);
			const drift = actual - expected;

			if (!showAll && drift === 0) continue;

			const T = Math.min(leftUnits, rightUnits);
			const B = Math.min(leftMembers, rightMembers);
			const driftSign = drift > 0 ? "+" : "";
			console.log(
				`${row.member_code.padEnd(12)}  ${row.name.substring(0, 24).padEnd(24)}` +
				`  actual=${String(actual).padStart(4)} (live=${livePairs}+cmp=${campaignPairs})` +
				`  expected=${String(expected).padStart(4)}` +
				`  drift=${driftSign}${drift}`,
			);
			if (drift !== 0) {
				console.log(
					`              Lu=${leftUnits} Ru=${rightUnits}  Lm=${leftMembers} Rm=${rightMembers}` +
					`  T=${T}  B=${B}  T-B=${T - B}  campaign_target=${T - B >= 0 ? T - B : 0}`,
				);
				nodesDrifted++;
				if (drift > 0) {
					totalOverPay += drift;
				} else {
					totalUnderPay += -drift;
					underPaidCodes.push(row.member_code);
				}
			}
		}

		const PAIR_BONUS_PAISE = 100_000; // ₹1,000 per pair
		console.log("\n── Summary ─────────────────────────────────────────────────────────────────");
		console.log(`  Total nodes with campaign activity:  ${rows.length}`);
		console.log(`  Nodes with drift ≠ 0:                ${nodesDrifted}`);

		if (totalOverPay > 0) {
			console.log(
				`  Over-paid  (drift > 0):  ${totalOverPay} extra pair${totalOverPay === 1 ? "" : "s"}` +
				`  = ${rupees(totalOverPay * PAIR_BONUS_PAISE)}` +
				`  (accepted — GREATEST clamp, no clawback path)`,
			);
		} else {
			console.log(`  Over-paid  (drift > 0):  none`);
		}

		if (totalUnderPay > 0) {
			console.log(
				`  Under-paid (drift < 0):  ${totalUnderPay} missing pair${totalUnderPay === 1 ? "" : "s"}` +
				`  = ${rupees(totalUnderPay * PAIR_BONUS_PAISE)}` +
				`  → ${underPaidCodes.join(", ")}`,
			);
			console.log(
				`\n[campaign-reconcile] ⚠️  ${underPaidCodes.length} node${underPaidCodes.length === 1 ? "" : "s"}` +
				` still under-paid. They will top up on their next in-window CampaignUnitsAdded event.`,
			);
			process.exit(1);
		} else {
			console.log(
				`  Under-paid (drift < 0):  none`,
			);
			console.log(
				`\n[campaign-reconcile] ✓  No under-paid nodes. Campaign matching is consistent with §4.`,
			);
		}
	} finally {
		await pool.end();
	}
}

main().catch((err) => {
	console.error("[campaign-reconcile] Fatal:", err);
	process.exit(1);
});
