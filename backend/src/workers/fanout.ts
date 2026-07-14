import { v5 as uuidv5 } from "uuid";
import { TOPICS } from "../events/topics.js";
import type {
	AvgEvent,
	CounterIncrement,
	MemberActivated,
	MemberQualified,
	PairBonusAccrued,
	PairCompleted,
	RankAchieved,
} from "../events/types.js";
import { pool, withTxn } from "../lib/db.js";
import { publishToStream, startConsumer } from "../lib/streams.js";

const GROUP = "avg-fanout";
// Deterministic ID namespace for fan-out increments
const NS = "1b671a64-40d5-491e-99b0-da01ff1f3341";

function deterministicIncrementId(
	sourceEventId: string,
	ancestorId: bigint,
): string {
	return uuidv5(`${sourceEventId}:${ancestorId}`, NS);
}

export function fanOut(
	e: MemberActivated | MemberQualified | RankAchieved,
	placementPath: bigint[],
	placementSides: string[],
): CounterIncrement[] {
	const increments: CounterIncrement[] = [];
	const sourceMemberId =
		e.event_type === "RankAchieved" ? e.member_id : e.member_id;

	for (let i = 0; i < placementPath.length; i++) {
		const ancestorId = placementPath[i];
		const side = placementSides[i] as "L" | "R";

		let counterType: "active" | "qualified" | "rank_achiever";
		let rankLevel: number | undefined;

		if (e.event_type === "MemberActivated") {
			counterType = "active";
		} else if (e.event_type === "MemberQualified") {
			counterType = "qualified";
		} else {
			// RankAchieved — only fan out levels 4..11; skip 1..3 and 12
			if (e.rank_level < 4 || e.rank_level > 11) continue;
			counterType = "rank_achiever";
			rankLevel = e.rank_level;
		}

		const inc: CounterIncrement = {
			event_id: deterministicIncrementId(e.event_id, ancestorId),
			event_type: "CounterIncrement",
			occurred_at: e.occurred_at,
			schema_version: 1,
			ancestor_id: Number(ancestorId),
			side,
			counter_type: counterType,
			source_member_id: sourceMemberId,
			source_event_id: e.event_id,
		};
		if (rankLevel !== undefined) inc.rank_level = rankLevel;
		increments.push(inc);
	}
	return increments;
}

// A completed pair pays the pair owner AND every placement ancestor ₹1000 each
// ("every member is the root of their own subtree"). One PairBonusAccrued per
// beneficiary; deterministic ids make XAUTOCLAIM re-delivery safe.
export function fanOutPairBonus(
	e: PairCompleted,
	ownerPlacementPath: bigint[],
): PairBonusAccrued[] {
	const beneficiaries = [BigInt(e.member_id), ...ownerPlacementPath];
	return beneficiaries.map((beneficiaryId) => ({
		event_id: deterministicIncrementId(e.event_id, beneficiaryId),
		event_type: "PairBonusAccrued",
		occurred_at: e.occurred_at,
		schema_version: 1,
		beneficiary_id: Number(beneficiaryId),
		pair_id: e.pair_id,
		pair_member_id: e.member_id,
		amount_paise: e.amount_paise,
		source_event_id: e.event_id,
	}));
}

export async function run() {
	await startConsumer({
		stream: TOPICS.lifecycle.name,
		group: GROUP,
		mode: "message",
		onMessage: async (value) => {
			const e = JSON.parse(value) as AvgEvent;

			if (
				e.event_type !== "MemberActivated" &&
				e.event_type !== "MemberQualified" &&
				e.event_type !== "RankAchieved" &&
				e.event_type !== "PairCompleted"
			)
				return;

			// Check idempotency
			const alreadyDone = await withTxn(async (c) => {
				const { rows } = await c.query(
					"SELECT 1 FROM processed_events WHERE consumer_group=$1 AND event_id=$2",
					[GROUP, e.event_id],
				);
				return rows.length > 0;
			});
			if (alreadyDone) return;

			// Read placement data from DB
			const { rows: mRows } = await pool().query<{
				placement_path: string[];
				placement_sides: string[];
			}>("SELECT placement_path, placement_sides FROM members WHERE id = $1", [
				e.member_id,
			]);
			if (!mRows[0]) return;

			const placementPath = (mRows[0].placement_path ?? []).map(BigInt);
			const placementSides = mRows[0].placement_sides ?? [];

			// Produce first, then record — at-least-once is safe; downstream dedupes via
			// deterministic uuidv5 ids (sourceEventId:ancestorId).
			if (e.event_type === "PairCompleted") {
				// For PairCompleted, member_id is the pair owner: bonus accruals go to
				// the owner + every placement ancestor, straight to the ledger stream
				// (sanctioned direct-publish exception, same as increments).
				const accruals = fanOutPairBonus(e, placementPath);
				for (const acc of accruals) {
					await publishToStream(TOPICS.ledger.name, JSON.stringify(acc));
				}
			} else {
				const increments = fanOut(
					e as MemberActivated | MemberQualified | RankAchieved,
					placementPath,
					placementSides,
				);
				for (const inc of increments) {
					await publishToStream(TOPICS.increments.name, JSON.stringify(inc));
				}
			}

			await withTxn(async (c) => {
				await c.query(
					"INSERT INTO processed_events (consumer_group, event_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
					[GROUP, e.event_id],
				);
			});
		},
	});
}

const _argv1 = process.argv[1] ?? "";
if (_argv1.endsWith("fanout.ts") || _argv1.endsWith("fanout.js")) {
	run().catch((err) => {
		console.error("[fanout] fatal", err);
		process.exit(1);
	});
}
