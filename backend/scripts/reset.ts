import "dotenv/config";
import { CFG } from "../src/config.js";
import { pool, withTxn } from "../src/lib/db.js";
import { redis } from "../src/lib/redis.js";
import { MGMT_RESERVED_ID, seedManagement } from "./seedManagement.js";
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
        members, member_counters, member_code_counter,
        leg_activations, leg_rank_counters,
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
	// Re-initialize the gapless member code counter (starts at 1 for root).
	await pool().query(
		"INSERT INTO member_code_counter (id, next_val) VALUES (1, 1)",
	);
	// System accounts from 004_ledger.sql — wiped by CASCADE above.
	await pool().query(`
    INSERT INTO accounts (owner_type, owner_id, kind) VALUES
      ('system', NULL, 'bonus_expense'),
      ('system', NULL, 'payout_clearing'),
      ('system', NULL, 'tds_payable'),
      ('system', NULL, 'bank'),
      ('system', NULL, 'adjustment')
  `);
	console.log("  ✓ system accounts + member code counter restored");

	// ── 5. Flush Redis transport ───────────────────────────────────────────────
	// Redis is transport-only (losing it loses no data per CLAUDE.md).
	// Must flush: stale stream entries would replay into a fresh DB and
	// resurrect deleted counters/pairs.
	await redis().flushdb();
	console.log("  ✓ Redis flushed");

	// ── 6. Seed the fresh tree root FIRST ────────────────────────────────────
	// Root is seeded before the management account so it gets id=1 from the
	// freshly-reset IDENTITY sequence → AVG100001. Management uses a reserved
	// high ID (OVERRIDING SYSTEM VALUE) so it never consumes a regular slot.
	await seedRoot();
	console.log("  ✓ tree root seeded (id=1 → AVG100001)");

	// ── 7. Restore the management master account (reserved high ID) ──────────
	if (mgmt) {
		await withTxn(async (c) => {
			await c.query(
				`INSERT INTO members
           (id, member_code, name, phone, email, password_hash,
            sponsor_id, parent_id, position,
            placement_path, placement_sides,
            is_active, activated_at, role, kyc_status)
         OVERRIDING SYSTEM VALUE
         VALUES ($1,$2,$3,$4,$5,$6,
                 NULL,NULL,NULL,'{}','{}',TRUE,now(),'management',$7)`,
				[MGMT_RESERVED_ID, mgmt.member_code, mgmt.name, mgmt.phone, mgmt.email, mgmt.password_hash, mgmt.kyc_status],
			);
			await c.query("INSERT INTO member_counters (member_id) VALUES ($1)", [MGMT_RESERVED_ID]);
			const { rows: wRows } = await c.query<{ id: string }>(
				`INSERT INTO accounts (owner_type, owner_id, kind) VALUES ('member',$1,'wallet') RETURNING id`,
				[MGMT_RESERVED_ID],
			);
			const { rows: dRows } = await c.query<{ id: string }>(
				`INSERT INTO accounts (owner_type, owner_id, kind) VALUES ('member',$1,'deferred_bonus') RETURNING id`,
				[MGMT_RESERVED_ID],
			);
			await c.query(
				"INSERT INTO wallet_balances (account_id, balance) VALUES ($1,0),($2,0)",
				[wRows[0].id, dRows[0].id],
			);
		});
		console.log(`  ✓ management account restored (${mgmt.email}, reserved id=${MGMT_RESERVED_ID})`);
	} else if (process.env.MGMT_SEED_PASSWORD) {
		await seedManagement();
		console.log("  ✓ management account seeded (none existed before the wipe)");
	} else {
		console.warn(
			"  ⚠ no management account existed and MGMT_SEED_PASSWORD is not set — " +
				"run `npm run seed:management` afterwards or there is no admin login.",
		);
	}

	// Demote root to member if a management account exists (separation of duties)
	const { rowCount: demoted } = await pool().query(
		`UPDATE members SET role = 'member'
     WHERE parent_id IS NULL AND role = 'admin'
       AND EXISTS (SELECT 1 FROM members WHERE role = 'management')`,
	);
	if (demoted) {
		console.log("  ✓ tree root demoted to role=member (admin control on management account)");
	}

	// ── 8. Cleanup ────────────────────────────────────────────────────────────
	await pool().end();
	await redis().quit();

	console.log(`
Done. DB is clean.
  Tree root:  ${ROOT_SEED_EMAIL} / $ROOT_SEED_PASSWORD  (AVG100001)
  Management: ${mgmt ? `${mgmt.email} (password unchanged, reserved id=${MGMT_RESERVED_ID})` : "see seed:management"}
`);
}

reset().catch((err) => {
	console.error("reset failed:", err);
	process.exit(1);
});
