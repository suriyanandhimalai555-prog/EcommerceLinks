import { randomUUID } from "crypto";
import { CFG } from "../config.js";
import { writeOutbox } from "../events/outbox.js";
import { TOPICS } from "../events/topics.js";
import type { CounterIncrement } from "../events/types.js";
import { withTxn } from "../lib/db.js";
import { fromPaise } from "../lib/money.js";
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
		const fresh = batch.filter((b) => !done.has(b.event_id));
		if (fresh.length === 0) return;

		// Lock counters row
		const { rows: cRows } = await c.query<{
			left_active: string;
			right_active: string;
			pairs_matched: string;
			left_qualified: string;
			right_qualified: string;
		}>(
			"SELECT left_active, right_active, pairs_matched, left_qualified, right_qualified FROM member_counters WHERE member_id=$1 FOR UPDATE",
			[ancestorId],
		);
		if (!cRows[0]) throw new Error(`No counters row for ${ancestorId}`);

		let leftActive = BigInt(cRows[0].left_active);
		let rightActive = BigInt(cRows[0].right_active);
		let pairsMatched = BigInt(cRows[0].pairs_matched);
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

		// Mint new pairs (BR-3)
		const newPairs = BigInt(
			Math.min(Number(leftActive), Number(rightActive)) - Number(pairsMatched),
		);

		for (let k = 1n; k <= newPairs; k++) {
			const seq = pairsMatched + k;

			// Both leg_activations rows MUST exist
			const { rows: la } = await c.query<{ member_id: string }>(
				"SELECT member_id FROM leg_activations WHERE ancestor_id=$1 AND side=$2 AND seq=$3",
				[ancestorId, "L", seq],
			);
			const { rows: ra } = await c.query<{ member_id: string }>(
				"SELECT member_id FROM leg_activations WHERE ancestor_id=$1 AND side=$2 AND seq=$3",
				[ancestorId, "R", seq],
			);
			if (!la[0] || !ra[0]) {
				throw new Error(
					`Missing leg_activation for ancestor=${ancestorId} seq=${seq} — data integrity error`,
				);
			}

			const { rows: pairRows } = await c.query<{ id: string }>(
				`INSERT INTO pairs (member_id, sequence_no, left_member_id, right_member_id, bonus_amount)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (member_id, sequence_no) DO NOTHING
         RETURNING id`,
				[
					ancestorId,
					seq,
					la[0].member_id,
					ra[0].member_id,
					fromPaise(BigInt(CFG.PAIR_BONUS_PAISE)),
				],
			);
			if (pairRows[0]) {
				await writeOutbox(c, {
					event_id: randomUUID(),
					event_type: "PairMatched",
					occurred_at: new Date().toISOString(),
					schema_version: 1,
					pair_id: Number(pairRows[0].id),
					member_id: Number(ancestorId),
					sequence_no: Number(seq),
					left_member_id: Number(la[0].member_id),
					right_member_id: Number(ra[0].member_id),
					amount_paise: Number(CFG.PAIR_BONUS_PAISE),
				});
			}
		}

		pairsMatched += newPairs;

		await c.query(
			`UPDATE member_counters
         SET left_active=$1, right_active=$2, pairs_matched=$3,
             left_qualified=$4, right_qualified=$5, updated_at=now()
       WHERE member_id=$6`,
			[leftActive, rightActive, pairsMatched, leftQual, rightQual, ancestorId],
		);

		if (qualChanged || newPairs > 0n) {
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
