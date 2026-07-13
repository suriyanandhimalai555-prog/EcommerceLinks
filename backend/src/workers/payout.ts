import { randomUUID } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import { DateTime } from "luxon";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { CFG } from "../config.js";
import { writeOutbox } from "../events/outbox.js";
import { pool, withTxn } from "../lib/db.js";
import { fromPaise, pctRoundUp, toPaise } from "../lib/money.js";
import { postLedgerTxn } from "./ledger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..", "..", "out", "payouts");

/**
 * RFC-4180 quoting: wrap fields that contain commas, double-quotes, or newlines.
 * Double any embedded double-quotes. Prefix formula-start characters (=+-@) with
 * an apostrophe to prevent spreadsheet formula injection.
 */
export function csvQuote(field: string | number): string {
	const s = String(field);
	// Prefix Excel/Sheets formula injection characters
	const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
	// RFC-4180: quote if field contains comma, double-quote, or newline
	if (/[,"\n\r]/.test(safe)) {
		return `"${safe.replace(/"/g, '""')}"`;
	}
	return safe;
}

function csvRow(fields: (string | number)[]): string {
	return fields.map(csvQuote).join(",");
}

export async function buildBatch(payoutDay: DateTime): Promise<bigint> {
	const dateStr = payoutDay.toISODate()!;

	// ── Phase 1: create batch, items, and ledger txns in one transaction ─────────
	// Advisory lock prevents cron + admin-trigger from interleaving on the same date.
	const { batchId, totalNetPaise, itemCount } = await withTxn(async (c) => {
		await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
			`payout:${dateStr}`,
		]);

		const { rows: existing } = await c.query<{ id: string }>(
			`INSERT INTO payout_batches (scheduled_for, status) VALUES ($1,'building')
       ON CONFLICT (scheduled_for) DO NOTHING RETURNING id`,
			[dateStr],
		);

		let batchId: bigint;
		const isNew = !!existing[0];

		if (isNew) {
			batchId = BigInt(existing[0].id);
		} else {
			const { rows } = await c.query<{ id: string }>(
				"SELECT id FROM payout_batches WHERE scheduled_for=$1",
				[dateStr],
			);
			batchId = BigInt(rows[0].id);
		}

		// Get system accounts
		const { rows: sysAccs } = await c.query<{ id: string; kind: string }>(
			`SELECT id, kind FROM accounts WHERE owner_type='system'`,
		);
		const payoutClearingId = BigInt(
			sysAccs.find((a) => a.kind === "payout_clearing")!.id,
		);
		const tdsPayableId = BigInt(
			sysAccs.find((a) => a.kind === "tds_payable")!.id,
		);

		// Eligible members: kyc+bank verified, wallet ≥ MIN
		const minRupees = fromPaise(BigInt(CFG.MIN_PAYOUT_PAISE));
		const { rows: eligible } = await c.query<{
			member_id: string;
			wallet_account_id: string;
			balance: string;
		}>(
			`SELECT m.id AS member_id, a.id AS wallet_account_id, wb.balance
       FROM members m
       JOIN accounts a ON a.owner_id = m.id AND a.kind='wallet'
       JOIN wallet_balances wb ON wb.account_id = a.id
       WHERE m.kyc_status='verified'
         AND m.bank_status='verified'
         AND wb.balance >= $1`,
			[minRupees],
		);

		let totalNetPaise = 0n;
		let itemCount = 0;

		for (const row of eligible) {
			const memberId = BigInt(row.member_id);
			const walletAccId = BigInt(row.wallet_account_id);
			const grossPaise = toPaise(row.balance);
			const tdsPaise = pctRoundUp(grossPaise, CFG.TDS_PCT);
			const netPaise = grossPaise - tdsPaise;

			// Idempotent on (batch_id, member_id)
			const { rows: itemIns } = await c.query<{ id: string }>(
				`INSERT INTO payout_items (batch_id, member_id, gross, tds, net)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (batch_id, member_id) DO NOTHING RETURNING id`,
				[
					batchId,
					memberId,
					fromPaise(grossPaise),
					fromPaise(tdsPaise),
					fromPaise(netPaise),
				],
			);
			if (!itemIns[0]) continue; // ledger already posted for this member

			const itemId = BigInt(itemIns[0].id);
			await postLedgerTxn(
				c,
				`payout:${batchId}:${memberId}`,
				"payout_item",
				itemId,
				[
					{ accountId: walletAccId, direction: "D", amountPaise: grossPaise },
					{
						accountId: payoutClearingId,
						direction: "C",
						amountPaise: netPaise,
					},
					{ accountId: tdsPayableId, direction: "C", amountPaise: tdsPaise },
				],
			);

			totalNetPaise += netPaise;
			itemCount++;
		}

		await writeOutbox(c, {
			event_id: randomUUID(),
			event_type: "PayoutBatchCreated",
			occurred_at: new Date().toISOString(),
			schema_version: 1,
			batch_id: Number(batchId),
			scheduled_for: dateStr,
			item_count: itemCount,
			total_net_paise: Number(totalNetPaise),
		});

		return { batchId, totalNetPaise, itemCount };
	});

	// ── Phase 2: generate CSV from DB after transaction commits ──────────────────
	// Querying from DB (not in-memory) ensures re-runs include previously-inserted members.
	const { rows: items } = await pool().query<{
		member_code: string;
		name: string;
		gross: string;
		tds: string;
		net: string;
	}>(
		`SELECT m.member_code, m.name, pi.gross, pi.tds, pi.net
     FROM payout_items pi
     JOIN members m ON m.id = pi.member_id
     WHERE pi.batch_id = $1
     ORDER BY m.member_code`,
		[batchId],
	);

	const csvLines = [csvRow(["member_code", "name", "gross", "tds", "net"])];
	for (const item of items) {
		csvLines.push(
			csvRow([item.member_code, item.name, item.gross, item.tds, item.net]),
		);
	}

	await mkdir(OUT_DIR, { recursive: true });
	const csvPath = join(OUT_DIR, `${dateStr}.csv`);
	await writeFile(csvPath, csvLines.join("\n"), "utf-8");

	// ── Phase 3: mark sent only after file is written ─────────────────────────────
	// If writeFile threw above, status stays 'building' and can be retried.
	await pool().query(
		`UPDATE payout_batches SET status='sent', bank_file_ref=$1 WHERE id=$2 AND status='building'`,
		[csvPath, batchId],
	);

	console.log(
		`[payout] batch ${batchId} built: ${itemCount} items, net ${totalNetPaise} paise → ${csvPath}`,
	);
	return batchId;
}

