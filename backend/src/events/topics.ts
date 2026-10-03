export const TOPICS = {
	lifecycle: { name: "avg.member.lifecycle", partitions: 12 },
	increments: { name: "avg.counter.increments", partitions: 24 },
	pairs: { name: "avg.pair.matched", partitions: 12 },
	ledger: { name: "avg.ledger.commands", partitions: 12 },
	ranks: { name: "avg.rank.events", partitions: 12 },
	payouts: { name: "avg.payout.events", partitions: 3 },
	// Campaign-only stream. Consumer group: avg-campaign-counter.
	// Carries CampaignUnitsAdded events (emitted by confirmOrder).
	campaignUnits: { name: "avg.campaign.units", partitions: 12 },
} as const;

export type TopicName = (typeof TOPICS)[keyof typeof TOPICS]["name"];
