import { mkdir, writeFile } from "fs/promises";
import { DateTime } from "luxon";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { CFG } from "../config.js";
import { pool } from "../lib/db.js";
import { toPaise } from "../lib/money.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..", "..", "out");

interface Alert {
	type: string;
	memberId: string;
	memberCode: string;
	field: string;
	stored: string;
	computed: string;
}

export async function reconcile(): Promise<Alert[]> {
	const alerts: Alert[] = [];

	// Sample 500 random active members for counter check
	const { rows: counterSample } = await pool().query<{
		id: string;
		member_code: string;
		left_active: string;
		right_active: string;
	}>(
		`SELECT m.id, m.member_code, mc.left_active, mc.right_active
     FROM members m
     JOIN member_counters mc ON mc.member_id = m.id
     WHERE m.is_active = TRUE
     ORDER BY random()
     LIMIT 500`,
	);

	for (const row of counterSample) {
		// Recompute left/right_active from leg_activations MAX(seq)
		const { rows: laRows } = await pool().query<{
			side: string;
			max_seq: string;
		}>(
			`SELECT side, MAX(seq) AS max_seq
       FROM leg_activations WHERE ancestor_id=$1 GROUP BY side`,
			[row.id],
		);
		const computedLeft = Number(
			laRows.find((r) => r.side === "L")?.max_seq ?? "0",
		);
		const computedRight = Number(
			laRows.find((r) => r.side === "R")?.max_seq ?? "0",
		);

		if (computedLeft !== Number(row.left_active)) {
			alerts.push({
				type: "counter_drift",
				memberId: row.id,
				memberCode: row.member_code,
				field: "left_active",
				stored: row.left_active,
				computed: String(computedLeft),
			});
		}
		if (computedRight !== Number(row.right_active)) {
			alerts.push({
				type: "counter_drift",
				memberId: row.id,
				memberCode: row.member_code,
				field: "right_active",
				stored: row.right_active,
				computed: String(computedRight),
			});
		}

	}

	// Every released accrual must have its ledger txn (pairbonus:{pair_id}:{beneficiary_id})
	const { rows: orphanReleased } = await pool().query<{
		id: string;
		pair_id: string;
		beneficiary_id: string;
		member_code: string;
	}>(
		`SELECT pa.id, pa.pair_id, pa.beneficiary_id, m.member_code
     FROM pair_accruals pa
     JOIN members m ON m.id = pa.beneficiary_id
     WHERE pa.status = 'released'
       AND NOT EXISTS (
         SELECT 1 FROM ledger_txns lt
         WHERE lt.idempotency_key = 'pairbonus:' || pa.pair_id || ':' || pa.beneficiary_id
       )
     LIMIT 100`,
	);
	for (const row of orphanReleased) {
		alerts.push({
			type: "accrual_release_drift",
			memberId: row.beneficiary_id,
			memberCode: row.member_code,
			field: "pair_accruals.status",
			stored: "released",
			computed: `no ledger_txn pairbonus:${row.pair_id}:${row.beneficiary_id}`,
		});
	}

	// Pending accruals may only belong to unqualified beneficiaries.
	// 1h grace: release flows through the ledger consumer asynchronously.
	const { rows: stuckPending } = await pool().query<{
		id: string;
		beneficiary_id: string;
		member_code: string;
	}>(
		`SELECT pa.id, pa.beneficiary_id, m.member_code
     FROM pair_accruals pa
     JOIN members m ON m.id = pa.beneficiary_id
     WHERE pa.status = 'pending' AND m.is_qualified
       AND pa.accrued_at < now() - interval '1 hour'
       AND m.qualified_at < now() - interval '1 hour'
     LIMIT 100`,
	);
	for (const row of stuckPending) {
		alerts.push({
			type: "accrual_pending_drift",
			memberId: row.beneficiary_id,
			memberCode: row.member_code,
			field: "pair_accruals.status",
			stored: "pending",
			computed: "beneficiary is_qualified=TRUE — release missing",
		});
	}

	// Sample 200 random wallet balances vs SUM(ledger)
	const { rows: walletSample } = await pool().query<{
		account_id: string;
		member_code: string;
		balance: string;
	}>(
		`SELECT wb.account_id, m.member_code, wb.balance
     FROM wallet_balances wb
     JOIN accounts a ON a.id = wb.account_id
     JOIN members m ON m.id = a.owner_id
     WHERE a.kind='wallet'
     ORDER BY random()
     LIMIT 200`,
	);

	for (const row of walletSample) {
		const { rows: ledgerRows } = await pool().query<{ net: string }>(
			`SELECT COALESCE(
         SUM(CASE WHEN direction='C' THEN amount ELSE -amount END), 0
       ) AS net
       FROM ledger_entries WHERE account_id=$1`,
			[row.account_id],
		);
		const computedBalance = toPaise(ledgerRows[0].net);
		const storedBalance = toPaise(row.balance);
		if (computedBalance !== storedBalance) {
			alerts.push({
				type: "wallet_drift",
				memberId: row.account_id,
				memberCode: row.member_code,
				field: "balance",
				stored: row.balance,
				computed: String(computedBalance),
			});
		}
	}

	if (alerts.length > 0) {
		console.error(
			`[reconciler] CRITICAL: ${alerts.length} drift(s) detected`,
			alerts.slice(0, 5),
		);
		await mkdir(OUT_DIR, { recursive: true });
		const file = join(
			OUT_DIR,
			`reconciliation_alerts_${new Date().toISOString().slice(0, 10)}.json`,
		);
		await writeFile(file, JSON.stringify(alerts, null, 2), "utf-8");
	} else {
		console.log("[reconciler] no drift detected");
	}

	return alerts;
}

// Cron: nightly 02:00 IST
export async function run() {
	console.log("[reconciler] started");
	setInterval(async () => {
		try {
			const now = DateTime.now().setZone(CFG.TZ);
			if (now.hour === 2 && now.minute === 0 && now.second < 60) {
				console.log("[reconciler] running nightly check");
				await reconcile();
			}
		} catch (err) {
			console.error("[reconciler] error", err);
		}
	}, 60_000);
}

const _argv1 = process.argv[1] ?? "";
if (_argv1.endsWith("reconciler.ts") || _argv1.endsWith("reconciler.js")) {
	run().catch((err) => {
		console.error("[reconciler] fatal", err);
		process.exit(1);
	});
}