export async function ingestSettlement(
	batchId: bigint,
	results: {
		memberId: bigint;
		ok: boolean;
		bankRef?: string;
		reason?: string;
	}[],
): Promise<void> {
	const { rows: sysAccs } = await pool().query<{ id: string; kind: string }>(
		`SELECT id, kind FROM accounts WHERE owner_type='system'`,
	);
	const payoutClearingId = BigInt(
		sysAccs.find((a) => a.kind === "payout_clearing")!.id,
	);
	const bankAccId = BigInt(sysAccs.find((a) => a.kind === "bank")!.id);

	for (const result of results) {
		await withTxn(async (c) => {
			const { rows: item } = await c.query<{
				id: string;
				net: string;
				member_id: string;
				status: string;
			}>(
				`SELECT id, net, member_id, status FROM payout_items
         WHERE batch_id=$1 AND member_id=$2`,
				[batchId, result.memberId],
			);
			if (!item[0] || item[0].status !== "pending") return;

			const itemId = BigInt(item[0].id);
			const netPaise = toPaise(item[0].net);

			if (result.ok) {
				await postLedgerTxn(c, `settle:${itemId}`, "payout_item", itemId, [
					{
						accountId: payoutClearingId,
						direction: "D",
						amountPaise: netPaise,
					},
					{ accountId: bankAccId, direction: "C", amountPaise: netPaise },
				]);
				await c.query(
					`UPDATE payout_items SET status='settled', bank_ref=$1 WHERE id=$2`,
					[result.bankRef ?? null, itemId],
				);
				await writeOutbox(c, {
					event_id: randomUUID(),
					event_type: "PayoutItemSettled",
					occurred_at: new Date().toISOString(),
					schema_version: 1,
					payout_item_id: Number(itemId),
					member_id: Number(result.memberId),
					net_paise: Number(netPaise),
					bank_ref: result.bankRef ?? "",
				});
			} else {
				// Re-credit wallet
				const { rows: accs } = await c.query<{ id: string }>(
					`SELECT id FROM accounts WHERE owner_id=$1 AND kind='wallet'`,
					[result.memberId],
				);
				const walletAccId = BigInt(accs[0].id);
				await postLedgerTxn(c, `payoutfail:${itemId}`, "payout_item", itemId, [
					{
						accountId: payoutClearingId,
						direction: "D",
						amountPaise: netPaise,
					},
					{ accountId: walletAccId, direction: "C", amountPaise: netPaise },
				]);
				await c.query(
					`UPDATE payout_items SET status='failed', failure_reason=$1 WHERE id=$2`,
					[result.reason ?? "unknown", itemId],
				);
				await writeOutbox(c, {
					event_id: randomUUID(),
					event_type: "PayoutItemFailed",
					occurred_at: new Date().toISOString(),
					schema_version: 1,
					payout_item_id: Number(itemId),
					member_id: Number(result.memberId),
					net_paise: Number(netPaise),
					reason: result.reason ?? "unknown",
				});
			}
		});
	}
}

// Cron: state-based — builds a batch whenever payout_date is today or past and no batch exists.
// Implements the 7-day hold: cutoff closes on Saturday, payout_date = next Saturday (7 days later).
// Self-heals after downtime: if the worker was down on payout day, it catches up on next startup.
export async function run() {
	console.log("[payout] started");
	setInterval(async () => {
		try {
			const { rows } = await pool().query<{ payout_date: string }>(
				`SELECT payout_date FROM cutoffs
         WHERE status = 'closed'
           AND payout_date <= CURRENT_DATE
           AND NOT EXISTS (
             SELECT 1 FROM payout_batches
             WHERE scheduled_for = cutoffs.payout_date AND status = 'sent'
           )
         LIMIT 1`,
			);
			if (rows.length > 0) {
				const dt = DateTime.fromISO(rows[0].payout_date, { zone: CFG.TZ });
				console.log("[payout] building batch for", rows[0].payout_date);
				await buildBatch(dt);
			}
		} catch (err) {
			console.error("[payout] error in tick", err);
		}
	}, 60_000);
}

const _argv1 = process.argv[1] ?? "";
if (_argv1.endsWith("payout.ts") || _argv1.endsWith("payout.js")) {
	run().catch((err) => {
		console.error("[payout] fatal", err);
		process.exit(1);
	});
}
