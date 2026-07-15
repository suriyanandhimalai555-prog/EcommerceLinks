import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, Loader2 } from 'lucide-react'
import api from '../../lib/api'
import { formatINR, formatDate } from '../../lib/format'
import { DataTable, type Column } from '../../components/ui/DataTable'
import { Badge } from '../../components/ui/Badge'
import { Modal } from '../../components/ui/Modal'
import type { AdminOrder } from '../../types/api'

type Filter = 'created' | 'confirmed'

export function OrdersTab() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [filter, setFilter] = useState<Filter>('created')
  const [selected, setSelected] = useState<AdminOrder | null>(null)
  const [paymentRef, setPaymentRef] = useState('')
  const [refError, setRefError] = useState('')

  const { data: orders, isPending } = useQuery<AdminOrder[]>({
    queryKey: ['admin', 'orders', filter],
    queryFn: () => api.get(`/admin/orders?status=${filter}`).then((r) => r.data),
  })

  const confirm = useMutation({
    mutationFn: (order: AdminOrder) =>
      api.post(`/admin/orders/${order.orderId}/confirm-payment`, { paymentRef }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'orders'] })
      qc.invalidateQueries({ queryKey: ['admin-overview'] })
      setSelected(null)
      setPaymentRef('')
      setRefError('')
    },
  })

  const handleConfirm = () => {
    if (!paymentRef.trim()) {
      setRefError(t('admin.orders.paymentRefRequired'))
      return
    }
    setRefError('')
    if (selected) confirm.mutate(selected)
  }

  // ── Pending columns ───────────────────────────────────────────────────────
  const pendingColumns: Column<AdminOrder>[] = [
    {
      key: 'member',
      header: t('admin.orders.colMember'),
      render: (r) => (
        <div>
          <p className="font-mono text-xs font-semibold text-ink">{r.memberCode}</p>
          <p className="text-xs text-ink-muted mt-0.5">{r.memberName}</p>
        </div>
      ),
    },
    {
      key: 'product',
      header: t('admin.orders.colProduct'),
      render: (r) => <span className="text-sm text-ink">{r.productName}</span>,
    },
    {
      key: 'amount',
      header: t('admin.orders.colAmount'),
      render: (r) => <span className="text-sm font-semibold text-primary">{formatINR(r.totalPaise)}</span>,
    },
    {
      key: 'date',
      header: t('admin.orders.colDate'),
      render: (r) => <span className="text-xs text-ink-muted">{formatDate(r.createdAt)}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      render: () => <Badge variant="warning">Awaiting Payment</Badge>,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (r) => (
        <button
          onClick={(e) => { e.stopPropagation(); setSelected(r); setPaymentRef(''); setRefError('') }}
          className="avg-btn-primary py-1.5 px-3 text-xs"
        >
          <CheckCircle2 size={12} />
          {t('admin.orders.confirmBtn')}
        </button>
      ),
    },
  ]

  // ── Confirmed columns ─────────────────────────────────────────────────────
  const confirmedColumns: Column<AdminOrder>[] = [
    {
      key: 'member',
      header: t('admin.orders.colMember'),
      render: (r) => (
        <div>
          <p className="font-mono text-xs font-semibold text-ink">{r.memberCode}</p>
          <p className="text-xs text-ink-muted mt-0.5">{r.memberName}</p>
        </div>
      ),
    },
    {
      key: 'product',
      header: t('admin.orders.colProduct'),
      render: (r) => <span className="text-sm text-ink">{r.productName}</span>,
    },
    {
      key: 'amount',
      header: t('admin.orders.colAmount'),
      render: (r) => <span className="text-sm font-semibold text-primary">{formatINR(r.totalPaise)}</span>,
    },
    {
      key: 'paymentRef',
      header: t('admin.orders.colPaymentRef'),
      render: (r) => (
        <span className="font-mono text-xs text-ink bg-white/5 px-2 py-0.5 rounded">
          {r.paymentRef ?? '—'}
        </span>
      ),
    },
    {
      key: 'confirmedAt',
      header: t('admin.orders.colConfirmedAt'),
      render: (r) => (
        <span className="text-xs text-ink-muted">
          {r.confirmedAt ? formatDate(r.confirmedAt) : '—'}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: () => <Badge variant="success">Confirmed</Badge>,
    },
  ]

  return (
    <div className="space-y-4">
      <div className="avg-card">
        <div className="p-5 pb-4 flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-sm font-semibold text-ink">{t('admin.orders.title')}</h2>
            <p className="text-xs text-ink-muted mt-0.5">{t('admin.orders.subtitle')}</p>
          </div>
          {/* Filter toggle */}
          <div className="flex gap-1 bg-white/5 p-1 rounded-lg">
            {(['created', 'confirmed'] as Filter[]).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all cursor-pointer whitespace-nowrap ${
                  filter === f
                    ? 'bg-white/10 text-ink shadow-sm'
                    : 'text-ink-muted hover:text-ink'
                }`}
              >
                {f === 'created'
                  ? t('admin.orders.filterPending')
                  : t('admin.orders.filterConfirmed')}
              </button>
            ))}
          </div>
        </div>

        <DataTable
          columns={filter === 'created' ? pendingColumns : confirmedColumns}
          data={orders ?? []}
          loading={isPending}
          rowKey={(r) => r.orderId}
          emptyTitle={
            filter === 'created'
              ? t('admin.orders.emptyTitle')
              : t('admin.orders.confirmedEmptyTitle')
          }
          emptyDescription={
            filter === 'created'
              ? t('admin.orders.emptyDesc')
              : t('admin.orders.confirmedEmptyDesc')
          }
        />
      </div>

      {/* Confirm payment modal — only shown in pending view */}
      <Modal
        open={!!selected}
        onClose={() => { setSelected(null); setPaymentRef(''); setRefError('') }}
        title={t('admin.orders.confirmTitle')}
      >
        {selected && (
          <div className="space-y-4">
            <div className="bg-white/5 rounded-xl p-4 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-ink-muted">Member</span>
                <span className="font-semibold text-ink">{selected.memberName} ({selected.memberCode})</span>
              </div>
              <div className="flex justify-between">
                <span className="text-ink-muted">Product</span>
                <span className="text-ink">{selected.productName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-ink-muted">Amount</span>
                <span className="font-bold text-primary">{formatINR(selected.totalPaise)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-ink-muted">Order ID</span>
                <span className="font-mono text-xs text-ink">{selected.orderId}</span>
              </div>
            </div>

            <p className="text-xs text-ink-muted">{t('admin.orders.confirmHint')}</p>

            <div>
              <label className="block text-sm font-medium text-ink mb-1.5">
                {t('admin.orders.paymentRefLabel')}
              </label>
              <input
                type="text"
                value={paymentRef}
                onChange={(e) => { setPaymentRef(e.target.value); setRefError('') }}
                placeholder={t('admin.orders.paymentRefPlaceholder')}
                className="w-full rounded-lg border border-surface-line bg-[#10141F] px-3 py-2.5 text-sm text-ink outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
              />
              {refError && <p className="text-xs text-danger mt-1">{refError}</p>}
            </div>

            <button
              onClick={handleConfirm}
              disabled={confirm.isPending}
              className="avg-btn-primary w-full py-2.5"
            >
              {confirm.isPending ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />}
              {t('admin.orders.confirmSubmit')}
            </button>
          </div>
        )}
      </Modal>
    </div>
  )
}
