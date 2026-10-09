/**
 * CampaignPairMatch — shows the campaign's parallel pair-matching history.
 *
 * This is a self-contained, additive layer over the /pairs page.
 * It reads exclusively from GET /campaign/pairs (campaign_pair_accruals +
 * campaign_pairs) and never touches the live pair tables.
 *
 * Removal checklist (after the campaign):
 *   1. Delete this file.
 *   2. Remove the import + <CampaignPairMatch /> from PairMatch.tsx.
 *   3. Remove GET /campaign/pairs from backend/src/api/frontend.ts.
 *   4. Remove CampaignPair* types from frontend/src/types/api.ts.
 *   5. Remove pairs.campaign.* keys from en.json and ta.json.
 */
import { useInfiniteQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { GitMerge, AlertTriangle, Info, CheckCircle, TrendingUp, Clock } from 'lucide-react'
import api from '../../lib/api'
import { formatINR, formatDateTime } from '../../lib/format'
import { StatCard } from '../ui/StatCard'
import { Badge } from '../ui/Badge'
import { DataTable, type Column } from '../ui/DataTable'
import { SkeletonCard } from '../ui/Skeleton'
import type { CampaignPair, CampaignPairsRes } from '../../types/api'

export function CampaignPairMatch() {
  const { t } = useTranslation()

  const q = useInfiniteQuery({
    queryKey: ['campaign-pairs'],
    queryFn: ({ pageParam }) =>
      api
        .get(`/campaign/pairs${pageParam ? `?cursor=${pageParam}` : ''}`)
        .then((r) => r.data as CampaignPairsRes),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  })

  const pages = q.data?.pages ?? []
  const items = pages.flatMap((p) => p.items)
  const summary = pages[0]?.summary

  // Auto-hide when the window is closed and no campaign pairs exist at all.
  if (!q.isLoading && !summary?.withinWindow && (summary?.pendingCount ?? 0) === 0 && (summary?.releasedCount ?? 0) === 0) {
    return null
  }

  const totalPairs = (summary?.releasedCount ?? 0) + (summary?.pendingCount ?? 0)

  const cols: Column<CampaignPair>[] = [
    {
      key: 'seq',
      header: t('pairs.campaign.colSeq'),
      render: (r) => (
        <span className="font-mono text-xs font-bold text-ink-muted">
          #{r.sequenceNo}
        </span>
      ),
    },
    {
      key: 'bonus',
      header: 'Bonus',
      align: 'right',
      render: (r) => (
        <span className="font-bold text-success">{formatINR(r.bonusPaise)}</span>
      ),
    },
    {
      key: 'status',
      header: t('pairs.status'),
      render: (r) => (
        <Badge
          variant={r.status === 'released' ? 'success' : 'warning'}
          size="sm"
        >
          {t(r.status === 'released' ? 'pairs.released' : 'pairs.pending')}
        </Badge>
      ),
    },
    {
      key: 'time',
      header: 'Matched At',
      render: (r) => (
        <span className="text-xs text-ink-muted">{formatDateTime(r.at)}</span>
      ),
    },
  ]

  return (
    <div className="avg-card">
      {/* Header */}
      <div className="p-5 border-b border-surface-line flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-ink">
            {t('pairs.campaign.title')}
          </h2>
          <Badge variant="primary" size="sm">
            {t('pairs.campaign.badge')}
          </Badge>
        </div>
      </div>

      <div className="p-5 space-y-5">
        {/* Eligibility callout — 3-state */}
        {summary && !summary.eligible && summary.pendingCount > 0 && (
          summary.withinWindow ? (
            /* Actionable: window open, can still upgrade */
            <div className="flex gap-3 p-4 rounded-lg bg-warning/10 border border-warning/30">
              <AlertTriangle size={16} className="text-warning flex-shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-ink">
                  {t('airdrop.commissionNote')}
                </p>
                <p className="text-xs text-ink-muted">
                  {t('pairs.campaign.pendingCta', {
                    count: summary.pendingCount,
                    amount: formatINR(summary.pendingBonusPaise),
                  })}
                </p>
              </div>
            </div>
          ) : (
            /* Informational: window closed, unrecoverable */
            <div className="flex gap-3 p-4 rounded-lg bg-surface-line border border-surface-line">
              <Info size={16} className="text-ink-muted flex-shrink-0 mt-0.5" />
              <p className="text-sm text-ink-muted">
                {t('pairs.campaign.endedUncollected', {
                  count: summary.pendingCount,
                  amount: formatINR(summary.pendingBonusPaise),
                })}
              </p>
            </div>
          )
        )}

        {summary && summary.eligible && totalPairs > 0 && (
          <div className="flex gap-3 p-4 rounded-lg bg-success/10 border border-success/30">
            <CheckCircle size={16} className="text-success flex-shrink-0 mt-0.5" />
            <p className="text-sm text-ink-muted">
              {t('pairs.campaign.eligibleNote')}
            </p>
          </div>
        )}

        {/* Summary stat cards */}
        {q.isLoading ? (
          <div className="grid grid-cols-3 gap-4">
            <SkeletonCard /><SkeletonCard /><SkeletonCard />
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-4">
            <StatCard
              label={t('pairs.campaign.statPairs')}
              value={String(totalPairs)}
              icon={<GitMerge />}
              tint="primary"
            />
            <StatCard
              label={t('pairs.campaign.statReleased')}
              value={formatINR(summary?.releasedBonusPaise ?? 0)}
              icon={<TrendingUp />}
              tint="success"
            />
            <StatCard
              label={t('pairs.campaign.statPending')}
              value={formatINR(summary?.pendingBonusPaise ?? 0)}
              icon={<Clock />}
              tint="warning"
            />
          </div>
        )}

        {/* Campaign pairs table */}
        <DataTable
          columns={cols}
          data={items}
          rowKey={(r) => String(r.sequenceNo)}
          onLoadMore={() => q.fetchNextPage()}
          hasMore={!!q.hasNextPage}
          emptyTitle={t('pairs.campaign.empty')}
          emptyDescription=""
        />
      </div>
    </div>
  )
}
