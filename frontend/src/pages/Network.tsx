import { useEffect, useState } from 'react'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Network as NetworkIcon, Users, UserCheck, List, GitFork, Search } from 'lucide-react'
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend, BarChart, Bar, XAxis, YAxis, CartesianGrid } from 'recharts'
import api from '../lib/api'
import { formatDate, orDash } from '../lib/format'
import { StatCard } from '../components/ui/StatCard'
import { BinaryTree } from '../components/tree/BinaryTree'
import { useTreeDrilldown } from '../components/tree/useTreeDrilldown'
import { DataTable, type Column } from '../components/ui/DataTable'
import { Badge } from '../components/ui/Badge'
import { SkeletonCard } from '../components/ui/Skeleton'
import type { NetworkSummary, DownlineMember, DownlinePage } from '../types/api'

const PAGE_SIZE = 20

export default function Network() {
  const { t } = useTranslation()
  const [view, setView] = useState<'binary' | 'list'>('binary')

  // Downline list: debounced search + page/limit pagination.
  const [input, setInput] = useState('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  useEffect(() => {
    const timer = setTimeout(() => { setQ(input); setPage(1) }, 350)
    return () => clearTimeout(timer)
  }, [input])

  const { data: summary } = useQuery<NetworkSummary>({
    queryKey: ['network-summary'],
    queryFn: () => api.get('/network/summary').then(r => r.data),
  })
  const { data: downline, isPending: downlinePending } = useQuery<DownlinePage>({
    queryKey: ['downline', q, page],
    queryFn: () =>
      api.get(`/network/downline?q=${encodeURIComponent(q)}&page=${page}&limit=${PAGE_SIZE}`).then(r => r.data),
    placeholderData: keepPreviousData,
    enabled: view === 'list',
  })
  const total = downline?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  // Server-side drill-down: clicking a member re-roots the tree at that member.
  // Depth grows automatically as the user zooms out (requestDeeper).
  const { root: tree, isFetching, depth, requestDeeper, drillTo, back, backToMe, canGoBack } = useTreeDrilldown(3)

  // Guard divide-by-zero: totalTeam can be 0 for a fresh root
  const leftPct = summary && summary.totalTeam > 0
    ? ((summary.leftTeam / summary.totalTeam) * 100).toFixed(0) + '%'
    : '—'
  const rightPct = summary && summary.totalTeam > 0
    ? ((summary.rightTeam / summary.totalTeam) * 100).toFixed(0) + '%'
    : '—'

  const pieData = summary ? [
    { name: 'Left Team', value: summary.leftTeam, color: '#4169E1' },
    { name: 'Right Team', value: summary.rightTeam, color: '#38BDF8' },
  ] : []

  const columns: Column<DownlineMember>[] = [
    { key: 'code', header: 'Member Code', render: (r) => <span className="font-mono text-xs font-semibold text-ink">{r.memberCode}</span> },
    { key: 'name', header: 'Name', render: (r) => <span className="font-medium">{r.name}</span> },
    { key: 'level', header: t('downline.level'), render: (r) => <Badge variant="neutral">L{r.level}</Badge> },
    { key: 'leg', header: t('downline.leg'), render: (r) => <Badge variant={r.leg === 'L' ? 'primary' : 'violet'}>{r.leg === 'L' ? t('downline.left') : t('downline.right')}</Badge> },
    {
      key: 'active', header: t('counters.active'),
      render: (r) => r.isActive ? <Badge variant="success">Active</Badge> : <Badge variant="neutral">Inactive</Badge>
    },
    {
      key: 'qualified', header: t('counters.qualified'),
      render: (r) => r.isQualified ? <Badge variant="warning">Qualified</Badge> : <Badge variant="neutral">—</Badge>
    },
    { key: 'joined', header: t('downline.joined'), render: (r) => <span className="text-xs text-ink-muted">{formatDate(r.joinedAt)}</span> },
  ]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-ink">My Network</h1>
        <p className="text-sm text-ink-muted">Binary tree and team overview</p>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
        <StatCard label="Total Team" value={orDash(summary?.totalTeam, String)} icon={<Users />} tint="primary" />
        <StatCard label="Left Team" value={orDash(summary?.leftTeam, String)} icon={<NetworkIcon />} tint="primary" />
        <StatCard label="Right Team" value={orDash(summary?.rightTeam, String)} icon={<NetworkIcon />} tint="violet" />
        <StatCard label={t('counters.active')} value={orDash(summary?.activeMembers, String)} icon={<UserCheck />} tint="success" />
        <StatCard label={t('counters.qualified')} value={orDash(summary?.qualifiedMembers, String)} icon={<UserCheck />} tint="warning" />
      </div>

      {/* Tree / List toggle */}
      <div className="avg-card p-5 min-w-0">
        <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
          <h2 className="text-sm font-semibold text-ink">Binary Network Tree</h2>
          <div className="flex items-center gap-2">
            <div className="flex bg-white/5 rounded-lg p-0.5 gap-0.5">
              {[{ id: 'binary', icon: GitFork, label: 'Tree' }, { id: 'list', icon: List, label: 'List' }].map((v) => (
                <button
                  key={v.id}
                  onClick={() => setView(v.id as 'binary' | 'list')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-all cursor-pointer ${view === v.id ? 'bg-white/10 text-ink shadow-sm' : 'text-ink-muted hover:text-ink'}`}
                >
                  <v.icon size={14} /> {v.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {view === 'binary' ? (
          tree
            ? <BinaryTree
                root={tree}
                depth={depth}
                onNodeClick={drillTo}
                onBack={back}
                onBackToMe={backToMe}
                canGoBack={canGoBack}
                isFetching={isFetching}
                requestDeeper={requestDeeper}
              />
            : <div className="py-10 text-center text-sm text-ink-muted">Loading tree…</div>
        ) : (
          <>
            <div className="relative max-w-md mb-3">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted" />
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={t('downline.searchPlaceholder')}
                className="w-full rounded-lg border border-surface-line bg-[#10141F] pl-9 pr-3 py-2.5 text-sm text-ink placeholder:text-ink-muted/60 outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
              />
            </div>
            <DataTable
              columns={columns}
              data={downline?.items ?? []}
              loading={downlinePending}
              rowKey={(r) => r.memberCode}
              emptyTitle={t('downline.empty')}
              emptyDescription={t('downline.emptyHint')}
            />
            {total > 0 && (
              <div className="pt-3 mt-1 border-t border-surface-line flex items-center justify-between gap-4 flex-wrap">
                <span className="text-xs text-ink-muted">
                  {t('downline.showing', {
                    from: (page - 1) * PAGE_SIZE + 1,
                    to: Math.min(page * PAGE_SIZE, total),
                    total,
                  })}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setPage((p) => p - 1)}
                    disabled={page === 1}
                    className="avg-btn-secondary py-1.5 px-3 text-xs disabled:opacity-40"
                  >
                    ‹ Prev
                  </button>
                  <span className="px-3 text-xs font-medium text-ink">{page} / {totalPages}</span>
                  <button
                    onClick={() => setPage((p) => p + 1)}
                    disabled={page >= totalPages}
                    className="avg-btn-secondary py-1.5 px-3 text-xs disabled:opacity-40"
                  >
                    Next ›
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Distribution + Donut */}
      <div className="grid lg:grid-cols-2 gap-6">
        {/* Level distribution */}
        <div className="avg-card p-5">
          <h2 className="text-sm font-semibold text-ink mb-4">Level-wise Distribution</h2>
          {summary ? (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={summary.levelDistribution} margin={{ left: -20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#232A40" vertical={false} />
                <XAxis dataKey="level" tick={{ fontSize: 11, fill: '#77809A' }} axisLine={false} tickLine={false} tickFormatter={(v) => `L${v}`} />
                <YAxis tick={{ fontSize: 11, fill: '#77809A' }} axisLine={false} tickLine={false} />
                <Tooltip cursor={{ fill: 'rgba(255, 255, 255, 0.06)' }} contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #272E44', backgroundColor: '#1B2236', color: '#F2F4FA' }} />
                <Bar dataKey="members" fill="#4169E1" radius={[4, 4, 0, 0]} name="Members" />
              </BarChart>
            </ResponsiveContainer>
          ) : <SkeletonCard lines={4} />}
        </div>

        {/* Team Split donut */}
        <div className="avg-card p-5">
          <h2 className="text-sm font-semibold text-ink mb-4">Team Split</h2>
          {summary ? (
            <>
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie data={pieData} cx="50%" cy="50%" innerRadius={60} outerRadius={90} paddingAngle={3} dataKey="value">
                    {pieData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                  </Pie>
                  <Tooltip formatter={(v) => [`${v} members`, '']} contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #272E44', backgroundColor: '#1B2236', color: '#F2F4FA' }} />
                  <Legend formatter={(v) => <span className="text-xs font-medium">{v}</span>} />
                </PieChart>
              </ResponsiveContainer>
              <div className="grid grid-cols-2 gap-4 mt-2 pt-4 border-t border-surface-line">
                <div className="text-center">
                  <div className="text-2xl font-bold text-primary">{leftPct}</div>
                  <div className="text-xs text-ink-muted">Left active ratio</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-violet">{rightPct}</div>
                  <div className="text-xs text-ink-muted">Right active ratio</div>
                </div>
              </div>
            </>
          ) : <SkeletonCard lines={4} />}
        </div>
      </div>
    </div>
  )
}
