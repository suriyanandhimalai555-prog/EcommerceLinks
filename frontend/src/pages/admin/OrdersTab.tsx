import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, Loader2, XCircle } from 'lucide-react'
import api from '../../lib/api'
import { formatINR, formatDate } from '../../lib/format'
import { DataTable, type Column } from '../../components/ui/DataTable'
import { Badge } from '../../components/ui/Badge'
import { Modal } from '../../components/ui/Modal'
import type { AdminOrder } from '../../types/api'

type Filter = 'paid' | 'created' | 'confirmed'

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'paid',      label: 'filterPaid' },
  { value: 'created',   label: 'filterPending' },
  { value: 'confirmed', label: 'filterConfirmed' },
]

export function OrdersTab() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [filter, setFilter] = useState<Filter>('paid')

  // Approve modal state
  const [selected, setSelected] = useState<AdminOrder | null>(null)
  const [paymentRef, setPaymentRef] = useState('')
  const [refError, setRefError] = useState('')

  // Reject modal state (separate from approve)
  const [rejectTarget, setRejectTarget] = useState<AdminOrder | null>(null)
  const [rejectReason, setRejectReason] = useState('')

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

  const reject = useMutation({
    mutationFn: (order: AdminOrder) =>
      api.post(`/admin/orders/${order.orderId}/reject-payment`, {
        reason: rejectReason.trim() || undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'orders'] })
      setRejectTarget(null)
      setRejectReason('')
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

  const openApprove = (r: AdminOrder, e: React.MouseEvent) => {
    e.stopPropagation()
    setSelected(r)
    setPaymentRef('')
    setRefError('')
  }

  const openReject = (r: AdminOrder, e: React.MouseEvent) => {
    e.stopPropagation()
    setRejectTarget(r)
    setRejectReason('')
  }

  // ── Paid (review) columns ────────────────────────────────────────────────
  const paidColumns: Column<AdminOrder>[] = [
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
      key: 'proof',
      header: t('admin.orders.colProof'),
      render: (r) =>
        r.paymentProofUrls && r.paymentProofUrls.length > 0 ? (
          <div className="flex gap-1.5 flex-wrap">
            {r.paymentProofUrls.map((url, i) => (
              <a key={i} href={url} target="_blank" rel="noreferrer" className="block group shrink-0">
                <img
                  src={url}
                  alt={`proof ${i + 1}`}
                  className="w-12 h-12 rounded-lg object-cover border border-surface-line group-hover:border-primary transition-colors"
                />
              </a>
            ))}
          </div>
        ) : (
          <span className="text-xs text-ink-muted">—</span>
        ),
    },
    {
      key: 'date',
      header: t('admin.orders.colDate'),
      render: (r) => <span className="text-xs text-ink-muted">{formatDate(r.createdAt)}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      render: () => <Badge variant="warning">Proof Uploaded</Badge>,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (r) => (
        <div className="flex items-center gap-2 justify-end">
          <button
            onClick={(e) => openReject(r, e)}
            className="py-1.5 px-3 text-xs rounded-lg border border-danger text-danger font-semibold flex items-center gap-1.5 hover:bg-danger/10 transition-colors"
          >
            <XCircle size={12} />
            {t('admin.orders.rejectBtn')}
          </button>
          <button
            onClick={(e) => openApprove(r, e)}
            className="avg-btn-primary py-1.5 px-3 text-xs"
          >
            <CheckCircle2 size={12} />
            {t('admin.orders.confirmBtn')}
          </button>
        </div>
      ),
    },
  ]

  // ── Awaiting payment (created) columns — view only ────────────────────────
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
      render: () => <Badge variant="neutral">Awaiting Payment</Badge>,
    },
  ]

  // ── Confirmed (history) columns ───────────────────────────────────────────
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
      render: (r) => <span className="text-xs text-ink-muted">{r.confirmedAt ? formatDate(r.confirmedAt) : '—'}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      render: () => <Badge variant="success">Confirmed</Badge>,
    },
  ]

  const activeColumns =
    filter === 'paid' ? paidColumns : filter === 'created' ? pendingColumns : confirmedColumns

  const emptyTitle =
    filter === 'paid'
      ? t('admin.orders.paidEmptyTitle')
      : filter === 'created'
      ? t('admin.orders.emptyTitle')
      : t('admin.orders.confirmedEmptyTitle')

  const emptyDesc =
    filter === 'paid'
      ? t('admin.orders.paidEmptyDesc')
      : filter === 'created'
      ? t('admin.orders.emptyDesc')
      : t('admin.orders.confirmedEmptyDesc')

  return (
    <div className="space-y-4">
      <div className="avg-card">
        <div className="p-5 pb-4 flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-sm font-semibold text-ink">{t('admin.orders.title')}</h2>
            <p className="text-xs text-ink-muted mt-0.5">{t('admin.orders.subtitle')}</p>
          </div>
          <div className="flex gap-1 bg-white/5 p-1 rounded-lg">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                onClick={() => setFilter(f.value)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all cursor-pointer whitespace-nowrap ${
                  filter === f.value
                    ? 'bg-white/10 text-ink shadow-sm'
                    : 'text-ink-muted hover:text-ink'
                }`}
              >
                {t(`admin.orders.${f.label}`)}
              </button>
            ))}
          </div>
        </div>

        <DataTable
          columns={activeColumns}
          data={orders ?? []}
          loading={isPending}
          rowKey={(r) => r.orderId}
          emptyTitle={emptyTitle}
          emptyDescription={emptyDesc}
        />
      </div>

      {/* ── Approve modal ─────────────────────────────────────────────────── */}
      <Modal
        open={!!selected}
        onClose={() => { setSelected(null); setPaymentRef(''); setRefError('') }}
        title={t('admin.orders.confirmTitle')}
      >
        {selected && (
          <div className="space-y-4">
            {selected.paymentProofUrls && selected.paymentProofUrls.length > 0 && (
              <div className={`grid gap-2 ${selected.paymentProofUrls.length === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}>
                {selected.paymentProofUrls.map((url, i) => (
                  <a key={i} href={url} target="_blank" rel="noreferrer" className="block group">
                    <img
                      src={url}
                      alt={`Payment proof ${i + 1}`}
                      className="w-full rounded-xl object-cover max-h-56 border border-surface-line group-hover:border-primary transition-colors"
                    />
                  </a>
                ))}
              </div>
            )}

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
              {confirm.isError && (
                <p className="text-xs text-danger mt-1">{t('errors.generic')}</p>
              )}
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

      {/* ── Reject modal ──────────────────────────────────────────────────── */}
      <Modal
        open={!!rejectTarget}
        onClose={() => { setRejectTarget(null); setRejectReason('') }}
        title={t('admin.orders.rejectTitle')}
        size="sm"
      >
        {rejectTarget && (
          <div className="space-y-4">
            <div className="bg-white/5 rounded-xl p-4 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-ink-muted">Member</span>
                <span className="font-semibold text-ink">{rejectTarget.memberName} ({rejectTarget.memberCode})</span>
              </div>
              <div className="flex justify-between">
                <span className="text-ink-muted">Amount</span>
                <span className="font-bold text-primary">{formatINR(rejectTarget.totalPaise)}</span>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-ink mb-1.5">
                {t('admin.orders.rejectReasonLabel')}
              </label>
              <textarea
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder={t('admin.orders.rejectReasonPlaceholder')}
                rows={3}
                className="w-full rounded-lg border border-surface-line bg-[#10141F] px-3 py-2 text-sm text-ink outline-none focus:ring-2 focus:ring-danger/30 focus:border-danger resize-none"
              />
              <p className="text-xs text-ink-muted mt-1">{t('admin.orders.rejectReasonHint')}</p>
            </div>

            {reject.isError && (
              <p className="text-xs text-danger">{t('errors.generic')}</p>
            )}

            <div className="flex gap-2">
              <button
                onClick={() => { setRejectTarget(null); setRejectReason('') }}
                disabled={reject.isPending}
                className="flex-1 py-2.5 rounded-xl border border-surface-line text-ink-muted text-sm font-semibold hover:bg-white/5 transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => reject.mutate(rejectTarget)}
                disabled={reject.isPending}
                className="flex-1 py-2.5 rounded-xl bg-danger text-white text-sm font-semibold flex items-center justify-center gap-2 hover:bg-danger/90 transition-colors disabled:opacity-50"
              >
                {reject.isPending ? <Loader2 size={15} className="animate-spin" /> : <XCircle size={15} />}
                {t('admin.orders.rejectConfirm')}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
