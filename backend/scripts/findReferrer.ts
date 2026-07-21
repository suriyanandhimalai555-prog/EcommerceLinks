/**
 * findReferrer.ts — read-only lookup: who referred (sponsored) a member?
 *
 * Connects to the database given in PROD_DATABASE_URL (deliberately NOT the
 * DATABASE_URL from .env, so it can never be pointed at the wrong DB by
 * accident) and forces the session read-only before issuing any query —
 * a write attempt would fail with "cannot execute ... in a read-only transaction".
 *
 * Usage:
 *   PROD_DATABASE_URL='postgresql://user:pass@hayabusa.proxy.rlwy.net:53263/railway' \
 *     npx tsx scripts/findReferrer.ts venkatesanvenkat5658@gmail.com
 */

import pg from "pg";

async function main(): Promise<void> {
	const email = process.argv[2];
	if (!email) {
		console.error("Usage: npx tsx scripts/findReferrer.ts <email>");
		process.exit(1);
	}
	const url = process.env.PROD_DATABASE_URL;
	if (!url) {
		console.error(
			"[findReferrer] PROD_DATABASE_URL env var is required. Pass the production " +
				"connection string explicitly, e.g.\n" +
				"  PROD_DATABASE_URL='postgresql://...' npx tsx scripts/findReferrer.ts <email>",
		);
		process.exit(1);
	}

	const client = new pg.Client({ connectionString: url });
	await client.connect();
	try {
		await client.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
		await client.query("BEGIN READ ONLY");

		const { rows } = await client.query(
			`SELECT m.id, m.member_code, m.name, m.email, m.phone, m.is_active,
			        m.created_at, m.position,
			        s.member_code AS sponsor_code, s.name AS sponsor_name,
			        s.email AS sponsor_email, s.phone AS sponsor_phone,
			        p.member_code AS parent_code, p.name AS parent_name
			   FROM members m
			   LEFT JOIN members s ON s.id = m.sponsor_id
			   LEFT JOIN members p ON p.id = m.parent_id
			  WHERE lower(m.email) = lower($1)`,
			[email.trim()],
		);
		await client.query("COMMIT");

		if (rows.length === 0) {
			console.log(`No member found with email ${email}`);
			return;
		}
		for (const r of rows) {
			console.log("Member:");
			console.log(`  ${r.member_code}  ${r.name}  <${r.email}>  phone ${r.phone}`);
			console.log(`  active: ${r.is_active}  joined: ${r.created_at.toISOString()}`);
			if (r.sponsor_code) {
				console.log("Referred by (sponsor):");
				console.log(
					`  ${r.sponsor_code}  ${r.sponsor_name}  <${r.sponsor_email ?? "no email"}>  phone ${r.sponsor_phone}`,
				);
			} else {
				console.log("Referred by: nobody (no sponsor — tree root)");
			}
			if (r.parent_code) {
				console.log(
					`Placement parent (binary tree): ${r.parent_code}  ${r.parent_name}  (position ${r.position})`,
				);
			}
		}
	} finally {
		await client.end();
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
