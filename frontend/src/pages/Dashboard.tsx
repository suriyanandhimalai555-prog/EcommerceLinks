import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  Wallet, GitMerge, TrendingUp, Clock, ArrowUpRight, ShoppingBag,
  ChevronRight, Info, Trophy, UserPlus, Users, AlertCircle,
} from 'lucide-react'
import {
  ResponsiveContainer, XAxis, YAxis, CartesianGrid,
  Tooltip, Area, AreaChart,
} from 'recharts'
import api from '../lib/api'
import { formatINR, formatDateTime } from '../lib/format'
import { StatCard } from '../components/ui/StatCard'
import { BinaryTree } from '../components/tree/BinaryTree'
import { CopyField } from '../components/ui/CopyField'
import { Badge } from '../components/ui/Badge'
import { SkeletonCard } from '../components/ui/Skeleton'
import type { Dashboard as DashboardType, Me } from '../types/api'

function txIcon(type: string, direction: string) {
  if (type === 'pair_bonus') return <GitMerge size={15} />
  if (type === 'payout' || (type === 'sweep' && direction === 'debit')) return <ArrowUpRight size={15} />
  if (type === 'purchase') return <ShoppingBag size={15} />
  return <Clock size={15} />
}

function txColor(type: string, direction: string) {
  if (direction === 'credit') return 'bg-success-50 text-success'
  if (type === 'purchase') return 'bg-red-50 text-danger'
  return 'bg-gray-100 text-ink-muted'
}

