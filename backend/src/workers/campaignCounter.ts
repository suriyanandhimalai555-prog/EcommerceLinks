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
 * Matching formula — WHOLE-LEG unit matching with earner self-cap (Oct 2026, Image #7 poster):
 *   T' = LEAST(ΣuL, ΣuR, u_self × LEAST(Lh, Rh))
 *   where ΣuL/ΣuR = total units across the WHOLE left/right leg,
 *   Lh/Rh = head count of the WHOLE left/right leg.
 *
 *   This matches the official campaign poster: "A ₹50,000 ID represents 5 × ₹10,000 units
 *   based on its total package value" / "5 LEFT UNITS + 5 RIGHT UNITS = 5 MATCHING PAIRS" /
 *   "This is the TOTAL package matching count" — whole-leg unit-weighted, not depth-grouped.
 *
 *   u_self = the ANCESTOR's own package: ₹10k→1, ₹30k→3, ₹50k→5.
 *   The earner self-cap: T' ≤ u_self × LEAST(Lh, Rh).
 *   A ₹10k earner: u_self=1 → T' = LEAST(*,*,1×LEAST(Lh,Rh)) ≤ LEAST(Lh,Rh) = B
 *   → surplus = 0 (no campaign pairs — eligibility gate stays correct).
 *
 *   B  = LEAST(Lh, Rh) — the headcount the live engine already paid.
 *   campaign target = GREATEST(priorMatched, T' − B)
 *
 * Worked example (Image #6, earner = YOU ₹50k):
 *   Left:  M1₹50k, M2₹10k, M3₹10k, M6₹10k  (4 heads, 8 units)
 *   Right: M4₹50k, M5₹50k  (2 heads, 10 units)
 *   T' = LEAST(8, 10, 5×LEAST(4,2)) = LEAST(8, 10, 10) = 8
 *   B = LEAST(4, 2) = 2   surplus = 8−2 = 6   total = live 2 + campaign 6 = ₹8,000.
 *
 * T', B, and u_self are all derived from a single SQL query joining leg_activations
 * (the live engine's log), leg members (for package/units), and the ancestor's own
 * current package — so upgrades raise u_self automatically.  No placement_path depth
 * computation needed.
 *
 * Self-upgrade handling: when a member upgrades, their new u_self changes the campaign
 * target for THEIR OWN node (not just their ancestors').  placement_path only covers
 * ancestors, so a separate self-recompute pass is run after the ancestor fan-up loop
 * to pick up any newly-available campaign pairs on the upgrader's own node.
 *
 * The GREATEST clamp makes the target monotonically non-decreasing — campaign pairs
 * already minted are never clawed back (migration 047 has no clawback path).
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

		// Read placement path from DB (immutable after registration).
		const { rows: mRows } = await c.query<{
			placement_path: number[] | null;
		}>(
			"SELECT placement_path FROM members WHERE id=$1",
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

		for (const ancestorId of placementPath) {

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
				campaign_pairs_matched: string;
			}>(
				`SELECT campaign_pairs_matched
				   FROM campaign_member_counters
				  WHERE member_id=$1 FOR UPDATE`,
				[ancestorId],
			);
			if (!cRows[0]) continue;

			const priorMatched = BigInt(cRows[0].campaign_pairs_matched);

			// WHOLE-LEG unit matching with earner self-cap.
			// T' = LEAST(ΣuL, ΣuR, u_self × LEAST(Lh, Rh))
			// ΣuL/ΣuR = sum of units across the WHOLE left/right leg.
			// Lh/Rh   = total head count of left/right leg.
			// B       = LEAST(Lh, Rh) — headcount the live engine already paid.
			// Matches the official campaign poster: whole-leg total package value matching.
			// The recompute SQL is the authoritative source for T', B, and the actual
			// per-leg unit and head-count totals.  We store those authoritative totals
			// back into campaign_member_counters rather than the delta-accumulated
			// leftUnits/rightUnits/etc. computed above.
			//
			// Why: confirmOrder ratchets members.package_value_paise BEFORE writing the
			// CampaignUnitsAdded event to the outbox.  When multiple upgrades are
			// committed in the same batch (e.g. two members upgrade before the worker
			// catches up), the recompute SQL reads the fully-updated DB state for every
			// ancestor it touches.  The delta-accumulated right_units for the ancestor
			// row may not yet reflect those upgrades, so using it in the UPDATE would
			// violate the CHECK constraint (campaign_pairs_matched <= LEAST(l,r)).
			// Using the SQL totals keeps the stored values in sync with the ground truth
			// and prevents that violation regardless of delivery order.
			const { rows: recompute } = await c.query<{
				t_prime: string;
				b_eff: string;
				total_u_l: string;
				total_u_r: string;
				total_h_l: string;
				total_h_r: string;
			}>(
				`WITH self AS (
				   SELECT CASE
				            WHEN m.package_value_paise >= $2 THEN 5
				            WHEN m.package_value_paise >= $3 THEN 3
				            WHEN m.package_value_paise = 1000000 THEN 1
				            ELSE 0
				          END AS u
				     FROM members m WHERE m.id = $1
				 ),
				 legs AS (
				   SELECT la.side,
				          CASE
				            WHEN m.package_value_paise >= $2 THEN 5
				            WHEN m.package_value_paise >= $3 THEN 3
				            WHEN m.package_value_paise = 1000000 THEN 1
				            ELSE 0
				          END AS units
				     FROM leg_activations la
				     JOIN members m ON m.id = la.member_id
				    WHERE la.ancestor_id = $1
				 )
				 SELECT
				   LEAST(
				     COALESCE(SUM(units) FILTER (WHERE side='L'), 0),
				     COALESCE(SUM(units) FILTER (WHERE side='R'), 0),
				     (SELECT u FROM self) * LEAST(
				       COUNT(*) FILTER (WHERE side='L'),
				       COUNT(*) FILTER (WHERE side='R'))
				   )::bigint AS t_prime,
				   LEAST(
				     COUNT(*) FILTER (WHERE side='L'),
				     COUNT(*) FILTER (WHERE side='R')
				   )::bigint AS b_eff,
				   COALESCE(SUM(units) FILTER (WHERE side='L'), 0)::bigint AS total_u_l,
				   COALESCE(SUM(units) FILTER (WHERE side='R'), 0)::bigint AS total_u_r,
				   COUNT(*) FILTER (WHERE side='L')::bigint AS total_h_l,
				   COUNT(*) FILTER (WHERE side='R')::bigint AS total_h_r
				   FROM legs`,
				[ancestorId, CFG.CAMPAIGN_TIER_50K_PAISE, CFG.CAMPAIGN_TIER_30K_PAISE],
			);
			const tPrime = BigInt(recompute[0]?.t_prime ?? "0");
			const bEff = BigInt(recompute[0]?.b_eff ?? "0");
			// Use SQL-computed actuals for the stored columns (authoritative; never diverges).
			const trueLeftUnits   = BigInt(recompute[0]?.total_u_l ?? "0");
			const trueRightUnits  = BigInt(recompute[0]?.total_u_r ?? "0");
			const trueLeftMembers  = BigInt(recompute[0]?.total_h_l ?? "0");
			const trueRightMembers = BigInt(recompute[0]?.total_h_r ?? "0");
			const surplus = tPrime > bEff ? tPrime - bEff : 0n;
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
			// Use the SQL-computed true totals (not delta-accumulated values) so the row
			// always matches leg_activations ⋈ members and the CHECK constraint is
			// guaranteed to hold regardless of concurrent upgrade ordering.
			await c.query(
				`UPDATE campaign_member_counters
				    SET left_members=$1,
				        right_members=$2,
				        left_units=$3,
				        right_units=$4,
				        campaign_pairs_matched=$5,
				        updated_at=now()
				  WHERE member_id=$6`,
				[trueLeftMembers, trueRightMembers, trueLeftUnits, trueRightUnits, target, ancestorId],
			);
		}

		// Self-node recompute pass — handle the source member's OWN campaign row.
		//
		// placement_path contains only ANCESTORS, so when a member upgrades
		// (unit_delta > 0) their own u_self changes but the ancestor fan-up loop
		// never touches their own campaign_member_counters row.  This pass re-runs
		// the same recompute + mint logic for sourceMemberId with no leg delta —
		// only campaign_pairs_matched is updated (left/right aggregate counters are
		// managed exclusively by the fan-up from downline events).
		//
		// For a brand-new activation (no downline yet → no leg_activations rows →
		// surplus = 0) this is a cheap no-op.  For an upgrade to ₹30k/₹50k it picks
		// up any newly-available campaign pairs on the earner's own subtree.
		{
			const selfId = sourceMemberId;
			await c.query(
				`INSERT INTO campaign_member_counters (member_id) VALUES ($1) ON CONFLICT (member_id) DO NOTHING`,
				[selfId],
			);
			const { rows: selfRows } = await c.query<{ campaign_pairs_matched: string }>(
				`SELECT campaign_pairs_matched
				   FROM campaign_member_counters
				  WHERE member_id=$1 FOR UPDATE`,
				[selfId],
			);
			if (selfRows[0]) {
				const selfPrior = BigInt(selfRows[0].campaign_pairs_matched);

				// Same whole-leg recompute as the ancestor loop.
				const { rows: selfRC } = await c.query<{ t_prime: string; b_eff: string }>(
					`WITH self AS (
					   SELECT CASE
					            WHEN m.package_value_paise >= $2 THEN 5
					            WHEN m.package_value_paise >= $3 THEN 3
					            WHEN m.package_value_paise = 1000000 THEN 1
					            ELSE 0
					          END AS u
					     FROM members m WHERE m.id = $1
					 ),
					 legs AS (
					   SELECT la.side,
					          CASE
					            WHEN m.package_value_paise >= $2 THEN 5
					            WHEN m.package_value_paise >= $3 THEN 3
					            WHEN m.package_value_paise = 1000000 THEN 1
					            ELSE 0
					          END AS units
					     FROM leg_activations la
					     JOIN members m ON m.id = la.member_id
					    WHERE la.ancestor_id = $1
					 )
					 SELECT
					   LEAST(
					     COALESCE(SUM(units) FILTER (WHERE side='L'), 0),
					     COALESCE(SUM(units) FILTER (WHERE side='R'), 0),
					     (SELECT u FROM self) * LEAST(
					       COUNT(*) FILTER (WHERE side='L'),
					       COUNT(*) FILTER (WHERE side='R'))
					   )::bigint AS t_prime,
					   LEAST(
					     COUNT(*) FILTER (WHERE side='L'),
					     COUNT(*) FILTER (WHERE side='R')
					   )::bigint AS b_eff
					   FROM legs`,
					[selfId, CFG.CAMPAIGN_TIER_50K_PAISE, CFG.CAMPAIGN_TIER_30K_PAISE],
				);
				const selfTPrime = BigInt(selfRC[0]?.t_prime ?? "0");
				const selfBEff   = BigInt(selfRC[0]?.b_eff   ?? "0");
				const selfSurplus = selfTPrime > selfBEff ? selfTPrime - selfBEff : 0n;
				const selfTarget  = selfSurplus > selfPrior ? selfSurplus : selfPrior; // GREATEST

				// Mint any new campaign pairs for the self-node.
				for (let k = selfPrior + 1n; k <= selfTarget; k++) {
					const { rows: pairIns } = await c.query<{ id: string }>(
						`INSERT INTO campaign_pairs (member_id, sequence_no, bonus_amount)
						 VALUES ($1,$2,$3)
						 ON CONFLICT (member_id, sequence_no) DO NOTHING
						 RETURNING id`,
						[selfId, k, fromPaise(BigInt(CFG.PAIR_BONUS_PAISE))],
					);
					if (!pairIns[0]) continue;

					const campaignPairId = BigInt(pairIns[0].id);
					await writeOutbox(c, {
						event_id: campaignAccrualEventId(campaignPairId, selfId),
						event_type: "CampaignPairBonusAccrued",
						occurred_at: new Date().toISOString(),
						schema_version: 1,
						beneficiary_id: Number(selfId),
						campaign_pair_id: Number(campaignPairId),
						amount_paise: Number(CFG.PAIR_BONUS_PAISE),
					});
				}

				// Only update campaign_pairs_matched for the self-node
				// (left/right counters are owned by the downline fan-up, not by self).
				if (selfTarget !== selfPrior) {
					await c.query(
						`UPDATE campaign_member_counters
						    SET campaign_pairs_matched=$1,
						        updated_at=now()
						  WHERE member_id=$2`,
						[selfTarget, selfId],
					);
				}
			}
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
