/**
 * campaignLedger — campaign pair accrual and tier-gated release (Phase B).
 *
 * Consumer group: avg-campaign-ledger  (stream: avg.ledger.commands)
 *
 * Handles two campaign events from the shared ledger stream:
 *   - CampaignPairBonusAccrued  — insert a campaign_pair_accruals row and release
 *                                 immediately if the beneficiary is already eligible
 *                                 (package_value_paise >= campaign 30k tier).
 *   - CampaignEligibilityReached — release all pending campaign accruals for the
 *                                  member (fired by confirmOrder when they first cross
 *                                  the eligibility threshold).
 *
 * This is an independent consumer group on the same avg.ledger.commands stream.
 * The live avg-ledger group ignores campaign events (no case in its switch).
 *
 * ledger.ts is imported READ-ONLY for its exported creditBonusWithCap/postLedgerTxn —
 * the file itself is not edited. The shared weekly cap (cutoff_earnings FOR UPDATE)
 * serialises live + campaign credits correctly inside creditBonusWithCap.
 *
 * Idempotency key prefix: "campaignbonus:<campaign_pair_id>:<beneficiary_id>"
 * This is distinct from the live "pairbonus:" prefix — the two sequences are
 * independent BIGSERIALs and could share numeric values.
 */
import type pg from "pg";
import { CFG } from "../config.js";
import { TOPICS } from "../events/topics.js";
import type {
	AvgEvent,
	CampaignEligibilityReached,
	CampaignPairBonusAccrued,
} from "../events/types.js";
import { withTxn } from "../lib/db.js";
import { fromPaise, toPaise } from "../lib/money.js";
import { creditBonusWithCap } from "./ledger.js";
import { startConsumer } from "../lib/streams.js";

const GROUP = "avg-campaign-ledger";

/**
 * Release one campaign_pair_accruals row via creditBonusWithCap and mark it
 * released. Calls creditBonusWithCap in mode="forfeit" for ongoing/immediate
 * accruals (BR-12 equivalent) and mode="defer" for qualification-backlog
 * releases (BR-13 equivalent).
 */
async function releaseCampaignAccrual(
	c: pg.PoolClient,
	campaignPairId: bigint,
	beneficiaryId: bigint,
	amountPaise: bigint,
	mode: "forfeit" | "defer",
): Promise<void> {
	// Idempotency key uses "campaignbonus:" prefix (distinct from live "pairbonus:").
	const key = `campaignbonus:${campaignPairId}:${beneficiaryId}`;
	await creditBonusWithCap(
		c,
		beneficiaryId,
		amountPaise,
		key,
		"campaign_pair",
		campaignPairId,
		mode,
	);
	await c.query(
		`UPDATE campaign_pair_accruals
		    SET status='released', released_at=now()
		  WHERE campaign_pair_id=$1 AND beneficiary_id=$2 AND status='pending'`,
		[campaignPairId, beneficiaryId],
	);
}

/**
 * Handle CampaignPairBonusAccrued: record the accrual and release immediately if
 * the beneficiary's package_value_paise >= campaign eligibility threshold.
 */
