import "dotenv/config";
import { CFG } from "../src/config.js";
import { pool, withTxn } from "../src/lib/db.js";
import { redis } from "../src/lib/redis.js";
import { seedRoot } from "./seedRoot.js";

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

	if (!process.argv.includes("--yes")) {
		console.log(`\nRefusing: this DELETES ALL DATA on`);
		console.log(`  host:    ${dbHost}`);
		console.log(`  members: ${members}`);
		console.log(`  orders:  ${orders}`);
		console.log(`  pairs:   ${pairs}`);
		console.log(`\nStop any running workers first, then re-run with:`);
		console.log(`  npm run reset -- --yes\n`);
		await pool().end();
		process.exit(1);
	}

	// ── 2. Truncate all transactional tables ──────────────────────────────────
	// Excludes: products (reference data seeded by 003_commerce.sql)
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
        orders, events_outbox, processed_events, refresh_tokens
      RESTART IDENTITY CASCADE
    `);
	});
	console.log("  ✓ database truncated");

	// ── 3. Restore reference data seeded by migrations ───────────────────────
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

	// ── 5. Flush Redis transport ───────────────────────────────────────────────
	// Redis is transport-only (losing it loses no data per CLAUDE.md).
	// Must flush: stale stream entries would replay into a fresh DB and
	// resurrect deleted counters/pairs.
	await redis().flushdb();
	console.log("  ✓ Redis flushed");

	// ── 6. Re-seed root admin + open cutoff window ────────────────────────────
	await seedRoot();
	console.log("  ✓ root admin re-seeded");

	// ── 7. Cleanup ────────────────────────────────────────────────────────────
	await pool().end();
	await redis().quit();

	console.log(`
Done. DB is clean.
  Login: root@avg.com / Root@1234  (role: admin)
`);
}

reset().catch((err) => {
	console.error("reset failed:", err);
	process.exit(1);
});
