/**
 * campaignCounter — true unit-weighted campaign pair-matching worker (Phase B).
 *
 * Consumer group: avg-campaign-counter  (stream: avg.campaign.units)
 *
 * Consumes CampaignUnitsAdded events emitted by confirmOrder and fans both
 * member_delta and unit_delta up the placement path, updating
 * campaign_member_counters (NOT the live member_counters table) and minting
 * campaign_pairs when the target increases.
 *
 * Matching formula (§4 of the AVG Coin Airdrop offer):
 *   T = LEAST(left_units,   right_units)   — total-unit match (₹10k=1, ₹30k=3, ₹50k=5)
 *   B = LEAST(left_members, right_members) — headcount the live engine already paid
 *   campaign target = GREATEST(priorMatched, T − B)
 *
 * T − B is the "top-up": the §4 unit-match minus the base headcount-match the live
 * engine (counterPair.ts) already paid, so no head is ever counted twice.
 *
 * The GREATEST clamp makes the target monotonically non-decreasing — campaign pairs
 * already minted are never clawed back (migration 047 has no clawback path).  In the
 * rare case where T − B temporarily drops (a headcount-light leg gains a plain ₹10k
 * member while the other leg is the unit-limiter), the clamp errs generous.
 *
 * The live engine files (fanout.ts, counterPair.ts, member_counters, pairs,
 * pair_accruals) are completely untouched.  This worker only writes to
 * campaign_member_counters and campaign_pairs.
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
 * Apply a CampaignUnitsAdded event: fan member_delta and unit_delta up the
 * placement tree, update campaign_member_counters, and mint campaign_pairs.
 *
 * Idempotent: the processed_events check at the start gates the entire
 * transaction.  If the transaction commits, processed_events is recorded and
 * re-delivery is a no-op.  If it rolls back (crash), no state was committed
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

		// Pre-migration-048 events carry extra_units_delta instead of member_delta +
		// unit_delta.  BigInt(undefined) would throw inside withTxn and create an
		// infinite poison-message loop under XAUTOCLAIM.  Skip them safely: the
		// migration 048 backfill captured the activations they represent.
		// Deploy note: drain avg.campaign.units before deploying this worker so that
		// pending old-format events are flushed under the old consumer before cutover.
		const raw = e as unknown as Record<string, unknown>;
		if (raw["member_delta"] === undefined) {
			await c.query(
				"INSERT INTO processed_events (consumer_group, event_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
				[GROUP, e.event_id],
			);
			return;
		}

		const sourceMemberId = BigInt(e.member_id);
		const memberDelta = BigInt(e.member_delta); // 0n or 1n
		const unitDelta = BigInt(e.unit_delta);     // 0n – 5n

		// Read placement path from DB (immutable after registration).
		const { rows: mRows } = await c.query<{
			placement_path: number[] | null;
			placement_sides: string[] | null;
		}>(
			"SELECT placement_path, placement_sides FROM members WHERE id=$1",
			[sourceMemberId],
		);
		if (!mRows[0]) {
			// Member not found — record as processed to avoid an infinite retry loop.
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
			// Migration 048 backfilled left_members/right_members/left_units/right_units
			// from member_counters so this row already reflects the pre-window base.
			await c.query(
				`INSERT INTO campaign_member_counters (member_id)
				 VALUES ($1)
				 ON CONFLICT (member_id) DO NOTHING`,
				[ancestorId],
			);
			const { rows: cRows } = await c.query<{
				left_members: string;
				right_members: string;
				left_units: string;
				right_units: string;
				campaign_pairs_matched: string;
			}>(
				`SELECT left_members, right_members, left_units, right_units, campaign_pairs_matched
				   FROM campaign_member_counters
				  WHERE member_id=$1 FOR UPDATE`,
				[ancestorId],
			);
			if (!cRows[0]) continue;

			let leftMembers = BigInt(cRows[0].left_members);
			let rightMembers = BigInt(cRows[0].right_members);
			let leftUnits = BigInt(cRows[0].left_units);
			let rightUnits = BigInt(cRows[0].right_units);
			const priorMatched = BigInt(cRows[0].campaign_pairs_matched);

			if (side === "L") {
				leftMembers += memberDelta;
				leftUnits += unitDelta;
			} else {
				rightMembers += memberDelta;
				rightUnits += unitDelta;
			}

			// T = §4 total-unit match; B = live-engine headcount base.
			// Campaign pays T − B: the top-up only.  T >= B always holds because
			// units >= members per leg (each member contributes ≥ 1 unit).
			// GREATEST clamp: never claws back already-paid pairs.
			const T = leftUnits < rightUnits ? leftUnits : rightUnits;
			const B = leftMembers < rightMembers ? leftMembers : rightMembers;
			const surplus = T > B ? T - B : 0n;
			const target = surplus > priorMatched ? surplus : priorMatched; // GREATEST

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
				// absorbed by campaignLedger's processed_events check and ON CONFLICT.
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

			// Single UPDATE per ancestor — set-to-target (not +=), idempotent on replay.
			// The CHECK constraint (campaign_pairs_matched <= LEAST(left_units, right_units))
			// will reject any invalid state before it reaches the disk.
			await c.query(
				`UPDATE campaign_member_counters
				    SET left_members=$1,
				        right_members=$2,
				        left_units=$3,
				        right_units=$4,
				        campaign_pairs_matched=$5,
				        updated_at=now()
				  WHERE member_id=$6`,
				[leftMembers, rightMembers, leftUnits, rightUnits, target, ancestorId],
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
