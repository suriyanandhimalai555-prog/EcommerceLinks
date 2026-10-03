const CAMPAIGN_START = new Date('2026-10-02T00:00:00+05:30')
const CAMPAIGN_END   = new Date('2026-11-05T23:59:59+05:30')

export function isWithinCampaign(at: Date = new Date()): boolean {
  return at >= CAMPAIGN_START && at <= CAMPAIGN_END
}

/** Human-readable date range for display. */
export const CAMPAIGN_DATE_LABEL = '2 October – 5 November 2026'