export default function Dashboard() {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const { data: meData } = useQuery<Me>({
    queryKey: ['me'],
    queryFn: () => api.get('/me').then((r) => r.data),
  })

  const { data: dash, isLoading, isError, refetch } = useQuery<DashboardType>({
    queryKey: ['dashboard'],
    queryFn: () => api.get('/dashboard').then((r) => r.data),
  })

  const { data: tree } = useQuery({
    queryKey: ['tree', 'me', 2],
    queryFn: () => api.get('/network/tree?root=me&depth=2').then((r) => r.data),
  })

  if (isError) return (
    <div className="avg-card p-10 flex flex-col items-center gap-4 text-center">
      <AlertCircle size={36} className="text-danger" />
      <div>
        <p className="text-sm font-semibold text-ink">Failed to load dashboard</p>
        <p className="text-xs text-ink-muted mt-1">Check your connection and try again</p>
      </div>
      <button onClick={() => refetch()} className="avg-btn-secondary">Retry</button>
    </div>
  )

  if (isLoading || !dash) return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">{[1,2,3,4].map(i => <SkeletonCard key={i} />)}</div>
      <SkeletonCard lines={5} />
    </div>
  )

  const d = dash
  const chartData = d.incomeSeries.slice(-14).map((s) => ({
    date: new Date(s.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }),
    income: s.pairPaise / 100,
  }))

  const sponsorCode = meData?.memberCode ?? ''
  const referralUrl = `${window.location.origin}/register?sponsor=${sponsorCode}`

  return (
    <div className="space-y-6 w-full">
      {/* Page title */}
      <div>
        <h1 className="text-xl font-bold text-ink">{t('dashboard.totalIncome')} Overview</h1>
        <p className="text-sm text-ink-muted">Welcome back, {meData?.name ?? '—'} 👋</p>
      </div>

      {/* Row 1: Stat Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label={t('dashboard.totalIncome')}
          value={formatINR(d.totalIncomePaise)}
          sub="All time earnings"
          icon={<Wallet />}
          tint="primary"
        />
        <StatCard
          label={t('dashboard.pairMatchIncome')}
          value={formatINR(d.pairMatchIncomePaise)}
          sub={`${d.counters.pairsMatched} pairs matched`}
          icon={<GitMerge />}
          tint="success"
        />
        <StatCard
          label={t('dashboard.walletBalance')}
          value={formatINR(d.walletBalancePaise)}
          sub="Available to withdraw"
          icon={<Wallet />}
          tint="violet"
        />
        <StatCard
          label={t('dashboard.deferred')}
          value={formatINR(d.deferredBalancePaise)}
          sub={
            <span className="flex items-center gap-1">
              {t('wallet.deferred')}
              <Info size={10} className="cursor-help" aria-label={t('wallet.capNote')} />
            </span>
          }
          icon={<Clock />}
          tint="warning"
        />
      </div>

      {/* Row 2: Network + Pair Match Summary */}
      <div className="grid w-full lg:grid-cols-2 gap-6">
        {/* Network Overview */}
        <div className="avg-card p-5 min-w-0">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-ink">{t('dashboard.networkOverview')}</h2>
            <Link to="/network" className="text-xs text-primary font-medium hover:underline flex items-center gap-0.5">
              View all <ChevronRight size={12} />
            </Link>
          </div>
          {tree
            ? <BinaryTree root={tree} depth={2} compact />
            : <div className="py-8 text-center text-sm text-ink-muted">Loading network…</div>
          }

          {/* Mini stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-4 pt-4 border-t border-surface-line">
            {[
              { label: 'Left Team', value: d.counters.leftActive },
              { label: 'Right Team', value: d.counters.rightActive },
              { label: 'Total', value: d.counters.leftActive + d.counters.rightActive },
              { label: 'Active', value: d.counters.leftActive + d.counters.rightActive },
            ].map((s) => (
              <div key={s.label} className="text-center">
                <div className="text-lg font-bold text-ink">{s.value}</div>
                <div className="text-[10px] text-ink-muted uppercase tracking-wide">{s.label}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Pair Match Summary */}
        <div className="avg-card p-5 flex flex-col min-w-0">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-ink">{t('dashboard.pairSummary')}</h2>
            <Link to="/pairs" className="text-xs text-primary font-medium hover:underline flex items-center gap-0.5">
              Details <ChevronRight size={12} />
            </Link>
          </div>

          <div className="flex-1 space-y-0">
            {/* Total pairs */}
            <div className="flex items-center justify-between py-2.5 border-b border-surface-line">
              <span className="text-sm text-ink-muted flex items-center gap-2">
                <GitMerge size={14} className="text-primary" /> Total Pairs
              </span>
              <span className="text-sm font-bold text-ink">{d.counters.pairsMatched}</span>
            </div>

            {/* Active counts — FC-2 */}
            <div className="flex items-center justify-between py-2.5 border-b border-surface-line">
              <span className="text-sm text-ink-muted flex items-center gap-2">
                <Users size={14} className="text-success" />
                <span>{t('counters.active')}</span>
              </span>
              <div className="flex items-center gap-2">
                <Badge variant="primary" size="sm">L: {d.counters.leftActive}</Badge>
                <Badge variant="violet" size="sm">R: {d.counters.rightActive}</Badge>
              </div>
            </div>

            {/* Qualified counts — FC-2 (distinct from active) */}
            <div className="flex items-center justify-between py-2.5 border-b border-surface-line">
              <span className="text-sm text-ink-muted flex items-center gap-2">
                <Trophy size={14} className="text-warning" />
                <span>{t('counters.qualified')}</span>
                <span className="relative group/tooltip cursor-help inline-flex">
                  <Info size={11} className="text-ink-muted" />
                  <span className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 w-60 -translate-x-1/2 rounded-lg bg-gray-900 px-3 py-2 text-xs leading-relaxed text-white opacity-0 shadow-lg transition-opacity duration-150 group-hover/tooltip:opacity-100">
                    {t('counters.qualifiedTooltip')}
                  </span>
                </span>
              </span>
              <div className="flex items-center gap-2">
                <Badge variant="success" size="sm">L: {d.counters.leftQualified}</Badge>
                <Badge variant="warning" size="sm">R: {d.counters.rightQualified}</Badge>
              </div>
            </div>

            {/* Carry forward */}
            <div className="flex items-center justify-between py-2.5 border-b border-surface-line">
              <span className="text-sm text-ink-muted flex items-center gap-2">
                <ArrowUpRight size={14} className="text-warning" /> Carry Forward
              </span>
              <span className="text-sm font-semibold text-warning">
                {d.carryForward.side}: {d.carryForward.excess} excess
              </span>
            </div>

            {/* Today's bonus */}
            <div className="flex items-center justify-between py-2.5">
              <span className="text-sm text-ink-muted flex items-center gap-2">
                <TrendingUp size={14} className="text-success" /> Today's Pair Bonus
              </span>
              <span className="text-sm font-bold text-success">{formatINR(d.todayPairBonusPaise)}</span>
            </div>
          </div>

          <button onClick={() => navigate('/pairs')} className="avg-btn-primary mt-4">
            <GitMerge size={15} /> View Pair Match Details
          </button>
        </div>
      </div>

      {/* Row 3: Chart + Transactions + Rank + Refer */}
      <div className="grid w-full lg:grid-cols-3 gap-6">
        {/* Income Chart */}
        <div className="avg-card p-5 lg:col-span-2 min-w-0">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-sm font-semibold text-ink">Income Overview</h2>
              <p className="text-xs text-ink-muted">Last 14 days</p>
            </div>
            <Badge variant="primary">{formatINR(d.pairMatchIncomePaise)}</Badge>
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={chartData} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="incomeGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#2447D8" stopOpacity={0.15} />
                  <stop offset="95%" stopColor="#2447D8" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#F3F4F6" vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#9CA3AF' }} axisLine={false} tickLine={false} interval={2} />
              <YAxis tick={{ fontSize: 10, fill: '#9CA3AF' }} axisLine={false} tickLine={false} tickFormatter={(v) => `₹${(v / 1000).toFixed(0)}K`} />
              <Tooltip
                formatter={(v) => [formatINR(Number(v) * 100), 'Pair Income']}
                contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #E5E7EB', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.08)' }}
              />
              <Area type="monotone" dataKey="income" stroke="#2447D8" strokeWidth={2.5} fill="url(#incomeGrad)" dot={false} activeDot={{ r: 4, fill: '#2447D8' }} />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        {/* Right column: Transactions + Rank + Refer */}
        <div className="space-y-4 min-w-0">
          {/* Recent Transactions */}
          <div className="avg-card p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-ink">{t('dashboard.recentTransactions')}</h3>
              <Link to="/wallet" className="text-xs text-primary hover:underline">View all</Link>
            </div>
            <div className="space-y-2.5">
              {d.recentTransactions.slice(0, 5).map((tx, i) => (
                <div key={i} className="flex items-center gap-2.5">
                  <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${txColor(tx.type, tx.direction)}`}>
                    {txIcon(tx.type, tx.direction)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-ink capitalize truncate">{tx.type.replace('_', ' ')}</p>
                    <p className="text-[10px] text-ink-muted">{formatDateTime(tx.at)}</p>
                  </div>
                  <span className={`text-xs font-bold flex-shrink-0 ${tx.direction === 'credit' ? 'text-success' : 'text-danger'}`}>
                    {tx.direction === 'credit' ? '+' : '-'}{formatINR(tx.amountPaise)}
                  </span>
                </div>
              ))}
              {d.recentTransactions.length === 0 && (
                <p className="text-xs text-ink-muted text-center py-3">No transactions yet</p>
              )}
            </div>
          </div>

          {/* Rank card */}
          {d.rank.progress && (
            <div className="avg-card p-4">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-8 h-8 bg-warning-50 rounded-lg flex items-center justify-center">
                  <Trophy size={16} className="text-warning" />
                </div>
                <div>
                  <p className="text-[10px] text-ink-muted">Current Rank</p>
                  <p className="text-sm font-bold text-ink">{d.rank.currentName}</p>
                </div>
              </div>
              {d.rank.next && (
                <div className="space-y-2">
                  <div className="flex justify-between text-xs text-ink-muted">
                    <span>Next: Level {d.rank.next}</span>
                    <span>{Math.min(d.rank.progress.leftQualified, d.rank.progress.rightQualified)}/{d.rank.progress.requiredEachSide}</span>
                  </div>
                  <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-primary to-violet rounded-full transition-all duration-500"
                      style={{ width: `${Math.min(100, (Math.min(d.rank.progress.leftQualified, d.rank.progress.rightQualified) / d.rank.progress.requiredEachSide) * 100)}%` }}
                    />
                  </div>
                  <button onClick={() => navigate('/ranks')} className="text-xs text-primary font-medium hover:underline flex items-center gap-0.5">
                    View rank details <ChevronRight size={11} />
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Refer & Earn */}
          <div className="bg-gradient-to-br from-primary to-violet rounded-xl p-4 text-white relative overflow-hidden">
            <div className="absolute -right-6 -bottom-6 w-24 h-24 bg-white/10 rounded-full" />
            <div className="absolute -right-2 -top-6 w-16 h-16 bg-white/5 rounded-full" />
            <div className="relative z-10">
              <div className="flex items-center gap-2 mb-1">
                <UserPlus size={15} />
                <span className="text-sm font-bold">{t('dashboard.referEarn')}</span>
              </div>
              <p className="text-xs text-white/70 mb-3">Share and earn ₹1,000 per pair</p>
              {sponsorCode
                ? <CopyField value={referralUrl} />
                : <p className="text-xs text-white/50">Loading referral link…</p>
              }
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
