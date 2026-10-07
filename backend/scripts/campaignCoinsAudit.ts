/**
 * campaignCoinsAudit.ts — READ-ONLY audit of AVG Coin grant correctness.
 *
 * For every member with ≥1 avg_coin_grants row this script computes:
 *
 *   granted  = SUM(avg_coin_grants.coins)
 *   expected = coinsForPackageValuePaise(members.package_value_paise)
 *              (₹30k → 250, ₹50k → 500; any other tier → 0)
 *   drift    = granted − expected
 *
 *   drift =  0  → correct
 *   drift >  0  → over-granted (the pre-fix two-step ₹10k→₹30k→₹50k path gave 750 not 500)
 *   drift <  0  → under-granted (should not occur; signals a missed grant)
 *
 * Exits 1 if any member has drift ≠ 0.
 * Writes nothing — safe to run against production.
 *
 * Usage:
 *   # dev copy (reads DATABASE_URL from .env):
 *   npx tsx scripts/campaignCoinsAudit.ts
 *   # production (read-only — no writes performed):
 *   PROD_DATABASE_URL='postgresql://...@hayabusa...' npx tsx scripts/campaignCoinsAudit.ts
 *   # show ALL members including drift=0:
 *   npx tsx scripts/campaignCoinsAudit.ts --all
 */

import "dotenv/config";
import pg from "pg";

/** Mirrors coinsForPackageValuePaise in src/lib/campaign.ts — cannot import it here (tsx env) */
function expectedCoins(packageValuePaise: number): number {
	const TIER_50K = 5_000_000;
	const TIER_30K = 3_000_000;
	if (packageValuePaise >= TIER_50K) return 500;
	if (packageValuePaise >= TIER_30K) return 250;
	return 0;
}

async function main(): Promise<void> {
	const url = process.env.PROD_DATABASE_URL ?? process.env.DATABASE_URL;
	if (!url) {
		console.error(
			"[campaign-coins-audit] No DATABASE_URL or PROD_DATABASE_URL found.\n" +
				"  dev copy:   npx tsx scripts/campaignCoinsAudit.ts\n" +
				"  production: PROD_DATABASE_URL='postgresql://...@hayabusa...' npx tsx scripts/campaignCoinsAudit.ts",
		);
		process.exit(1);
	}

	const showAll = process.argv.includes("--all");
	const host = url.includes("hayabusa")
		? "PRODUCTION (hayabusa)"
		: url.includes("tokaido")
		? "dev copy (tokaido)"
		: "unknown host";

	console.log(`[campaign-coins-audit] READ-ONLY  host=${host}`);
	console.log(
		`[campaign-coins-audit] Reporting ${
			showAll ? "ALL members with grants" : "members with drift ≠ 0 only (pass --all to see all)"
		}\n`,
	);

	const pool = new pg.Pool({ connectionString: url, max: 3 });

	try {
		const { rows } = await pool.query<{
			member_id: string;
			member_code: string;
			name: string;
			package_value_paise: string;
			granted: string;
			grant_count: string;
		}>(
			`SELECT
			   m.id                           AS member_id,
			   m.member_code,
			   m.name,
			   m.package_value_paise,
			   COALESCE(SUM(g.coins), 0)      AS granted,
			   COUNT(g.id)                    AS grant_count
			 FROM members m
			 JOIN avg_coin_grants g ON g.member_id = m.id
			 GROUP BY m.id, m.member_code, m.name, m.package_value_paise
			 ORDER BY m.member_code`,
		);

		let membersWithDrift = 0;
		let totalOverGrant = 0;
		let totalUnderGrant = 0;
		const overCodes: string[] = [];
		const underCodes: string[] = [];

		for (const row of rows) {
			const granted = Number(row.granted);
			const pkgPaise = Number(row.package_value_paise);
			const expected = expectedCoins(pkgPaise);
			const drift = granted - expected;

			if (!showAll && drift === 0) continue;

			const driftSign = drift > 0 ? "+" : drift < 0 ? "" : " ";
			const tierLabel =
				pkgPaise >= 5_000_000 ? "₹50k" :
				pkgPaise >= 3_000_000 ? "₹30k" : "₹10k";

			console.log(
				`${row.member_code.padEnd(12)}  ${row.name.substring(0, 24).padEnd(24)}` +
				`  pkg=${tierLabel}  granted=${granted}  expected=${expected}` +
				`  drift=${driftSign}${drift}  (${row.grant_count} grant row${Number(row.grant_count) === 1 ? "" : "s"})`,
			);

			if (drift !== 0) {
				membersWithDrift++;
				if (drift > 0) {
					totalOverGrant += drift;
					overCodes.push(row.member_code);
				} else {
					totalUnderGrant += -drift;
					underCodes.push(row.member_code);
				}
			}
		}

		console.log("\n── Summary ─────────────────────────────────────────────────────────────────");
		console.log(`  Total members with coin grants:  ${rows.length}`);
		console.log(`  Members with drift ≠ 0:          ${membersWithDrift}`);

		if (totalOverGrant > 0) {
			console.log(
				`  Over-granted  (drift > 0):  ${totalOverGrant} extra coin${totalOverGrant === 1 ? "" : "s"}` +
				`  → ${overCodes.join(", ")}`,
			);
			console.log(`    (likely caused by the pre-fix two-step upgrade path — owner to correct manually)`);
		} else {
			console.log(`  Over-granted  (drift > 0):  none`);
		}

		if (totalUnderGrant > 0) {
			console.log(
				`  Under-granted (drift < 0):  ${totalUnderGrant} missing coin${totalUnderGrant === 1 ? "" : "s"}` +
				`  → ${underCodes.join(", ")}`,
			);
		} else {
			console.log(`  Under-granted (drift < 0):  none`);
		}

		if (membersWithDrift > 0) {
			console.log(
				`\n[campaign-coins-audit] ⚠️  ${membersWithDrift} member${membersWithDrift === 1 ? "" : "s"}` +
				` with coin drift. Owner to review and correct manually.`,
			);
			process.exit(1);
		} else {
			console.log(
				`\n[campaign-coins-audit] ✓  All coin grants match expected tiers.`,
			);
		}
	} finally {
		await pool.end();
	}
}

main().catch((err) => {
	console.error("[campaign-coins-audit] Fatal:", err);
	process.exit(1);
});
