import "dotenv/config";
import { CFG } from "../src/config.js";
import { pool, withTxn } from "../src/lib/db.js";
import { redis } from "../src/lib/redis.js";
import { seedManagement } from "./seedManagement.js";
import { ROOT_SEED_EMAIL, seedRoot } from "./seedRoot.js";

async function reset() {
	// ── 1. Guard ──────────────────────────────────────────────────────────────
	// Parse host from DATABASE_URL (mask credentials before printing)
	let dbHost = "(unknown host)";
	try {
		const u = new URL(CFG.DATABASE_URL);
		dbHost = u.hostname;
	} catch {
		/* ignore parse errors */
	}

	// Show current row counts so the user knows what will be deleted
	const counts = await pool().query<{
		members: string;
		orders: string;
		pairs: string;
	}>(`
    SELECT
      (SELECT COUNT(*) FROM members)::text AS members,
      (SELECT COUNT(*) FROM orders)::text  AS orders,
      (SELECT COUNT(*) FROM pairs)::text   AS pairs
  `);
	const { members, orders, pairs } = counts.rows[0];

	// Pre-flight: seedRoot throws without this — fail BEFORE the truncate, not
	// after, so a missing env var can't leave a wiped DB with no root account.
	if (!process.env.ROOT_SEED_PASSWORD) {
		console.error(
			"Refusing: ROOT_SEED_PASSWORD is not set — the wipe would succeed but " +
				"re-seeding the root would fail, leaving an empty DB. Set it in .env first.",
		);
		await pool().end();
		process.exit(1);
	}

	if (!process.argv.includes("--yes")) {
		console.log(`\nRefusing: this DELETES ALL DATA on`);
		console.log(`  host:    ${dbHost}`);
		console.log(`  members: ${members}`);
		console.log(`  orders:  ${orders}`);
		console.log(`  pairs:   ${pairs}`);
		console.log(`\nKept: products catalog + the management master account.`);
		console.log(`Removed: everything else, including the old tree root.`);
		console.log(`\nStop any running workers first, then re-run with:`);
		console.log(`  npm run reset -- --yes\n`);
		await pool().end();
		process.exit(1);
	}

	// ── 2. Capture the management master account ─────────────────────────────
	// The off-tree management account must survive the wipe with its CURRENT
	// password hash (re-seeding from MGMT_SEED_PASSWORD would silently reset a
	// rotated password). Captured here, re-inserted after the truncate.
	const { rows: mgmtRows } = await pool().query<{
		member_code: string;
		name: string;
		phone: string;
		email: string;
		password_hash: string;
		kyc_status: string;
	}>(
		`SELECT member_code, name, phone, email, password_hash, kyc_status
     FROM members WHERE role = 'management'
     ORDER BY (email = 'management@avg.com') DESC, id ASC
     LIMIT 1`,
	);
	const mgmt = mgmtRows[0];

	// ── 3. Truncate all transactional tables ──────────────────────────────────
	// Excludes: products + product_images (catalog reference data)
	//           schema_migrations (migration tracking — owned by db/migrate.ts)
	console.log(`\nWiping all data on ${dbHost} …`);
	await withTxn(async (c) => {
		await c.query(`
      TRUNCATE
        members, member_counters, leg_activations, leg_rank_counters,
        accounts, wallet_balances, ledger_txns, ledger_entries,
        cutoffs, cutoff_earnings,
        pairs, rank_achievements,
        payout_batches, payout_items, withdrawals,
        orders, events_outbox, processed_events, refresh_tokens,
        admin_audit_log, dead_letters, kyc_documents
      RESTART IDENTITY CASCADE
    `);
	});
	console.log("  ✓ database truncated");

	// ── 4. Restore reference data seeded by migrations ───────────────────────
	// Two migrations INSERT static reference data that must survive every reset:
	//   003_commerce.sql  → products (preserved via TRUNCATE exclusion above)
	//   004_ledger.sql    → 4 system accounts (bonus_expense, payout_clearing,
	//                        tds_payable, bank) — must be re-inserted after truncate
	//                        because the TRUNCATE above wipes accounts CASCADE.
	//   Without these, creditPairBonus throws on SELECT bonus_expense → wallet never credits.
	await pool().query(`
    INSERT INTO accounts (owner_type, owner_id, kind) VALUES
      ('system', NULL, 'bonus_expense'),
      ('system', NULL, 'payout_clearing'),
      ('system', NULL, 'tds_payable'),
      ('system', NULL, 'bank'),
      ('system', NULL, 'adjustment')
  `);
	console.log("  ✓ system accounts restored");

	// ── 5. Restore the management master account ──────────────────────────────
	if (mgmt) {
		await withTxn(async (c) => {
			const { rows } = await c.query<{ id: string }>(
				`INSERT INTO members
           (member_code, name, phone, email, password_hash,
            sponsor_id, parent_id, position,
            placement_path, placement_sides,
            is_active, activated_at, role, kyc_status)
         VALUES ($1,$2,$3,$4,$5,
                 NULL,NULL,NULL,'{}','{}',TRUE,now(),'management',$6)
         RETURNING id`,
				[mgmt.member_code, mgmt.name, mgmt.phone, mgmt.email, mgmt.password_hash, mgmt.kyc_status],
			);
			const mgmtId = BigInt(rows[0].id);
			await c.query("INSERT INTO member_counters (member_id) VALUES ($1)", [mgmtId]);
			const { rows: wRows } = await c.query<{ id: string }>(
				`INSERT INTO accounts (owner_type, owner_id, kind) VALUES ('member',$1,'wallet') RETURNING id`,
				[mgmtId],
			);
			const { rows: dRows } = await c.query<{ id: string }>(
				`INSERT INTO accounts (owner_type, owner_id, kind) VALUES ('member',$1,'deferred_bonus') RETURNING id`,
				[mgmtId],
			);
			await c.query(
				"INSERT INTO wallet_balances (account_id, balance) VALUES ($1,0),($2,0)",
				[wRows[0].id, dRows[0].id],
			);
		});
		console.log(`  ✓ management account restored (${mgmt.email}, password unchanged)`);
	} else if (process.env.MGMT_SEED_PASSWORD) {
		await seedManagement();
		console.log("  ✓ management account seeded (none existed before the wipe)");
	} else {
		console.warn(
			"  ⚠ no management account existed and MGMT_SEED_PASSWORD is not set — " +
				"run `npm run seed:management` afterwards or there is no admin login.",
		);
	}

	// ── 6. Flush Redis transport ───────────────────────────────────────────────
	// Redis is transport-only (losing it loses no data per CLAUDE.md).
	// Must flush: stale stream entries would replay into a fresh DB and
	// resurrect deleted counters/pairs.
	await redis().flushdb();
	console.log("  ✓ Redis flushed");

	// ── 7. Seed the fresh tree root + open cutoff window ──────────────────────
	await seedRoot();
	// Three-tier roles: the tree root is a business account, not an admin —
	// demote it whenever a management account holds admin control (same guard
	// as seedManagement: never demote if it would leave zero admin logins).
	const { rowCount: demoted } = await pool().query(
		`UPDATE members SET role = 'member'
     WHERE parent_id IS NULL AND role = 'admin'
       AND EXISTS (SELECT 1 FROM members WHERE role = 'management')`,
	);
	console.log(
		`  ✓ tree root seeded${demoted ? " (role=member — admin control stays on the management account)" : ""}`,
	);

	// ── 8. Cleanup ────────────────────────────────────────────────────────────
	await pool().end();
	await redis().quit();

	console.log(`
Done. DB is clean.
  Tree root:  ${ROOT_SEED_EMAIL} / $ROOT_SEED_PASSWORD  (role: ${demoted ? "member" : "admin"})
  Management: ${mgmt ? `${mgmt.email} (password unchanged)` : "see seed:management"}
`);
}

reset().catch((err) => {
	console.error("reset failed:", err);
	process.exit(1);
});
