import { CFG } from "../config.js";

/** True when `at` (default: now) falls inside the campaign window. */
export function isWithinCampaign(at: Date = new Date()): boolean {
	return (
		at >= new Date(CFG.CAMPAIGN_START_ISO) &&
		at <= new Date(CFG.CAMPAIGN_END_ISO)
	);
}

/**
 * Returns the coin award for the given final package value.
 * 0 means no award (below ₹30k tier).
 */
export function coinsForPackageValuePaise(valuePaise: number): number {
	if (valuePaise >= CFG.CAMPAIGN_TIER_50K_PAISE) return CFG.CAMPAIGN_COINS_50K;
	if (valuePaise >= CFG.CAMPAIGN_TIER_30K_PAISE) return CFG.CAMPAIGN_COINS_30K;
	return 0;
}

/**
 * Returns the number of EXTRA campaign matching units for the given package value.
 * "Extra" means beyond the base 1 unit the live flat engine already pays.
 *
 * Uses an explicit tier lookup, NOT arithmetic (e.g. value/10000 − 1), so that
 * off-tier packages (e.g. the ₹25k seed product) never produce fractional or
 * garbage bigint unit counts.
 *
 *   ₹10,000 → 0   (live engine pays the base; no campaign extra)
 *   ₹30,000 → 2
 *   ₹50,000 → 4
 *   anything else → 0
 */
export function campaignExtraUnits(valuePaise: bigint): bigint {
	if (valuePaise >= BigInt(CFG.CAMPAIGN_TIER_50K_PAISE)) return 4n;
	if (valuePaise >= BigInt(CFG.CAMPAIGN_TIER_30K_PAISE)) return 2n;
	return 0n;
}
