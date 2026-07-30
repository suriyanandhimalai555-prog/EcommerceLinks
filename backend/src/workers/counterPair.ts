import { randomUUID } from "crypto";
import { writeOutbox } from "../events/outbox.js";
import { TOPICS } from "../events/topics.js";
import type { CounterIncrement } from "../events/types.js";
import { CFG } from "../config.js";
import { withTxn } from "../lib/db.js";
import { pairAccrualEventId } from "../lib/ids.js";
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
		// Phase 0.1: dedupe within-batch duplicates before hitting the DB lock
		const seenIds = new Set<string>();
		const fresh = batch.filter((b) => {
			if (done.has(b.event_id) || seenIds.has(b.event_id)) return false;
			seenIds.add(b.event_id);
			return true;
		});
		if (fresh.length === 0) return;

		// Lock counters row — include pairs_matched so we can compute target
		// and set it in the same UPDATE (D-3: set-to-target, never a decrement).
		const { rows: cRows } = await c.query<{
			left_active: string;
			right_active: string;
			left_qualified: string;
			right_qualified: string;
			pairs_matched: string;
		}>(
			"SELECT left_active, right_active, left_qualified, right_qualified, pairs_matched FROM member_counters WHERE member_id=$1 FOR UPDATE",
			[ancestorId],
		);
		if (!cRows[0]) throw new Error(`No counters row for ${ancestorId}`);

		let leftActive = BigInt(cRows[0].left_active);
		let rightActive = BigInt(cRows[0].right_active);
		let leftQual = BigInt(cRows[0].left_qualified);
		let rightQual = BigInt(cRows[0].right_qualified);
		const priorPairsMatched = BigInt(cRows[0].pairs_matched);
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

		// BR-4, D-3: Pair matching — set-to-target after applying the whole batch.
		// target = LEAST(left_active, right_active) after all increments.
		// Minting inside the per-increment loop would require per-event leg_activations
		// queries and would double-mint on XAUTOCLAIM re-delivery; set-to-target is
		// naturally idempotent: replaying the same increment converges on the same
		// target and ON CONFLICT absorbs any duplicate pair insert.
		const target = leftActive < rightActive ? leftActive : rightActive;

		if (target > priorPairsMatched) {
			// Resolve the two members forming each new pair from the activation log.
			// leg_activations (ancestor_id, side, seq) is the durable ordered log; its
			// primary key (ancestor_id, side, seq) makes the lookup exact.
			const { rows: legRows } = await c.query<{
				side: string;
				seq: string;
				member_id: string;
			}>(
				`SELECT side, seq, member_id FROM leg_activations
          WHERE ancestor_id = $1 AND seq > $2 AND seq <= $3`,
				[ancestorId, priorPairsMatched, target],
			);
			const bySide: Record<"L" | "R", Map<string, string>> = {
				L: new Map<string, string>(),
				R: new Map<string, string>(),
			};
			for (const r of legRows) {
				bySide[r.side as "L" | "R"].set(r.seq, r.member_id);
			}

			for (let k = priorPairsMatched + 1n; k <= target; k++) {
				const leftId = bySide.L.get(String(k));
				const rightId = bySide.R.get(String(k));
				if (!leftId || !rightId) {
					// Tripwire (§3 of spec): the activation log disagrees with the counters.
					// Stop hard — inventing a pair here would move real money incorrectly.
					throw new Error(
						`leg_activations gap for ancestor ${ancestorId} at seq ${k} (L=${leftId ?? "missing"} R=${rightId ?? "missing"})`,
					);
				}

				// Insert the pair; ON CONFLICT DO NOTHING makes this idempotent under
				// XAUTOCLAIM re-delivery — the UPDATE to pairs_matched below will converge
				// on the same target, and the accrual event_id is deterministic (D-9).
				const { rows: pairIns } = await c.query<{ id: string }>(
					`INSERT INTO pairs
             (member_id, sequence_no, left_member_id, right_member_id, bonus_amount)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (member_id, sequence_no) DO NOTHING
           RETURNING id`,
					[
						ancestorId,
						k,
						leftId,
						rightId,
						fromPaise(BigInt(CFG.PAIR_BONUS_PAISE)),
					],
				);
				if (!pairIns[0]) continue; // already minted by an earlier delivery

				const pairId = BigInt(pairIns[0].id);
				const pairCompletedId = randomUUID();

				// Audit-only: PairCompleted is routed to lifecycle stream (outbox.ts) so
				// fanout can observe it, but after T4 removes the PairCompleted branch
				// from fanout.ts, nothing consumes it — it is kept for observability only.
				await writeOutbox(c, {
					event_id: pairCompletedId,
					event_type: "PairCompleted",
					occurred_at: new Date().toISOString(),
					schema_version: 1,
					pair_id: Number(pairId),
					member_id: Number(ancestorId),
					left_member_id: Number(leftId),
					right_member_id: Number(rightId),
					amount_paise: Number(CFG.PAIR_BONUS_PAISE),
				});

				// BR-7: exactly one beneficiary — the matching node itself (no fan-out).
				// event_id is DETERMINISTIC (D-9): even if this block executes twice under
				// XAUTOCLAIM, the ledger worker's processed_events check and pair_accruals
				// ON CONFLICT together absorb the duplicate, and the deterministic id is the
				// third layer of defence.
				await writeOutbox(c, {
					event_id: pairAccrualEventId(pairId, ancestorId),
					event_type: "PairBonusAccrued",
					occurred_at: new Date().toISOString(),
					schema_version: 1,
					beneficiary_id: Number(ancestorId),
					pair_id: Number(pairId),
					pair_member_id: Number(ancestorId),
					amount_paise: Number(CFG.PAIR_BONUS_PAISE),
					source_event_id: pairCompletedId,
				});
			}
		}

		// Single UPDATE per ancestor per batch — critical for hot-row performance.
		// Also sets pairs_matched = target (D-3). The CHECK constraint
		// chk_pairs_le_min (pairs_matched <= LEAST(left_active, right_active))
		// rejects any bad state before it reaches the disk.
		await c.query(
			`UPDATE member_counters
         SET left_active=$1, right_active=$2,
             left_qualified=$3, right_qualified=$4,
             pairs_matched=$5, updated_at=now()
       WHERE member_id=$6`,
			[leftActive, rightActive, leftQual, rightQual, target, ancestorId],
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
