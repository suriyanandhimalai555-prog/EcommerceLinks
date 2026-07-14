import { randomUUID } from "crypto";
import { writeOutbox } from "../events/outbox.js";
import { TOPICS } from "../events/topics.js";
import type { CounterIncrement } from "../events/types.js";
import { withTxn } from "../lib/db.js";
import { startConsumer } from "../lib/streams.js";

const GROUP = "avg-counter-pair";

export async function applyIncrements(
	ancestorId: bigint,
	batch: CounterIncrement[],
): Promise<void> {
	await withTxn(async (c) => {
		// Filter already-processed
		const eventIds = batch.map((b) => b.event_id);
		const { rows: doneRows } = await c.query<{ event_id: string }>(
			`SELECT event_id FROM processed_events WHERE consumer_group=$1 AND event_id = ANY($2)`,
			[GROUP, eventIds],
		);
		const done = new Set(doneRows.map((r) => r.event_id));
		// Phase 0.1: dedupe within-batch duplicates before hitting the DB lock
		const seenIds = new Set<string>();
		const fresh = batch.filter((b) => {
			if (done.has(b.event_id) || seenIds.has(b.event_id)) return false;
			seenIds.add(b.event_id);
			return true;
		});
		if (fresh.length === 0) return;

		// Lock counters row
		const { rows: cRows } = await c.query<{
			left_active: string;
			right_active: string;
			left_qualified: string;
			right_qualified: string;
		}>(
			"SELECT left_active, right_active, left_qualified, right_qualified FROM member_counters WHERE member_id=$1 FOR UPDATE",
			[ancestorId],
		);
		if (!cRows[0]) throw new Error(`No counters row for ${ancestorId}`);

		let leftActive = BigInt(cRows[0].left_active);
		let rightActive = BigInt(cRows[0].right_active);
		let leftQual = BigInt(cRows[0].left_qualified);
		let rightQual = BigInt(cRows[0].right_qualified);
		let qualChanged = false;

		for (const inc of fresh) {
			if (inc.counter_type === "active") {
				const side = inc.side;
				if (side === "L") {
					leftActive++;
					await c.query(
						`INSERT INTO leg_activations (ancestor_id, side, seq, member_id)
             VALUES ($1,'L',$2,$3)`,
						[ancestorId, leftActive, inc.source_member_id],
					);
				} else {
					rightActive++;
					await c.query(
						`INSERT INTO leg_activations (ancestor_id, side, seq, member_id)
             VALUES ($1,'R',$2,$3)`,
						[ancestorId, rightActive, inc.source_member_id],
					);
				}
			} else if (inc.counter_type === "qualified") {
				if (inc.side === "L") {
					leftQual++;
					qualChanged = true;
				} else {
					rightQual++;
					qualChanged = true;
				}
			} else if (
				inc.counter_type === "rank_achiever" &&
				inc.rank_level !== undefined
			) {
				const side = inc.side;
				if (side === "L") {
					await c.query(
						`INSERT INTO leg_rank_counters (member_id, rank_level, left_count)
             VALUES ($1,$2,1)
             ON CONFLICT (member_id, rank_level)
             DO UPDATE SET left_count = leg_rank_counters.left_count + 1`,
						[ancestorId, inc.rank_level],
					);
				} else {
					await c.query(
						`INSERT INTO leg_rank_counters (member_id, rank_level, right_count)
             VALUES ($1,$2,1)
             ON CONFLICT (member_id, rank_level)
             DO UPDATE SET right_count = leg_rank_counters.right_count + 1`,
						[ancestorId, inc.rank_level],
					);
				}
				qualChanged = true;
			}
		}

		// Income no longer mints here (since 020): pair completion is detected by
		// workers/pairComplete.ts on the placement children, and money flows through
		// pair_accruals in the ledger worker. Counters remain for display and ranks.
		// pairs_matched is DEPRECATED — frozen at its current value (0 post-reset).
		await c.query(
			`UPDATE member_counters
         SET left_active=$1, right_active=$2,
             left_qualified=$3, right_qualified=$4, updated_at=now()
       WHERE member_id=$5`,
			[leftActive, rightActive, leftQual, rightQual, ancestorId],
		);

		if (qualChanged) {
			await writeOutbox(c, {
				event_id: randomUUID(),
				event_type: "RankEvalRequested",
				occurred_at: new Date().toISOString(),
				schema_version: 1,
				member_id: Number(ancestorId),
			});
		}

		// Record processed
		for (const inc of fresh) {
			await c.query(
				"INSERT INTO processed_events (consumer_group, event_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
				[GROUP, inc.event_id],
			);
		}
	});
}

export async function run() {
	await startConsumer({
		stream: TOPICS.increments.name,
		group: GROUP,
		mode: "batch",
		count: 500,
		onBatch: async (values) => {
			// Group by ancestorId (partition key) — preserves per-ancestor ordering.
			// CRITICAL: run only one avg-workers process; multiple consumers in this group
			// would interleave increments and break the per-ancestor serialisation.
			const byAncestor = new Map<bigint, CounterIncrement[]>();
			for (const value of values) {
				const inc = JSON.parse(value) as CounterIncrement;
				const aid = BigInt(inc.ancestor_id);
				const bucket = byAncestor.get(aid) ?? [];
				bucket.push(inc);
				byAncestor.set(aid, bucket);
			}
			for (const [ancestorId, incs] of byAncestor) {
				await applyIncrements(ancestorId, incs);
			}
		},
	});
}

const _argv1 = process.argv[1] ?? "";
if (_argv1.endsWith("counterPair.ts") || _argv1.endsWith("counterPair.js")) {
	run().catch((err) => {
		console.error("[counter-pair] fatal", err);
		process.exit(1);
	});
}
