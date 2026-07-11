import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Network as NetworkIcon, Users, UserCheck, List, GitFork } from 'lucide-react'
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend, BarChart, Bar, XAxis, YAxis, CartesianGrid } from 'recharts'
import api from '../lib/api'
import { formatDate, orDash } from '../lib/format'
import { StatCard } from '../components/ui/StatCard'
import { BinaryTree } from '../components/tree/BinaryTree'
import { useTreeDrilldown } from '../components/tree/useTreeDrilldown'
import { DataTable, type Column } from '../components/ui/DataTable'
import { Badge } from '../components/ui/Badge'
import { SkeletonCard } from '../components/ui/Skeleton'
import type { NetworkSummary, DirectMember } from '../types/api'

export default function Network() {
  const { t } = useTranslation()
  const [view, setView] = useState<'binary' | 'list'>('binary')

  const { data: summary } = useQuery<NetworkSummary>({
    queryKey: ['network-summary'],
    queryFn: () => api.get('/network/summary').then(r => r.data),
  })
  const { data: directs } = useQuery<{ items: DirectMember[] }>({
    queryKey: ['directs'],
    queryFn: () => api.get('/network/directs').then(r => r.data),
  })
  // Server-side drill-down: clicking a member re-roots the tree at that member,
  // letting the user browse the entire downline 3 levels at a time.
  const { root: tree, isFetching, drillTo, back, backToMe, canGoBack } = useTreeDrilldown(3)

  // Guard divide-by-zero: totalTeam can be 0 for a fresh root
  const leftPct = summary && summary.totalTeam > 0
    ? ((summary.leftTeam / summary.totalTeam) * 100).toFixed(0) + '%'
    : '—'
  const rightPct = summary && summary.totalTeam > 0
    ? ((summary.rightTeam / summary.totalTeam) * 100).toFixed(0) + '%'
    : '—'

  const pieData = summary ? [
    { name: 'Left Team', value: summary.leftTeam, color: '#2447D8' },
    { name: 'Right Team', value: summary.rightTeam, color: '#7C3AED' },
  ] : []

  const columns: Column<DirectMember>[] = [
    { key: 'code', header: 'Member Code', render: (r) => <span className="font-mono text-xs font-semibold text-ink">{r.memberCode}</span> },
    { key: 'name', header: 'Name', render: (r) => <span className="font-medium">{r.name}</span> },
    { key: 'leg', header: 'Leg', render: (r) => <Badge variant={r.leg === 'L' ? 'primary' : 'violet'}>{r.leg === 'L' ? 'Left' : 'Right'}</Badge> },
    {
      key: 'active', header: t('counters.active'),
      render: (r) => r.isActive ? <Badge variant="success">Active</Badge> : <Badge variant="neutral">Inactive</Badge>
    },
    {
      key: 'qualified', header: t('counters.qualified'),
      render: (r) => r.isQualified ? <Badge variant="warning">Qualified</Badge> : <Badge variant="neutral">—</Badge>
    },
    { key: 'joined', header: 'Joined', render: (r) => <span className="text-xs text-ink-muted">{formatDate(r.joinedAt)}</span> },
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
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-ink">Binary Network Tree</h2>
          <div className="flex bg-gray-100 rounded-lg p-0.5 gap-0.5">
            {[{ id: 'binary', icon: GitFork, label: 'Tree' }, { id: 'list', icon: List, label: 'List' }].map((v) => (
              <button
                key={v.id}
                onClick={() => setView(v.id as 'binary' | 'list')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-all cursor-pointer ${view === v.id ? 'bg-white text-ink shadow-sm' : 'text-ink-muted hover:text-ink'}`}
              >
                <v.icon size={14} /> {v.label}
              </button>
            ))}
          </div>
        </div>

        {view === 'binary' ? (
          tree
            ? <BinaryTree
                root={tree}
                depth={3}
                onNodeClick={drillTo}
                onBack={back}
                onBackToMe={backToMe}
                canGoBack={canGoBack}
                isFetching={isFetching}
              />
            : <div className="py-10 text-center text-sm text-ink-muted">Loading tree…</div>
        ) : (
          <DataTable
            columns={columns}
            data={directs?.items ?? []}
            rowKey={(r) => r.memberCode}
            emptyTitle="No direct members yet"
            emptyDescription="Share your referral link to add members"
          />
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
                <CartesianGrid strokeDasharray="3 3" stroke="#F3F4F6" vertical={false} />
                <XAxis dataKey="level" tick={{ fontSize: 11, fill: '#9CA3AF' }} axisLine={false} tickLine={false} tickFormatter={(v) => `L${v}`} />
                <YAxis tick={{ fontSize: 11, fill: '#9CA3AF' }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #E5E7EB' }} />
                <Bar dataKey="members" fill="#2447D8" radius={[4, 4, 0, 0]} name="Members" />
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
                  <Tooltip formatter={(v) => [`${v} members`, '']} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
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
