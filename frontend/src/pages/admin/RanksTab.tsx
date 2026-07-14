import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Check, X, Loader2 } from 'lucide-react'
import api from '../../lib/api'
import { formatDate } from '../../lib/format'
import { DataTable, type Column } from '../../components/ui/DataTable'
import { Badge } from '../../components/ui/Badge'
import { Modal } from '../../components/ui/Modal'
import type { PendingRank } from '../../types/api'

export function RanksTab() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [action, setAction] = useState<{ rank: PendingRank; kind: 'approve' | 'reject' } | null>(null)
  const [notes, setNotes] = useState('')

  const { data: pending, isPending } = useQuery<PendingRank[]>({
    queryKey: ['admin-ranks', 'pending'],
    queryFn: () => api.get('/admin/ranks?status=pending').then((r) => r.data.ranks),
  })

  const decide = useMutation({
    mutationFn: ({ rank, kind }: { rank: PendingRank; kind: 'approve' | 'reject' }) =>
      api.post(`/admin/ranks/${rank.id}/${kind}`, { notes: notes || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-ranks'] })
      qc.invalidateQueries({ queryKey: ['admin-overview'] })
      setAction(null)
      setNotes('')
    },
  })

  const columns: Column<PendingRank>[] = [
    { key: 'code', header: 'Member', render: (r) => <span className="font-mono text-xs font-semibold text-ink">{r.member_code}</span> },
    { key: 'name', header: 'Name', render: (r) => <span className="font-medium text-ink">{r.name}</span> },
    { key: 'level', header: 'Rank', render: (r) => <Badge variant="warning">{t(`ranks.l${r.rank_level}`)}</Badge> },
    { key: 'achieved', header: 'Achieved', render: (r) => <span className="text-xs text-ink-muted">{formatDate(r.achieved_at)}</span> },
    {
      key: 'actions', header: 'Decision', align: 'right',
      render: (r) => (
        <div className="flex gap-2 justify-end">
          <button onClick={(e) => { e.stopPropagation(); setAction({ rank: r, kind: 'approve' }) }} className="avg-btn-secondary py-1.5 px-3 text-xs"><Check size={12} /> Approve</button>
          <button onClick={(e) => { e.stopPropagation(); setAction({ rank: r, kind: 'reject' }) }} className="avg-btn-danger"><X size={12} /> Reject</button>
        </div>
      ),
    },
  ]

  return (
    <div className="avg-card">
      <div className="p-5 pb-0"><h2 className="text-sm font-semibold text-ink">Pending rank verifications</h2></div>
      <DataTable
        columns={columns}
        data={pending ?? []}
        loading={isPending}
        rowKey={(r) => r.id}
        emptyTitle="No pending ranks"
        emptyDescription="All rank achievements are verified"
      />

      <Modal open={!!action} onClose={() => setAction(null)} title={action?.kind === 'approve' ? 'Approve rank' : 'Reject rank'}>
        {action && (
          <div className="space-y-4">
            <p className="text-sm text-ink-muted">
              {action.kind === 'approve' ? 'Approve' : 'Reject'}{' '}
              <span className="text-ink font-semibold">{t(`ranks.l${action.rank.rank_level}`)}</span> for{' '}
              <span className="text-ink font-semibold">{action.rank.name}</span> ({action.rank.member_code})?
            </p>
            <div>
              <label className="block text-sm font-medium text-ink mb-1.5">Notes (optional)</label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                className="w-full rounded-lg border border-surface-line bg-[#10141F] px-3 py-2.5 text-sm text-ink outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
              />
            </div>
            <button
              onClick={() => decide.mutate(action)}
              disabled={decide.isPending}
              className={action.kind === 'approve' ? 'avg-btn-primary w-full' : 'w-full flex items-center justify-center gap-2 bg-danger text-white font-semibold rounded-lg px-4 py-2.5 text-sm cursor-pointer hover:bg-danger/90 transition-colors disabled:opacity-50'}
            >
              {decide.isPending ? <Loader2 size={15} className="animate-spin" /> : null}
              Confirm {action.kind}
            </button>
          </div>
        )}
      </Modal>
    </div>
  )
}
