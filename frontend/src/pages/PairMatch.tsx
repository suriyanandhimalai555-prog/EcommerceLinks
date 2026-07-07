import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { GitMerge, Download, TrendingUp } from 'lucide-react'
import api from '../lib/api'
import { formatINR, formatDateTime } from '../lib/format'
import { StatCard } from '../components/ui/StatCard'
import { DataTable, type Column } from '../components/ui/DataTable'
import type { Pair } from '../types/api'
import { mockPairs, mockDashboard } from '../mocks/data'

export default function PairMatch() {
  const { t } = useTranslation()
  const [items, setItems] = useState<Pair[]>(mockPairs.slice(0, 10))
  const [cursor, setCursor] = useState<string | null>('cursor-page-2')

  const { data: dash } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.get('/dashboard').then(r => r.data),
    placeholderData: mockDashboard,
  })

  const d = dash || mockDashboard

  const loadMore = async () => {
    const res = await api.get(`/pairs?cursor=${cursor}`)
    const newItems = res.data.items.filter(
      (n: Pair) => !items.find(i => i.sequenceNo === n.sequenceNo)
    )
    setItems(prev => [...prev, ...newItems])
    setCursor(res.data.nextCursor)
  }

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
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Total Pairs" value={String(d.counters.pairsMatched)} icon={<GitMerge />} tint="primary" />
        <StatCard label="Total Bonus" value={formatINR(d.pairMatchIncomePaise)} icon={<TrendingUp />} tint="success" />
        <StatCard label={`${t('counters.active')} L · R`} value={`${d.counters.leftActive} · ${d.counters.rightActive}`} icon={<GitMerge />} tint="violet" />
        <StatCard label="Today's Bonus" value={formatINR(d.todayPairBonusPaise)} icon={<TrendingUp />} tint="warning" />
      </div>

      {/* Carry forward */}
      <div className="avg-card p-4 flex items-center gap-3">
        <div className="w-10 h-10 bg-warning-50 rounded-lg flex items-center justify-center flex-shrink-0">
          <GitMerge size={18} className="text-warning" />
        </div>
        <div>
          <p className="text-sm font-semibold text-ink">Carry Forward: {d.carryForward.side} side</p>
          <p className="text-xs text-ink-muted">{d.carryForward.excess} unmatched activations on the {d.carryForward.side === 'L' ? 'left' : 'right'} side</p>
        </div>
      </div>

      {/* Pairs table */}
      <div className="avg-card">
        <div className="p-5 border-b border-surface-line">
          <h2 className="text-sm font-semibold text-ink">All Matched Pairs</h2>
        </div>
        <DataTable
          columns={cols}
          data={items}
          rowKey={r => String(r.sequenceNo)}
          onLoadMore={loadMore}
          hasMore={!!cursor}
          emptyTitle="No pairs matched yet"
          emptyDescription="Start recruiting to earn pair bonuses"
        />
      </div>
    </div>
  )
}
