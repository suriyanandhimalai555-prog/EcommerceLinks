import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { RotateCcw, Trash2, Loader2 } from 'lucide-react'
import api from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import { DataTable, type Column } from '../../components/ui/DataTable'
import { Badge } from '../../components/ui/Badge'
import { Modal } from '../../components/ui/Modal'
import type { DeadLetter } from '../../types/api'

export function SystemTab() {
  const qc = useQueryClient()
  const [action, setAction] = useState<{ dl: DeadLetter; kind: 'replay' | 'discard' } | null>(null)

  const { data: letters, isPending } = useQuery<DeadLetter[]>({
    queryKey: ['admin-dead-letters'],
    queryFn: () => api.get('/admin/dead-letters').then((r) => r.data),
  })

  const act = useMutation({
    mutationFn: ({ dl, kind }: { dl: DeadLetter; kind: 'replay' | 'discard' }) =>
      kind === 'replay'
        ? api.post(`/admin/dead-letters/${dl.id}/replay`)
        : api.delete(`/admin/dead-letters/${dl.id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-dead-letters'] })
      qc.invalidateQueries({ queryKey: ['admin-overview'] })
      setAction(null)
    },
  })

  const columns: Column<DeadLetter>[] = [
    { key: 'stream', header: 'Stream', render: (r) => <span className="font-mono text-xs text-ink">{r.stream}</span> },
    { key: 'group', header: 'Consumer group', render: (r) => <span className="font-mono text-xs text-ink-muted">{r.consumerGroup}</span> },
    { key: 'deliveries', header: 'Deliveries', render: (r) => <Badge variant="danger" size="sm">{r.deliveryCount}×</Badge> },
    { key: 'at', header: 'Dead-lettered', render: (r) => <span className="text-xs text-ink-muted">{formatDateTime(r.createdAt)}</span> },
    {
      key: 'actions', header: 'Actions', align: 'right',
      render: (r) => (
        <div className="flex gap-2 justify-end">
          <button onClick={() => setAction({ dl: r, kind: 'replay' })} className="avg-btn-secondary py-1.5 px-3 text-xs"><RotateCcw size={12} /> Replay</button>
          <button onClick={() => setAction({ dl: r, kind: 'discard' })} className="avg-btn-danger"><Trash2 size={12} /> Discard</button>
        </div>
      ),
    },
  ]

  return (
    <div className="avg-card">
      <div className="p-5 pb-0">
        <h2 className="text-sm font-semibold text-ink">Dead-letter queue</h2>
        <p className="text-xs text-ink-muted mt-1">Events that failed 5 deliveries. Replay re-sends them to their stream (consumers are idempotent); discard drops them permanently (audit-logged).</p>
      </div>
      <DataTable
        columns={columns}
        data={letters ?? []}
        loading={isPending}
        rowKey={(r) => r.id}
        emptyTitle="Dead-letter queue is empty"
        emptyDescription="All pipeline events are flowing normally"
      />

      <Modal open={!!action} onClose={() => setAction(null)} title={action?.kind === 'replay' ? 'Replay event' : 'Discard event'} size="lg">
        {action && (
          <div className="space-y-4">
            <p className="text-sm text-ink-muted">
              {action.kind === 'replay'
                ? 'Re-deliver this event to its stream? Consumers are idempotent, so duplicates are safe.'
                : 'Permanently discard this event? It will never be processed. This is audit-logged.'}
            </p>
            <pre className="text-xs bg-[#10141F] border border-surface-line rounded-lg p-3 overflow-x-auto text-ink-muted max-h-48">{(() => { try { return JSON.stringify(JSON.parse(action.dl.payload), null, 2) } catch { return action.dl.payload } })()}</pre>
            <button
              onClick={() => act.mutate(action)}
              disabled={act.isPending}
              className={action.kind === 'replay' ? 'avg-btn-primary w-full' : 'w-full flex items-center justify-center gap-2 bg-danger text-white font-semibold rounded-lg px-4 py-2.5 text-sm cursor-pointer hover:bg-danger/90 transition-colors disabled:opacity-50'}
            >
              {act.isPending ? <Loader2 size={15} className="animate-spin" /> : null}
              Confirm {action.kind}
            </button>
          </div>
        )}
      </Modal>
    </div>
  )
}
