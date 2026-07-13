import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Eye } from 'lucide-react'
import api from '../../lib/api'
import { formatINR, formatDate } from '../../lib/format'
import { DataTable, type Column } from '../../components/ui/DataTable'
import { Badge } from '../../components/ui/Badge'
import { Modal } from '../../components/ui/Modal'
import type { AdminPayoutBatch, AdminPayoutItem } from '../../types/api'

const batchBadge: Record<AdminPayoutBatch['status'], 'warning' | 'primary' | 'success'> = {
  building: 'warning',
  sent: 'primary',
  reconciled: 'success',
}
const itemBadge: Record<AdminPayoutItem['status'], 'neutral' | 'primary' | 'success' | 'danger'> = {
  pending: 'neutral',
  sent: 'primary',
  settled: 'success',
  failed: 'danger',
}

export function PayoutsTab() {
  const [openBatch, setOpenBatch] = useState<AdminPayoutBatch | null>(null)

  const { data: batches, isPending } = useQuery<AdminPayoutBatch[]>({
    queryKey: ['admin-payouts'],
    queryFn: () => api.get('/admin/payouts').then((r) => r.data),
  })

  const { data: items, isPending: itemsPending } = useQuery<AdminPayoutItem[]>({
    queryKey: ['admin-payout-items', openBatch?.id],
    queryFn: () => api.get(`/admin/payouts/${openBatch!.id}/items`).then((r) => r.data),
    enabled: !!openBatch,
  })

  const columns: Column<AdminPayoutBatch>[] = [
    { key: 'date', header: 'Scheduled', render: (r) => <span className="text-sm font-medium text-ink whitespace-nowrap">{formatDate(r.scheduledFor)}</span> },
    { key: 'status', header: 'Status', render: (r) => <Badge variant={batchBadge[r.status]}>{r.status}</Badge> },
    { key: 'items', header: 'Items', align: 'center', render: (r) => <span className="text-sm text-ink">{r.items}</span> },
    {
      key: 'split', header: 'Settled / Failed', align: 'center',
      render: (r) => (
        <span className="text-xs">
          <span className="text-success font-semibold">{r.settled}</span>
          <span className="text-ink-muted"> / </span>
          <span className={r.failed > 0 ? 'text-danger font-semibold' : 'text-ink-muted'}>{r.failed}</span>
        </span>
      ),
    },
    { key: 'net', header: 'Net Total', align: 'right', render: (r) => <span className="text-sm font-bold text-ink">{formatINR(r.netTotalPaise)}</span> },
    {
      key: 'view', header: '', align: 'right',
      render: (r) => (
        <button onClick={() => setOpenBatch(r)} className="avg-btn-secondary py-1.5 px-3 text-xs">
          <Eye size={12} /> View items
        </button>
      ),
    },
  ]

  const itemColumns: Column<AdminPayoutItem>[] = [
    { key: 'member', header: 'Member', render: (r) => <span className="font-mono text-xs text-ink">{r.memberCode}</span> },
    { key: 'name', header: 'Name', render: (r) => <span className="text-sm text-ink">{r.name}</span> },
    { key: 'gross', header: 'Gross', align: 'right', render: (r) => <span className="text-xs text-ink">{formatINR(r.grossPaise)}</span> },
    { key: 'tds', header: 'TDS', align: 'right', render: (r) => <span className="text-xs text-ink-muted">{formatINR(r.tdsPaise)}</span> },
    { key: 'net', header: 'Net', align: 'right', render: (r) => <span className="text-xs font-semibold text-ink">{formatINR(r.netPaise)}</span> },
    {
      key: 'status', header: 'Status',
      render: (r) => (
        <div>
          <Badge variant={itemBadge[r.status]} size="sm">{r.status}</Badge>
          {r.failureReason && <p className="text-[10px] text-danger mt-0.5">{r.failureReason}</p>}
        </div>
      ),
    },
  ]

  return (
    <div className="avg-card">
      <div className="p-5 pb-0">
        <h2 className="text-sm font-semibold text-ink">Payout batches</h2>
        <p className="text-xs text-ink-muted mt-1">Trigger new batches from the Overview tab.</p>
      </div>
      <DataTable
        columns={columns}
        data={batches ?? []}
        loading={isPending}
        rowKey={(r) => r.id}
        emptyTitle="No payout batches yet"
        emptyDescription="Batches are created every payout day, or manually from Overview"
      />

      <Modal open={!!openBatch} onClose={() => setOpenBatch(null)} title={openBatch ? `Batch ${formatDate(openBatch.scheduledFor)}` : ''} size="lg">
        <div className="max-h-[60vh] overflow-y-auto -m-2">
          <DataTable
            columns={itemColumns}
            data={items ?? []}
            loading={itemsPending}
            rowKey={(r) => r.id}
            emptyTitle="No items in this batch"
          />
        </div>
      </Modal>
    </div>
  )
}