export async function accrueCampaignPairBonus(
	e: CampaignPairBonusAccrued,
): Promise<void> {
	await withTxn(async (c) => {
		const { rows: done } = await c.query(
			"SELECT 1 FROM processed_events WHERE consumer_group=$1 AND event_id=$2",
			[GROUP, e.event_id],
		);
		if (done.length > 0) return;

		const campaignPairId = BigInt(e.campaign_pair_id);
		const beneficiaryId = BigInt(e.beneficiary_id);
		const amountPaise = BigInt(e.amount_paise);

		// Insert the accrual row — ON CONFLICT DO NOTHING on the PK makes this
		// idempotent in case of XAUTOCLAIM re-delivery after a partial commit.
		const { rows: ins } = await c.query<{ status: string }>(
			`INSERT INTO campaign_pair_accruals (campaign_pair_id, beneficiary_id, amount)
			 VALUES ($1,$2,$3)
			 ON CONFLICT (campaign_pair_id, beneficiary_id) DO NOTHING
			 RETURNING status`,
			[campaignPairId, beneficiaryId, fromPaise(amountPaise)],
		);

		// Determine whether the accrual is currently pending (newly inserted or
		// pre-existing but not yet released due to a prior partial delivery).
		let isPending: boolean;
		if (ins[0]) {
			isPending = true; // just inserted, always starts as 'pending'
		} else {
			// Row already existed — check its status to decide whether to retry release.
			const { rows: existing } = await c.query<{ status: string }>(
				`SELECT status FROM campaign_pair_accruals
				  WHERE campaign_pair_id=$1 AND beneficiary_id=$2 FOR UPDATE`,
				[campaignPairId, beneficiaryId],
			);
			isPending = existing[0]?.status === "pending";
		}

		if (isPending) {
			// Check beneficiary's package eligibility.
			const { rows: mRows } = await c.query<{ package_value_paise: string }>(
				"SELECT package_value_paise FROM members WHERE id=$1",
				[beneficiaryId],
			);
			const pkgPaise = BigInt(mRows[0]?.package_value_paise ?? "0");
			if (pkgPaise >= BigInt(CFG.CAMPAIGN_TIER_30K_PAISE)) {
				// Already eligible: release immediately with mode="forfeit" (BR-12
				// equivalent — ongoing accrual, cap overage is forfeited to system).
				await releaseCampaignAccrual(c, campaignPairId, beneficiaryId, amountPaise, "forfeit");
			}
			// else: accrual stays 'pending'; CampaignEligibilityReached releases it later.
		}

		await c.query(
			"INSERT INTO processed_events (consumer_group, event_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
			[GROUP, e.event_id],
		);
	});
}

/**
 * Handle CampaignEligibilityReached: release all pending campaign accruals for
 * this member (BR-13 equivalent — qualification-backlog release, mode="defer"
 * so cap overage is credited to deferred_bonus rather than forfeited).
 *
 * Note on terminal state: if a member accrues campaign pairs while ineligible
 * and only upgrades AFTER the campaign window closes, their backlog stays
 * 'pending' forever — no eligibility event fires post-window. This is correct
 * per the campaign terms ("valid during the campaign period").
 */
export async function releasePendingCampaignBonuses(
	e: CampaignEligibilityReached,
): Promise<void> {
	await withTxn(async (c) => {
		const { rows: done } = await c.query(
			"SELECT 1 FROM processed_events WHERE consumer_group=$1 AND event_id=$2",
			[GROUP, e.event_id],
		);
		if (done.length > 0) return;

		const memberId = BigInt(e.member_id);

		// Lock all pending accruals for this member in a stable order (campaign_pair_id ASC)
		// to avoid deadlocks if this event is ever processed concurrently (defensive; the
		// single-consumer constraint prevents concurrent processing in practice).
		const { rows: pending } = await c.query<{
			campaign_pair_id: string;
			beneficiary_id: string;
			amount: string; // NUMERIC(14,2) rupees from DB
		}>(
			`SELECT campaign_pair_id, beneficiary_id, amount
			   FROM campaign_pair_accruals
			  WHERE beneficiary_id=$1 AND status='pending'
			  ORDER BY campaign_pair_id
			  FOR UPDATE`,
			[memberId],
		);

		// Release all pending: backlog releases use mode="defer" (BR-13 equivalent)
		// so cap overage is credited to deferred_bonus rather than forfeited.
		// Per-accrual idempotency keys (creditBonusWithCap uses the "campaignbonus:"
		// prefix) keep a mid-txn crash + re-delivery safe.
		for (const a of pending) {
			await releaseCampaignAccrual(
				c,
				BigInt(a.campaign_pair_id),
				BigInt(a.beneficiary_id),
				toPaise(a.amount), // convert DB rupees to paise for creditBonusWithCap
				"defer",
			);
		}

		await c.query(
			"INSERT INTO processed_events (consumer_group, event_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
			[GROUP, e.event_id],
		);
	});
}

export async function run() {
	await startConsumer({
		stream: TOPICS.ledger.name,
		group: GROUP,
		mode: "message",
		onMessage: async (value) => {
			const e = JSON.parse(value) as AvgEvent;
			if (e.event_type === "CampaignPairBonusAccrued")
				await accrueCampaignPairBonus(e);
			if (e.event_type === "CampaignEligibilityReached")
				await releasePendingCampaignBonuses(e);
			// All other event types are handled by the live avg-ledger group; ignored here.
		},
	});
}

const _argv1 = process.argv[1] ?? "";
if (_argv1.endsWith("campaignLedger.ts") || _argv1.endsWith("campaignLedger.js")) {
	run().catch((err) => {
		console.error("[campaign-ledger] fatal", err);
		process.exit(1);
	});
}
