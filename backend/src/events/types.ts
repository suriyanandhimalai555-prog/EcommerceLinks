interface Envelope {
	event_id: string;
	event_type: string;
	occurred_at: string;
	schema_version: 1;
}

export interface MemberRegistered extends Envelope {
	event_type: "MemberRegistered";
	member_id: number;
	sponsor_id: number | null;
	parent_id: number | null;
	position: "L" | "R" | null;
	placement_path: number[];
	placement_sides: string[];
}

export interface MemberActivated extends Envelope {
	event_type: "MemberActivated";
	member_id: number;
	order_id: number;
	bv_paise: number;
}

export interface MemberQualified extends Envelope {
	event_type: "MemberQualified";
	member_id: number;
	via_child_id: number;
	via_grandchild_id: number;
}

export interface CounterIncrement extends Envelope {
	event_type: "CounterIncrement";
	ancestor_id: number;
	side: "L" | "R";
	counter_type: "active" | "qualified" | "rank_achiever";
	rank_level?: number;
	source_member_id: number;
	source_event_id: string;
}

// Both direct referrals of member_id are active — one per member, ever.
export interface PairCompleted extends Envelope {
	event_type: "PairCompleted";
	pair_id: number;
	member_id: number;
	left_member_id: number;
	right_member_id: number;
	amount_paise: number;
}

// One per beneficiary of a completed pair (the pair owner + every ancestor).
export interface PairBonusAccrued extends Envelope {
	event_type: "PairBonusAccrued";
	beneficiary_id: number;
	pair_id: number;
	pair_member_id: number;
	amount_paise: number;
	source_event_id: string;
}

// Member just qualified — release their pending pair_accruals.
export interface PendingBonusReleaseRequested extends Envelope {
	event_type: "PendingBonusReleaseRequested";
	member_id: number;
}

export interface DeferredSweepRequested extends Envelope {
	event_type: "DeferredSweepRequested";
	member_id: number;
	new_cutoff_id: number;
}

// Sweep the snapshotted earnings wallet balance into the withdrawable wallet.
// amount_paise is captured inside the cutoff-close transaction so the handler
// moves exactly that amount regardless of delivery order or re-delivery.
export interface WithdrawableSweepRequested extends Envelope {
	event_type: "WithdrawableSweepRequested";
	member_id: number;
	/** Cutoff that just closed — used as part of the idempotency key. */
	closed_cutoff_id: number;
	/** Exact wallet balance at cutoff-close time to move into withdrawable. */
	amount_paise: number;
}

export interface RankEvalRequested extends Envelope {
	event_type: "RankEvalRequested";
	member_id: number;
}

export interface RankAchieved extends Envelope {
	event_type: "RankAchieved";
	member_id: number;
	rank_level: number;
}

export interface CutoffClosed extends Envelope {
	event_type: "CutoffClosed";
	cutoff_id: number;
	window_start: string;
	window_end: string;
}

export interface PayoutBatchCreated extends Envelope {
	event_type: "PayoutBatchCreated";
	batch_id: number;
	scheduled_for: string;
	item_count: number;
	total_net_paise: number;
}

export interface PayoutItemSettled extends Envelope {
	event_type: "PayoutItemSettled";
	payout_item_id: number;
	member_id: number;
	net_paise: number;
	bank_ref: string;
}

export interface PayoutItemFailed extends Envelope {
	event_type: "PayoutItemFailed";
	payout_item_id: number;
	member_id: number;
	net_paise: number;
	reason: string;
}

// --- Campaign pair-matching events (Phase B) ---
// Live pair-matching events above are untouched; these are a parallel campaign layer.

// Emitted by confirmOrder for every in-window activation or upgrade that changes a
// member's unit count or headcount contribution to the campaign layer.
//
// member_delta = 1 for a first activation (new head counted); 0 for a pure upgrade.
// unit_delta   = change in TOTAL campaign units (₹10k→1, ₹30k→3, ₹50k→5); always ≥ 0.
// At least one of member_delta or unit_delta is > 0 (never emitted otherwise).
//
// campaignCounter.ts fans both deltas up the placement path and computes:
//   T = LEAST(left_units, right_units)    — §4 total-unit match
//   B = LEAST(left_members, right_members) — live-engine headcount base
//   target = GREATEST(priorMatched, T − B) — top-up only; no double-count
// Only emitted during the campaign window.
export interface CampaignUnitsAdded extends Envelope {
	event_type: "CampaignUnitsAdded";
	member_id: number;
	member_delta: number;     // 1 = first activation; 0 = upgrade of existing head
	unit_delta: number;       // change in total campaign units (0–5); bigint-safe
	new_value_paise: number;  // member's new package_value_paise after ratchet
}

// Emitted by campaignCounter.ts when a campaign pair is minted for an ancestor.
// event_id is deterministic: campaignAccrualEventId(campaignPairId, beneficiaryId).
export interface CampaignPairBonusAccrued extends Envelope {
	event_type: "CampaignPairBonusAccrued";
	beneficiary_id: number;
	campaign_pair_id: number;
	amount_paise: number;
}

// Emitted by confirmOrder when a member's package_value_paise crosses ≥₹30k.
// Triggers release of any pending campaign pair accruals for this member.
// Only emitted during the campaign window.
export interface CampaignEligibilityReached extends Envelope {
	event_type: "CampaignEligibilityReached";
	member_id: number;
}

export type AvgEvent =
	| MemberRegistered
	| MemberActivated
	| MemberQualified
	| CounterIncrement
	| PairCompleted
	| PairBonusAccrued
	| PendingBonusReleaseRequested
	| DeferredSweepRequested
	| WithdrawableSweepRequested
	| RankEvalRequested
	| RankAchieved
	| CutoffClosed
	| PayoutBatchCreated
	| PayoutItemSettled
	| PayoutItemFailed
	| CampaignUnitsAdded
	| CampaignPairBonusAccrued
	| CampaignEligibilityReached;
