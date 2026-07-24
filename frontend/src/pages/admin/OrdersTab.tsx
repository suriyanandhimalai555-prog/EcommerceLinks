import { useRef, useState } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, Loader2, Pencil, XCircle } from 'lucide-react'
import api from '../../lib/api'
import { formatINR, formatDate } from '../../lib/format'
import { DataTable, type Column } from '../../components/ui/DataTable'
import { Badge } from '../../components/ui/Badge'
import { Modal } from '../../components/ui/Modal'
import { ImageUploader, type ImageUploaderHandle, type UploadedImage } from '../../components/ui/ImageUploader'
import type { AdminOrder, AdminProduct, PresignRes } from '../../types/api'

const PAGE = 50

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

  // Edit modal state
  const [editTarget, setEditTarget] = useState<AdminOrder | null>(null)
  const [editProductId, setEditProductId] = useState<number>(0)
  const [editPaymentRef, setEditPaymentRef] = useState('')
  const [editProofImages, setEditProofImages] = useState<UploadedImage[]>([])
  const [editError, setEditError] = useState('')
  const editUploaderRef = useRef<ImageUploaderHandle>(null)

  const {
    data,
    isPending,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
  } = useInfiniteQuery<AdminOrder[]>({
    queryKey: ['admin', 'orders', filter],
    queryFn: ({ pageParam }) =>
      api.get(`/admin/orders?status=${filter}&limit=${PAGE}&offset=${pageParam}`).then((r) => r.data),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) =>
      lastPage.length === PAGE ? allPages.length * PAGE : undefined,
  })
  const orders = data?.pages.flat() ?? []

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

  // Products list for the edit modal product selector.
  const { data: productsData } = useQuery<AdminProduct[]>({
    queryKey: ['admin-products'],
    queryFn: () => api.get('/admin/products').then((r) => r.data),
    staleTime: 60_000,
  })
  const activeProducts = (productsData ?? []).filter((p) => p.active)

  const editOrder = useMutation({
    mutationFn: async (order: AdminOrder) => {
      // Upload any newly staged images and collect full key set (kept + new).
      const proofKeys = editUploaderRef.current
        ? await editUploaderRef.current.upload()
        : (order.paymentProofKeys ?? [])
      return api
        .patch(`/admin/orders/${order.orderId}`, {
          productId: editProductId !== order.productId ? editProductId : undefined,
          paymentRef: editPaymentRef.trim() !== (order.paymentRef ?? '') ? editPaymentRef.trim() || undefined : undefined,
          proofKeys,
        })
        .then((r) => r.data)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'orders'] })
      qc.invalidateQueries({ queryKey: ['admin-overview'] })
      closeEdit()
    },
    onError: () => {
      setEditError(t('errors.generic'))
    },
  })

  function openEdit(order: AdminOrder, e: React.MouseEvent) {
    e.stopPropagation()
    setEditTarget(order)
    setEditProductId(order.productId)
    setEditPaymentRef(order.paymentRef ?? '')
    // Seed the uploader with existing proofs so kept ones stay and removed ones get diffed.
    const keys = order.paymentProofKeys ?? []
    const urls = order.paymentProofUrls ?? []
    setEditProofImages(keys.map((key, i) => ({ key, previewUrl: urls[i] ?? '' })))
    setEditError('')
  }

  function closeEdit() {
    setEditTarget(null)
    setEditProductId(0)
    setEditPaymentRef('')
    setEditProofImages([])
    setEditError('')
  }

  function getEditPresign(file: File): Promise<PresignRes> {
    return api
      .post(`/admin/orders/${editTarget!.orderId}/proof/presign`, {
        contentType: file.type,
        sizeBytes: file.size,
      })
      .then((r) => r.data)
  }

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
            onClick={(e) => openEdit(r, e)}
            className="py-1.5 px-3 text-xs rounded-lg border border-surface-line text-ink-muted font-semibold flex items-center gap-1.5 hover:bg-white/5 hover:text-ink transition-colors"
          >
            <Pencil size={12} />
            {t('admin.orders.editBtn')}
          </button>
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
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (r) => (
        <button
          onClick={(e) => openEdit(r, e)}
          className="py-1.5 px-3 text-xs rounded-lg border border-surface-line text-ink-muted font-semibold flex items-center gap-1.5 hover:bg-white/5 hover:text-ink transition-colors"
        >
          <Pencil size={12} />
          {t('admin.orders.editBtn')}
        </button>
      ),
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
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (r) => (
        <button
          onClick={(e) => openEdit(r, e)}
          className="py-1.5 px-3 text-xs rounded-lg border border-surface-line text-ink-muted font-semibold flex items-center gap-1.5 hover:bg-white/5 hover:text-ink transition-colors"
        >
          <Pencil size={12} />
          {t('admin.orders.editBtn')}
        </button>
      ),
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
          data={orders}
          loading={isPending}
          rowKey={(r) => r.orderId}
          emptyTitle={emptyTitle}
          emptyDescription={emptyDesc}
          hasMore={hasNextPage}
          onLoadMore={() => fetchNextPage()}
          loadingMore={isFetchingNextPage}
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

      {/* ── Edit modal ────────────────────────────────────────────────────── */}
      <Modal
        open={!!editTarget}
        onClose={closeEdit}
        title={t('admin.orders.editTitle')}
      >
        {editTarget && (
          <div className="space-y-4">
            {/* Member / order summary */}
            <div className="bg-white/5 rounded-xl p-4 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-ink-muted">Member</span>
                <span className="font-semibold text-ink">
                  {editTarget.memberName} ({editTarget.memberCode})
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-ink-muted">Order ID</span>
                <span className="font-mono text-xs text-ink">{editTarget.orderId}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-ink-muted">Status</span>
                <span className="text-ink">{editTarget.status}</span>
              </div>
            </div>

            {/* Product selector */}
            <div>
              <label className="block text-sm font-medium text-ink mb-1.5">
                {t('admin.orders.editProduct')}
              </label>
              <select
                value={editProductId}
                onChange={(e) => setEditProductId(Number(e.target.value))}
                className="w-full rounded-lg border border-surface-line bg-[#10141F] px-3 py-2.5 text-sm text-ink outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
              >
                {activeProducts.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
                {/* Keep the current product option even if it's now inactive */}
                {!activeProducts.find((p) => p.id === editTarget.productId) && (
                  <option value={editTarget.productId}>
                    {editTarget.productName} (inactive)
                  </option>
                )}
              </select>
            </div>

            {/* Payment reference */}
            <div>
              <label className="block text-sm font-medium text-ink mb-1.5">
                {t('admin.orders.editRefLabel')}
              </label>
              <input
                type="text"
                value={editPaymentRef}
                onChange={(e) => setEditPaymentRef(e.target.value)}
                placeholder={t('admin.orders.editRefPlaceholder')}
                className="w-full rounded-lg border border-surface-line bg-[#10141F] px-3 py-2.5 text-sm text-ink outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
              />
            </div>

            {/* Proof images */}
            <ImageUploader
              ref={editUploaderRef}
              label={t('admin.orders.editProofLabel')}
              maxFiles={3}
              value={editProofImages}
              onChange={setEditProofImages}
              getPresign={getEditPresign}
              deferUpload
            />
            <p className="text-xs text-ink-muted -mt-2">{t('admin.orders.editProofHint')}</p>

            {editError && <p className="text-xs text-danger">{editError}</p>}

            <div className="flex gap-2">
              <button
                onClick={closeEdit}
                disabled={editOrder.isPending}
                className="flex-1 py-2.5 rounded-xl border border-surface-line text-ink-muted text-sm font-semibold hover:bg-white/5 transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => editOrder.mutate(editTarget)}
                disabled={editOrder.isPending}
                className="flex-1 avg-btn-primary py-2.5"
              >
                {editOrder.isPending ? <Loader2 size={15} className="animate-spin" /> : <Pencil size={15} />}
                {t('admin.orders.editSave')}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
