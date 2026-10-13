/**
 * campaignReconcile.ts — READ-ONLY per-node audit of campaign pair-matching accuracy.
 *
 * For every node with campaign activity this script computes:
 *
 *   actual   = member_counters.pairs_matched          (live)
 *            + campaign_member_counters.campaign_pairs_matched  (campaign top-up)
 *   t_prime  = LEAST(ΣuL, ΣuR, u_self × LEAST(Lh, Rh))
 *              WHOLE-LEG unit matching (official poster: "total package value").
 *              ΣuL/ΣuR = total units across the whole left/right leg.
 *              Lh/Rh   = total head counts of left/right leg.
 *              u_self  = earner's own tier (₹10k→1, ₹30k→3, ₹50k→5).
 *              Mirrors campaignCounter.ts formula exactly (Oct-2026, Image #7 poster).
 *   b_eff    = LEAST(Lh, Rh) — the headcount the live engine paid
 *   expected = t_prime   — the unit-weighted total that live + campaign together should pay
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
 * NOTE: this script audits MINTING only (not payout/release).
 * ₹10k earners naturally mint 0 campaign pairs: u_self=1 → T' = Σ min(h_d) ≤ B → surplus=0.
 * All minted campaign pairs belong to ≥₹30k earners and release immediately.
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

// Campaign tier thresholds in paise (keep in sync with CFG in src/config.ts).
const TIER_50K_PAISE = 5_000_000;
const TIER_30K_PAISE = 3_000_000;
const TIER_10K_PAISE = 1_000_000; // ₹10,000 canonical base product

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
		// t_prime = Σ_k min(uL_k, uR_k) computed from leg_activations ⋈ members,
		// b_eff   = count of matched levels (headcount base the live engine paid).
		// These are the same quantities computed by campaignCounter.ts per-event.
		const { rows } = await pool.query<{
			member_id: string;
			member_code: string;
			name: string;
			live_pairs: string;
			campaign_pairs: string;
			t_prime: string;
			b_eff: string;
			// kept for display/debugging — still maintained for CHECK constraint
			left_units: string;
			right_units: string;
			left_members: string;
			right_members: string;
		}>(
			`WITH legs_raw AS (
			   -- All activations with units; one row per activation.
			   SELECT
			     la.ancestor_id,
			     la.side,
			     CASE
			       WHEN m.package_value_paise >= $1 THEN 5
			       WHEN m.package_value_paise >= $2 THEN 3
			       WHEN m.package_value_paise = $3  THEN 1
			       ELSE 0
			     END AS units
			   FROM leg_activations la
			   JOIN members m ON m.id = la.member_id
			 ),
			 self_units AS (
			   -- Earner's own tier units for each ancestor with any campaign activity.
			   SELECT
			     cmc.member_id,
			     CASE
			       WHEN ms.package_value_paise >= $1 THEN 5
			       WHEN ms.package_value_paise >= $2 THEN 3
			       WHEN ms.package_value_paise = $3  THEN 1
			       ELSE 0
			     END AS u_self
			   FROM campaign_member_counters cmc
			   JOIN members ms ON ms.id = cmc.member_id
			 ),
			 per_node AS (
			   -- T' = LEAST(ΣuL, ΣuR, u_self × LEAST(Lh, Rh))  — whole-leg matching
			   -- B  = LEAST(total_L_heads, total_R_heads)        — live engine headcount
			   SELECT
			     lr.ancestor_id AS member_id,
			     LEAST(
			       COALESCE(SUM(lr.units) FILTER (WHERE lr.side='L'), 0),
			       COALESCE(SUM(lr.units) FILTER (WHERE lr.side='R'), 0),
			       (SELECT su.u_self FROM self_units su WHERE su.member_id = lr.ancestor_id) *
			       LEAST(
			         COUNT(*) FILTER (WHERE lr.side='L'),
			         COUNT(*) FILTER (WHERE lr.side='R'))
			     )::bigint AS t_prime,
			     LEAST(
			       COUNT(*) FILTER (WHERE lr.side='L'),
			       COUNT(*) FILTER (WHERE lr.side='R')
			     )::bigint AS b_eff
			   FROM legs_raw lr
			   JOIN self_units su ON su.member_id = lr.ancestor_id
			   GROUP BY lr.ancestor_id
			 )
			 SELECT
			   m.id                                              AS member_id,
			   m.member_code,
			   m.name,
			   COALESCE(mc.pairs_matched,              0)       AS live_pairs,
			   COALESCE(cmc.campaign_pairs_matched,    0)       AS campaign_pairs,
			   COALESCE(pn.t_prime,                    0)       AS t_prime,
			   COALESCE(pn.b_eff,                      0)       AS b_eff,
			   COALESCE(cmc.left_units,                0)       AS left_units,
			   COALESCE(cmc.right_units,               0)       AS right_units,
			   COALESCE(cmc.left_members,              0)       AS left_members,
			   COALESCE(cmc.right_members,             0)       AS right_members
			 FROM members m
			 LEFT JOIN member_counters          mc  ON mc.member_id  = m.id
			 LEFT JOIN campaign_member_counters cmc ON cmc.member_id = m.id
			 LEFT JOIN per_node                 pn  ON pn.member_id  = m.id
			 WHERE cmc.member_id IS NOT NULL
			   AND (
			         COALESCE(mc.pairs_matched, 0) > 0
			      OR cmc.campaign_pairs_matched     > 0
			      OR cmc.left_units                 > 0
			      OR cmc.right_units                > 0
			   )
			 ORDER BY m.member_code`,
			[TIER_50K_PAISE, TIER_30K_PAISE, TIER_10K_PAISE],
		);

		let nodesDrifted = 0;
		let totalOverPay = 0;   // sum of positive drifts (units)
		let totalUnderPay = 0;  // sum of negative drifts (units, as positive number)
		const underPaidCodes: string[] = [];

		for (const row of rows) {
			const livePairs     = Number(row.live_pairs);
			const campaignPairs = Number(row.campaign_pairs);
			const tPrime        = Number(row.t_prime);   // unit-weighted same-level match
			const bEff          = Number(row.b_eff);     // headcount base (matched levels)
			const leftUnits     = Number(row.left_units);
			const rightUnits    = Number(row.right_units);
			const leftMembers   = Number(row.left_members);
			const rightMembers  = Number(row.right_members);

			const actual   = livePairs + campaignPairs;
			// expected = t_prime (unit-weighted total; live pays b_eff, campaign pays t_prime-b_eff)
			const expected = tPrime;
			const drift    = actual - expected;

			if (!showAll && drift === 0) continue;

			const surplus  = Math.max(0, tPrime - bEff);
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
					`  T'=${tPrime}  B_eff=${bEff}  T'-B_eff=${surplus}  campaign_target=${surplus}`,
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

		const PAIR_BONUS_PAISE = 100_000; // ₹1,000 per live pair (campaign top-up also ₹1,000/unit)
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
