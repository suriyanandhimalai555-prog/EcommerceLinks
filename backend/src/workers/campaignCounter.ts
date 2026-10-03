/**
 * campaignCounter — unit-weighted campaign pair-matching worker (Phase B).
 *
 * Consumer group: avg-campaign-counter  (stream: avg.campaign.units)
 *
 * Consumes CampaignUnitsAdded events emitted by confirmOrder and fans the
 * member's extra_units_delta up their placement path, updating
 * campaign_member_counters (NOT the live member_counters table) and minting
 * campaign_pairs when LEAST(left_extra_units, right_extra_units) increases.
 *
 * The live engine files (fanout.ts, counterPair.ts, member_counters,
 * leg_activations, pairs, pair_accruals) are completely untouched.
 * This worker only reads from those tables via placement_path on the members row.
 *
 * IMPORTANT: run exactly one avg-workers process (same constraint as counterPair.ts).
 */
import { writeOutbox } from "../events/outbox.js";
import { TOPICS } from "../events/topics.js";
import type { CampaignUnitsAdded } from "../events/types.js";
import { CFG } from "../config.js";
import { withTxn } from "../lib/db.js";
import { campaignAccrualEventId } from "../lib/ids.js";
import { fromPaise } from "../lib/money.js";
import { startConsumer } from "../lib/streams.js";

const GROUP = "avg-campaign-counter";

/**
 * Apply a CampaignUnitsAdded event: fan extra units up the placement tree,
 * update campaign_member_counters, and mint campaign_pairs.
 *
 * Idempotent: the processed_events check at the start gates the entire
 * transaction. If the transaction commits, processed_events is recorded and
 * re-delivery is a no-op. If it rolls back (crash), no state was committed
 * so re-delivery safely replays from scratch.
 */
export async function applyCampaignUnits(e: CampaignUnitsAdded): Promise<void> {
	await withTxn(async (c) => {
		// Idempotency guard — must be inside the same transaction as the writes.
		const { rows: done } = await c.query(
			"SELECT 1 FROM processed_events WHERE consumer_group=$1 AND event_id=$2",
			[GROUP, e.event_id],
		);
		if (done.length > 0) return;

		const sourceMemberId = BigInt(e.member_id);
		const unitDelta = BigInt(e.extra_units_delta);

		// Read placement path from DB (immutable after registration).
		const { rows: mRows } = await c.query<{
			placement_path: number[] | null;
			placement_sides: string[] | null;
		}>(
			"SELECT placement_path, placement_sides FROM members WHERE id=$1",
			[sourceMemberId],
		);
		if (!mRows[0]) {
			// Member not found — shouldn't happen, but record as processed to
			// avoid an infinite retry loop on a permanently-stale event.
			await c.query(
				"INSERT INTO processed_events (consumer_group, event_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
				[GROUP, e.event_id],
			);
			return;
		}

		const placementPath = (mRows[0].placement_path ?? []).map(BigInt);
		const placementSides = mRows[0].placement_sides ?? [];

		for (let i = 0; i < placementPath.length; i++) {
			const ancestorId = placementPath[i];
			const side = placementSides[i] as "L" | "R";

			// Upsert the counter row then immediately lock it.
			// INSERT ... ON CONFLICT DO NOTHING ensures the row exists;
			// the SELECT FOR UPDATE acquires the row lock for this transaction.
			await c.query(
				`INSERT INTO campaign_member_counters (member_id)
				 VALUES ($1)
				 ON CONFLICT (member_id) DO NOTHING`,
				[ancestorId],
			);
			const { rows: cRows } = await c.query<{
				left_extra_units: string;
				right_extra_units: string;
				campaign_pairs_matched: string;
			}>(
				`SELECT left_extra_units, right_extra_units, campaign_pairs_matched
				   FROM campaign_member_counters
				  WHERE member_id=$1 FOR UPDATE`,
				[ancestorId],
			);
			if (!cRows[0]) continue;

			let leftUnits = BigInt(cRows[0].left_extra_units);
			let rightUnits = BigInt(cRows[0].right_extra_units);
			const priorMatched = BigInt(cRows[0].campaign_pairs_matched);

			if (side === "L") leftUnits += unitDelta;
			else rightUnits += unitDelta;

			// Set-to-target (D-3 / BR-4): campaign_pairs_matched = LEAST(left, right).
			// Replaying the same event converges to the same target — idempotent.
			// The CHECK constraint chk_campaign_pairs_le_min enforces this invariant.
			const target = leftUnits < rightUnits ? leftUnits : rightUnits;

			// Mint new campaign pairs for k in (priorMatched, target].
			// ON CONFLICT DO NOTHING makes individual pair inserts idempotent under
			// XAUTOCLAIM re-delivery; the accrual event_id is deterministic (three
			// layers of defence together: processed_events + ON CONFLICT + deterministic id).
			for (let k = priorMatched + 1n; k <= target; k++) {
				const { rows: pairIns } = await c.query<{ id: string }>(
					`INSERT INTO campaign_pairs (member_id, sequence_no, bonus_amount)
					 VALUES ($1,$2,$3)
					 ON CONFLICT (member_id, sequence_no) DO NOTHING
					 RETURNING id`,
					[ancestorId, k, fromPaise(BigInt(CFG.PAIR_BONUS_PAISE))],
				);
				if (!pairIns[0]) continue; // already minted under an earlier delivery

				const campaignPairId = BigInt(pairIns[0].id);

				// BR-7 equivalent: exactly one beneficiary — the matching node itself.
				// event_id is deterministic so double-delivery at the ledger layer is
				// absorbed by the campaignLedger processed_events check and the
				// campaign_pair_accruals ON CONFLICT.
				await writeOutbox(c, {
					event_id: campaignAccrualEventId(campaignPairId, ancestorId),
					event_type: "CampaignPairBonusAccrued",
					occurred_at: new Date().toISOString(),
					schema_version: 1,
					beneficiary_id: Number(ancestorId),
					campaign_pair_id: Number(campaignPairId),
					amount_paise: Number(CFG.PAIR_BONUS_PAISE),
				});
			}

			// Single UPDATE per ancestor — set-to-target (not +=).
			// The CHECK constraint (campaign_pairs_matched <= LEAST(l,r)) will reject
			// any invalid state before it reaches the disk.
			await c.query(
				`UPDATE campaign_member_counters
				    SET left_extra_units=$1,
				        right_extra_units=$2,
				        campaign_pairs_matched=$3,
				        updated_at=now()
				  WHERE member_id=$4`,
				[leftUnits, rightUnits, target, ancestorId],
			);
		}

		// Record the event as processed — commits atomically with all counter
		// updates and pair mints above, ensuring exactly-once semantics under
		// at-least-once delivery.
		await c.query(
			"INSERT INTO processed_events (consumer_group, event_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
			[GROUP, e.event_id],
		);
	});
}

export async function run() {
	await startConsumer({
		stream: TOPICS.campaignUnits.name,
		group: GROUP,
		mode: "message",
		onMessage: async (value) => {
			const e = JSON.parse(value) as CampaignUnitsAdded;
			if (e.event_type === "CampaignUnitsAdded") await applyCampaignUnits(e);
		},
	});
}

const _argv1 = process.argv[1] ?? "";
if (_argv1.endsWith("campaignCounter.ts") || _argv1.endsWith("campaignCounter.js")) {
	run().catch((err) => {
		console.error("[campaign-counter] fatal", err);
		process.exit(1);
	});
}
