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
import { campaignExtraUnits } from "../lib/campaign.js";
import { fromPaise, toPaise } from "../lib/money.js";
import { creditBonusWithCap } from "./ledger.js";
import { startConsumer } from "../lib/streams.js";

const GROUP = "avg-campaign-ledger";

/**
 * Count already-released campaign accruals for a beneficiary.
 * Released pairs are the unit of consumption against the tier cap
 * (₹30k→2 releases, ₹50k→4 releases lifetime, ₹10k→0).
 */
async function releasedCampaignCount(
	c: pg.PoolClient,
	beneficiaryId: bigint,
): Promise<number> {
	const { rows } = await c.query<{ n: number }>(
		`SELECT count(*)::int AS n FROM campaign_pair_accruals
		  WHERE beneficiary_id = $1 AND status = 'released'`,
		[beneficiaryId],
	);
	return rows[0].n;
}

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
 * the beneficiary's released count is below their tier cap
 * (₹30k→2 lifetime, ₹50k→4 lifetime, ₹10k→0).
 * Over-cap accruals stay 'pending' until a CampaignEligibilityReached event
 * fires on a package upgrade that raises the tier cap.
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
			// Check beneficiary's package tier and lifetime release count.
			const { rows: mRows } = await c.query<{ package_value_paise: string }>(
				"SELECT package_value_paise FROM members WHERE id=$1",
				[beneficiaryId],
			);
			const pkgPaise = BigInt(mRows[0]?.package_value_paise ?? "0");
			// Tier cap: ₹10k→0, ₹30k→2, ₹50k→4 (lifetime, not per-week).
			const cap = Number(campaignExtraUnits(pkgPaise));
			const released = await releasedCampaignCount(c, beneficiaryId);
			if (released < cap) {
				// Within tier cap: release immediately with mode="forfeit" (BR-12
				// equivalent — ongoing accrual, cap overage is forfeited to system).
				await releaseCampaignAccrual(c, campaignPairId, beneficiaryId, amountPaise, "forfeit");
			}
			// else: accrual stays 'pending'; CampaignEligibilityReached releases it on upgrade.
		}

		await c.query(
			"INSERT INTO processed_events (consumer_group, event_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
			[GROUP, e.event_id],
		);
	});
}

/**
 * Handle CampaignEligibilityReached: release pending campaign accruals for this
 * member up to the headroom of their current tier cap (BR-13 equivalent —
 * qualification-backlog release, mode="defer" so cap overage goes to
 * deferred_bonus rather than being forfeited).
 *
 * Fired when a member's package crosses a tier boundary that raises
 * campaignExtraUnits (₹10k→₹30k: +2 cap, ₹30k→₹50k: +2 more cap).
 * Headroom = GREATEST(0, cap − already_released) — never negative, so
 * members who were previously released under an old uncapped rule are
 * safely grandfathered (0 additional releases, no clawback).
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

		// Read the member's current package tier (ratcheted, so this is ≥ the tier
		// that triggered the event — safe to compute the new cap from).
		const { rows: mRows } = await c.query<{ package_value_paise: string }>(
			"SELECT package_value_paise FROM members WHERE id=$1",
			[memberId],
		);
		const pkgPaise = BigInt(mRows[0]?.package_value_paise ?? "0");
		const cap = Number(campaignExtraUnits(pkgPaise)); // 0 | 2 | 4
		const alreadyReleased = await releasedCampaignCount(c, memberId);
		const headroom = Math.max(0, cap - alreadyReleased);

		if (headroom === 0) {
			// Already at or above cap — nothing to release (grandfathered or max tier).
			await c.query(
				"INSERT INTO processed_events (consumer_group, event_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
				[GROUP, e.event_id],
			);
			return;
		}

		// Lock pending accruals oldest-first (campaign_pair_id ASC) up to headroom.
		// Stable order avoids deadlocks if this event is ever re-delivered concurrently.
		const { rows: pending } = await c.query<{
			campaign_pair_id: string;
			beneficiary_id: string;
			amount: string; // NUMERIC(14,2) rupees from DB
		}>(
			`SELECT campaign_pair_id, beneficiary_id, amount
			   FROM campaign_pair_accruals
			  WHERE beneficiary_id=$1 AND status='pending'
			  ORDER BY campaign_pair_id
			  LIMIT $2
			  FOR UPDATE`,
			[memberId, headroom],
		);

		// Release up to headroom pairs: backlog releases use mode="defer" (BR-13 equivalent)
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
