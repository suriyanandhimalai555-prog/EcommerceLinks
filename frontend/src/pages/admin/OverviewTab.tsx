import { useQuery, useMutation } from '@tanstack/react-query'
import { Users, UserCheck, ShieldOff, FileSearch, Trophy, GitMerge, Inbox, AlertTriangle, Zap, Loader2 } from 'lucide-react'
import { useState } from 'react'
import api from '../../lib/api'
import { formatINR, formatDate } from '../../lib/format'
import { StatCard } from '../../components/ui/StatCard'
import { SkeletonCard } from '../../components/ui/Skeleton'
import type { AdminOverview } from '../../types/api'

export function OverviewTab() {
  const [payoutMsg, setPayoutMsg] = useState<string | null>(null)
  const { data: ov, isPending, refetch } = useQuery<AdminOverview>({
    queryKey: ['admin-overview'],
    queryFn: () => api.get('/admin/overview').then((r) => r.data),
  })

  const triggerPayout = useMutation({
    mutationFn: () => api.post('/admin/payouts/trigger'),
    onSuccess: (res) => { setPayoutMsg(`Payout batch triggered — batch ID ${res.data.batchId}`); refetch() },
    onError: (err: unknown) => {
      const e = err as { response?: { data?: { error?: string } } }
      setPayoutMsg(e.response?.data?.error ?? 'Failed to trigger payout')
    },
  })

  if (isPending || !ov) return <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">{[1, 2, 3, 4].map((i) => <SkeletonCard key={i} />)}</div>

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Total Members" value={String(ov.totalMembers)} icon={<Users />} tint="primary" />
        <StatCard label="Active" value={String(ov.activeMembers)} icon={<UserCheck />} tint="success" />
        <StatCard label="Blocked" value={String(ov.blockedMembers)} icon={<ShieldOff />} tint="warning" />
        <StatCard label="Pending KYC" value={String(ov.pendingKyc)} icon={<FileSearch />} tint="violet" />
        <StatCard label="Pending Ranks" value={String(ov.pendingRanks)} icon={<Trophy />} tint="warning" />
        <StatCard label="Pairs Today" value={String(ov.todayPairs)} sub={formatINR(ov.todayBonusPaise)} icon={<GitMerge />} tint="success" />
        <StatCard label="Outbox Backlog" value={String(ov.outboxBacklog)} sub={ov.outboxBacklog > 0 ? 'events awaiting relay' : 'pipeline clear'} icon={<Inbox />} tint="primary" />
        <StatCard label="Dead Letters" value={String(ov.deadLetters)} sub={ov.deadLetters > 0 ? 'needs attention' : 'none'} icon={<AlertTriangle />} tint={ov.deadLetters > 0 ? 'warning' : 'primary'} />
      </div>

      <div className="avg-card p-5 space-y-3">
        <h2 className="text-sm font-semibold text-ink">Cutoff window</h2>
        {ov.openWindow ? (
          <p className="text-sm text-ink-muted">
            Open window: <span className="text-ink font-medium">{formatDate(ov.openWindow.start)}</span> → <span className="text-ink font-medium">{formatDate(ov.openWindow.end)}</span>
          </p>
        ) : (
          <p className="text-sm text-warning">No open cutoff window — the ledger worker cannot credit pairs.</p>
        )}
        <div className="border-t border-surface-line pt-3 space-y-2">
          <p className="text-sm text-ink-muted">Manually trigger today's payout batch (idempotent — safe to run twice).</p>
          {payoutMsg && <p className="text-sm text-success">{payoutMsg}</p>}
          <button
            onClick={() => { setPayoutMsg(null); triggerPayout.mutate() }}
            disabled={triggerPayout.isPending}
            className="avg-btn-primary"
          >
            {triggerPayout.isPending ? <Loader2 size={15} className="animate-spin" /> : <Zap size={15} />}
            Trigger Payout Now
          </button>
        </div>
      </div>
    </div>
  )
}
