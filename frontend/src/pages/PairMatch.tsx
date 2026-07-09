import { useQuery, useInfiniteQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { GitMerge, Download, TrendingUp } from 'lucide-react'
import api from '../lib/api'
import { formatINR, formatDateTime, orDash } from '../lib/format'
import { StatCard } from '../components/ui/StatCard'
import { SkeletonCard } from '../components/ui/Skeleton'
import { DataTable, type Column } from '../components/ui/DataTable'
import type { Pair, PairsRes, Dashboard as DashboardType } from '../types/api'

export default function PairMatch() {
  const { t } = useTranslation()

  const { data: dash, isLoading: dashLoading } = useQuery<DashboardType>({
    queryKey: ['dashboard'],
    queryFn: () => api.get('/dashboard').then(r => r.data),
  })

  // Infinite query for pairs — replaces the mock-seeded useState + fake cursor
  const pairsQ = useInfiniteQuery({
    queryKey: ['pairs'],
    queryFn: ({ pageParam }) =>
      api.get(`/pairs${pageParam ? `?cursor=${pageParam}` : ''}`).then(r => r.data as PairsRes),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  })
  const items = pairsQ.data?.pages.flatMap(p => p.items) ?? []

  const exportCSV = () => {
    const headers = ['Seq No', 'Left Member', 'Right Member', 'Bonus', 'Date']
    const rows = items.map(r => [r.sequenceNo, r.leftMemberCode, r.rightMemberCode, formatINR(r.bonusPaise), formatDateTime(r.at)])
    const csv = [headers, ...rows].map(r => r.join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'pair-matches.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  const cols: Column<Pair>[] = [
    { key: 'seq', header: '#', render: r => <span className="font-mono text-xs font-bold text-ink-muted">#{r.sequenceNo}</span> },
    { key: 'left', header: 'Left Member', render: r => <span className="font-mono text-xs font-semibold">{r.leftMemberCode}</span> },
    { key: 'right', header: 'Right Member', render: r => <span className="font-mono text-xs font-semibold">{r.rightMemberCode}</span> },
    { key: 'bonus', header: 'Bonus', align: 'right', render: r => <span className="font-bold text-success">{formatINR(r.bonusPaise)}</span> },
    { key: 'time', header: 'Matched At', render: r => <span className="text-xs text-ink-muted">{formatDateTime(r.at)}</span> },
  ]

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold text-ink">Pair Match</h1>
          <p className="text-sm text-ink-muted">Every ₹1,000 bonus earned by matching left + right</p>
        </div>
        <button onClick={exportCSV} className="avg-btn-secondary self-start sm:self-auto">
          <Download size={14} /> Export CSV
        </button>
      </div>

      {/* Summary header */}
      {dashLoading ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <SkeletonCard /><SkeletonCard /><SkeletonCard /><SkeletonCard />
        </div>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard label="Total Pairs" value={orDash(dash?.counters.pairsMatched, String)} icon={<GitMerge />} tint="primary" />
          <StatCard label="Total Bonus" value={orDash(dash?.pairMatchIncomePaise, formatINR)} icon={<TrendingUp />} tint="success" />
          <StatCard
            label={`${t('counters.active')} L · R`}
            value={dash ? `${dash.counters.leftActive} · ${dash.counters.rightActive}` : '—'}
            icon={<GitMerge />}
            tint="violet"
          />
          <StatCard label="Today's Bonus" value={orDash(dash?.todayPairBonusPaise, formatINR)} icon={<TrendingUp />} tint="warning" />
        </div>
      )}

      {/* Carry forward */}
      {dash && (
        <div className="avg-card p-4 flex items-center gap-3">
          <div className="w-10 h-10 bg-warning-50 rounded-lg flex items-center justify-center flex-shrink-0">
            <GitMerge size={18} className="text-warning" />
          </div>
          <div>
            <p className="text-sm font-semibold text-ink">Carry Forward: {dash.carryForward.side} side</p>
            <p className="text-xs text-ink-muted">{dash.carryForward.excess} unmatched activations on the {dash.carryForward.side === 'L' ? 'left' : 'right'} side</p>
          </div>
        </div>
      )}

      {/* Pairs table */}
      <div className="avg-card">
        <div className="p-5 border-b border-surface-line">
          <h2 className="text-sm font-semibold text-ink">All Matched Pairs</h2>
        </div>
        <DataTable
          columns={cols}
          data={items}
          rowKey={r => String(r.sequenceNo)}
          onLoadMore={() => pairsQ.fetchNextPage()}
          hasMore={!!pairsQ.hasNextPage}
          emptyTitle="No pairs matched yet"
          emptyDescription="Start recruiting to earn pair bonuses"
        />
      </div>
    </div>
  )
}
