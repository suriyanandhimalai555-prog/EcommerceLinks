import { randomUUID } from "crypto";
import { DateTime } from "luxon";
import { CFG } from "../config.js";
import { writeOutbox } from "../events/outbox.js";
import { pool, withTxn } from "../lib/db.js";

// Windows run Saturday 18:00:00 IST → next Saturday 17:59:59 IST (exactly 7 days).
// nextWindowStart: the new window starts the instant the previous one ends (no hour override).
// windowEnd: exactly 7 days minus 1 second after the start.
// This keeps windows stable regardless of restart timing — no drift.
export function nextWindowStart(wEnd: DateTime): DateTime {
	return wEnd.plus({ seconds: 1 });
}

export function windowEnd(wStart: DateTime): DateTime {
	return wStart.plus({ days: 7 }).minus({ seconds: 1 });
}

function payoutDate(wEnd: DateTime): DateTime {
	// Saturday 7 days after window end
	return wEnd.plus({ days: 7 }).startOf("day");
}

export async function ensureCutoffExists(): Promise<void> {
	await withTxn(async (c) => {
		const { rows } = await c.query(
			`SELECT id FROM cutoffs WHERE status='open' LIMIT 1`,
		);
		if (rows.length > 0) return;

		// Find the most recent closed window to derive next start, or create from now
		const { rows: last } = await c.query(
			`SELECT window_end FROM cutoffs ORDER BY window_end DESC LIMIT 1`,
		);

		let wStart: DateTime;
		if (last[0]) {
			const lastEnd = DateTime.fromJSDate(last[0].window_end, { zone: CFG.TZ });
			wStart = nextWindowStart(lastEnd);
		} else {
			// Fresh start: find the most recent past Saturday 18:00 IST (matching the cron)
			const now = DateTime.now().setZone(CFG.TZ);
			// luxon: Monday=1 … Saturday=6; days since last Saturday = (weekday - 6 + 7) % 7
			const daysSinceSat = (now.weekday - 6 + 7) % 7;
			wStart = now
				.minus({ days: daysSinceSat })
				.set({ hour: 18, minute: 0, second: 0, millisecond: 0 });
			if (wStart > now) wStart = wStart.minus({ days: 7 });
		}

		const wEnd = windowEnd(wStart);
		const pDate = payoutDate(wEnd);

		await c.query(
			`INSERT INTO cutoffs (window_start, window_end, payout_date, status)
       VALUES ($1,$2,$3,'open')
       ON CONFLICT (window_start) DO NOTHING`,
			[wStart.toISO(), wEnd.toISO(), pDate.toISODate()],
		);
	});
}

export async function closeAndOpenCutoff(): Promise<void> {
	await withTxn(async (c) => {
		// Close the open window
		const { rows: openRows } = await c.query<{
			id: string;
			window_start: Date;
			window_end: Date;
		}>(
			`UPDATE cutoffs SET status='closed' WHERE status='open' RETURNING id, window_start, window_end`,
		);
		if (!openRows[0]) return;

		const closed = openRows[0];
		await writeOutbox(c, {
			event_id: randomUUID(),
			event_type: "CutoffClosed",
			occurred_at: new Date().toISOString(),
			schema_version: 1,
			cutoff_id: Number(closed.id),
			window_start: new Date(closed.window_start).toISOString(),
			window_end: new Date(closed.window_end).toISOString(),
		});

		// Open next window
		const lastEnd = DateTime.fromJSDate(closed.window_end, { zone: CFG.TZ });
		const wStart = nextWindowStart(lastEnd);
		const wEnd = windowEnd(wStart);
		const pDate = payoutDate(wEnd);

		await c.query(
			`INSERT INTO cutoffs (window_start, window_end, payout_date, status)
       VALUES ($1,$2,$3,'open')
       ON CONFLICT (window_start) DO NOTHING`,
			[wStart.toISO(), wEnd.toISO(), pDate.toISODate()],
		);

		const { rows: newCutoff } = await c.query<{ id: string }>(
			`SELECT id FROM cutoffs WHERE window_start=$1`,
			[wStart.toISO()],
		);
		if (!newCutoff[0]) return;
		const newCutoffId = newCutoff[0].id;

		// Emit DeferredSweepRequested for every member with deferred balance > 0
		const { rows: deferred } = await pool().query<{ owner_id: string }>(
			`SELECT a.owner_id FROM wallet_balances wb
       JOIN accounts a ON a.id = wb.account_id
       WHERE a.kind='deferred_bonus' AND wb.balance > 0`,
		);
		for (const row of deferred) {
			await writeOutbox(c, {
				event_id: randomUUID(),
				event_type: "DeferredSweepRequested",
				occurred_at: new Date().toISOString(),
				schema_version: 1,
				member_id: Number(row.owner_id),
				new_cutoff_id: Number(newCutoffId),
			});
		}
	});
}

// Cron-style scheduler — checks every minute
export async function run() {
	await ensureCutoffExists();
	console.log("[cutoff] started, open window ensured");

	setInterval(async () => {
		try {
			const now = DateTime.now().setZone(CFG.TZ);
			// Close window on Saturday at 18:00 IST (weekday 6 = Saturday in luxon)
			if (
				now.weekday === 6 &&
				now.hour === 18 &&
				now.minute === 0 &&
				now.second < 60
			) {
				await closeAndOpenCutoff();
				console.log("[cutoff] window closed and new window opened");
			}
		} catch (err) {
			console.error("[cutoff] error in tick", err);
		}
	}, 60_000);
}

const _argv1 = process.argv[1] ?? "";
if (_argv1.endsWith("cutoff.ts") || _argv1.endsWith("cutoff.js")) {
	run().catch((err) => {
		console.error("[cutoff] fatal", err);
		process.exit(1);
	});
}
