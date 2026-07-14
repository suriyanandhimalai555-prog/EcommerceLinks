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
	counter_type: "active" | "qualified" | "rank_achiever" | "mint_check";
	rank_level?: number;
	source_member_id: number;
	source_event_id: string;
}

export interface PairMatched extends Envelope {
	event_type: "PairMatched";
	pair_id: number;
	member_id: number;
	sequence_no: number;
	left_member_id: number;
	right_member_id: number;
	amount_paise: number;
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

export type AvgEvent =
	| MemberRegistered
	| MemberActivated
	| MemberQualified
	| CounterIncrement
	| PairMatched
	| PairCompleted
	| PairBonusAccrued
	| PendingBonusReleaseRequested
	| DeferredSweepRequested
	| RankEvalRequested
	| RankAchieved
	| CutoffClosed
	| PayoutBatchCreated
	| PayoutItemSettled
	| PayoutItemFailed;
