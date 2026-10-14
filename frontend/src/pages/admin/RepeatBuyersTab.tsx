import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Download, ListOrdered, Loader2, Search, Trash2 } from 'lucide-react'
import api from '../../lib/api'
import { downloadCsv } from '../../lib/exportCsv'
import { formatINR, formatDate } from '../../lib/format'
import { DataTable, type Column } from '../../components/ui/DataTable'
import { Badge } from '../../components/ui/Badge'
import { Modal } from '../../components/ui/Modal'
import type { AdminMultiBuyerRow, AdminMultiBuyersPage, AdminAllOrderRow, AdminOrdersPage } from '../../types/api'

type ExportScope = 'confirmed' | 'confirmed,paid' | 'all'
type FilterType  = 'all' | 'promotional' | 'duplicates'

const EXPORT_SCOPE_OPTIONS: { value: ExportScope; labelKey: string }[] = [
  { value: 'confirmed',      labelKey: 'repeatExportScopeConfirmed' },
  { value: 'confirmed,paid', labelKey: 'repeatExportScopeConfirmedPaid' },
  { value: 'all',            labelKey: 'repeatExportScopeAll' },
]

const FILTER_OPTIONS: { value: FilterType; labelKey: string }[] = [
  { value: 'all',          labelKey: 'repeatFilterAll' },
  { value: 'promotional',  labelKey: 'repeatFilterPromotional' },
  { value: 'duplicates',   labelKey: 'repeatFilterDuplicates' },
]

const PAGE_SIZE = 20

// ─── Drill-in modal ───────────────────────────────────────────────────────────

interface OrdersModalProps {
  buyer: AdminMultiBuyerRow | null
  onClose: () => void
}

function isGenuinePhysical(o: AdminAllOrderRow) {
  return o.upgradeToValuePaise == null && o.sourceUpgradeOrderId == null
}

function OrdersModal({ buyer, onClose }: OrdersModalProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  // Confirm-delete state
  const [confirmOrder, setConfirmOrder] = useState<AdminAllOrderRow | null>(null)

  // Fetch all orders for the member — no status param (that endpoint maps
  // status=confirmed to confirmed+undelivered, hiding delivered duplicates).
  // Filter client-side to confirmed + exact memberCode match.
  const queryKey = ['repeat-buyer-orders', buyer?.memberCode ?? '']
  const { data: ordersPage, isPending } = useQuery<AdminOrdersPage>({
    queryKey,
    queryFn: () =>
      api
        .get(`/admin/orders/all?q=${encodeURIComponent(buyer?.memberCode ?? '')}&limit=100`)
        .then((r) => r.data),
    enabled: buyer != null,
    placeholderData: keepPreviousData,
  })

  // Confirmed orders for this exact member, sorted oldest first (activating order is first).
  const confirmedOrders = (ordersPage?.items ?? [])
    .filter((o) => o.memberCode === buyer?.memberCode && o.status === 'confirmed')
    .sort((a, b) =>
      (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()) ||
      (Number(a.orderId) - Number(b.orderId))
    )

  const earliestId = confirmedOrders[0]?.orderId

  const deleteMutation = useMutation({
    mutationFn: (orderId: string) => api.delete(`/admin/orders/${orderId}`),
    onSuccess: () => {
      setConfirmOrder(null)
      // Refresh the orders list and the outer repeat-buyers list.
      void queryClient.invalidateQueries({ queryKey })
      void queryClient.invalidateQueries({ queryKey: ['admin-orders-multi-buyers'] })
    },
  })

  const isDeleting = deleteMutation.isPending

  if (!buyer) return null

  return (
    <>
      <Modal
        open={buyer != null}
        onClose={onClose}
        title={t('admin.orders.repeatOrdersModalTitle', { memberCode: buyer.memberCode })}
        size="lg"
      >
        {isPending ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={20} className="animate-spin text-ink-muted" />
          </div>
        ) : confirmedOrders.length === 0 ? (
          <p className="text-xs text-ink-muted py-4 text-center">
            {t('admin.orders.repeatEmptyTitle')}
          </p>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-ink-muted mb-3">
              {buyer.memberName} · {buyer.memberPhone}
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-surface-line text-ink-muted">
                    <th className="text-left pb-2 pr-3 font-medium">{t('admin.orders.repeatOrdersModalColOrder')}</th>
                    <th className="text-left pb-2 pr-3 font-medium">{t('admin.orders.repeatOrdersModalColProduct')}</th>
                    <th className="text-right pb-2 pr-3 font-medium">{t('admin.orders.repeatOrdersModalColAmount')}</th>
                    <th className="text-left pb-2 pr-3 font-medium">{t('admin.orders.repeatOrdersModalColDate')}</th>
                    <th className="text-left pb-2 pr-3 font-medium">{t('admin.orders.repeatOrdersModalColType')}</th>
                    <th className="text-left pb-2 pr-3 font-medium">{t('admin.orders.repeatOrdersModalColDelivered')}</th>
                    <th className="pb-2" />
                  </tr>
                </thead>
                <tbody>
                  {confirmedOrders.map((o, idx) => {
                    const genuine   = isGenuinePhysical(o)
                    const isFirst   = o.orderId === earliestId
                    // Only genuine, non-first orders can be deleted.
                    const canDelete = genuine && !isFirst
                    return (
                      <tr key={o.orderId} className="border-b border-surface-line/50 last:border-0">
                        <td className="py-2 pr-3 font-mono text-ink">
                          #{o.orderId}
                          {isFirst && idx === 0 && (
                            <span className="ml-1 text-[10px] text-success font-semibold">(1st)</span>
                          )}
                        </td>
                        <td className="py-2 pr-3 text-ink-muted max-w-[140px] truncate">{o.productName}</td>
                        <td className="py-2 pr-3 text-right text-ink font-semibold">{formatINR(o.totalPaise)}</td>
                        <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{formatDate(o.createdAt)}</td>
                        <td className="py-2 pr-3">
                          {genuine ? (
                            <Badge variant="primary" size="sm">{t('admin.orders.repeatOrdersModalTypeGenuine')}</Badge>
                          ) : (
                            <Badge variant="violet" size="sm">{t('admin.orders.repeatOrdersModalTypePromo')}</Badge>
                          )}
                        </td>
                        <td className="py-2 pr-3 text-ink-muted">
                          {o.deliveredAt
                            ? t('admin.orders.repeatOrdersModalYes')
                            : t('admin.orders.repeatOrdersModalNo')}
                        </td>
                        <td className="py-2">
                          {canDelete && (
                            <button
                              onClick={() => setConfirmOrder(o)}
                              className="flex items-center gap-1 text-danger hover:text-danger/80 transition-colors cursor-pointer"
                              aria-label={`Delete order #${o.orderId}`}
                            >
                              <Trash2 size={13} />
                              <span className="text-[11px]">{t('admin.orders.repeatDeleteBtn')}</span>
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* If no order in the list has a Delete button, explain why. */}
            {confirmedOrders.every((o) => !isGenuinePhysical(o) || o.orderId === earliestId) && (
              <p className="text-xs text-ink-muted bg-white/5 rounded-lg px-3 py-2 mt-3">
                {t('admin.orders.repeatNoDeletable')}
              </p>
            )}

            {deleteMutation.isError && (
              <p className="text-xs text-danger mt-2">
                {t('admin.orders.repeatDeleteError', {
                  message: (deleteMutation.error as { response?: { data?: { error?: string } } })
                    ?.response?.data?.error ?? 'Unknown error',
                })}
              </p>
            )}
          </div>
        )}
      </Modal>

      {/* Confirm-delete dialog */}
      {confirmOrder && (
        <Modal
          open={confirmOrder != null}
          onClose={() => !isDeleting && setConfirmOrder(null)}
          title={t('admin.orders.repeatDeleteConfirmTitle')}
          size="sm"
        >
          <div className="space-y-4">
            <p className="text-sm text-ink">
              {t('admin.orders.repeatDeleteConfirmBody', {
                orderId: confirmOrder.orderId,
                amount: formatINR(confirmOrder.totalPaise),
              })}
            </p>
            {confirmOrder.deliveredAt && (
              <p className="text-xs text-warning bg-warning/10 rounded-lg px-3 py-2">
                {t('admin.orders.repeatDeleteDeliveredWarning')}
              </p>
            )}
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setConfirmOrder(null)}
                disabled={isDeleting}
                className="avg-btn-secondary text-xs py-2 px-4 disabled:opacity-40"
              >
                {t('admin.orders.repeatDeleteCancelBtn')}
              </button>
              <button
                onClick={() => deleteMutation.mutate(confirmOrder.orderId)}
                disabled={isDeleting}
                className="flex items-center gap-1.5 bg-danger text-white text-xs font-semibold py-2 px-4 rounded-lg hover:bg-danger/80 transition-colors disabled:opacity-40 cursor-pointer"
              >
                {isDeleting && <Loader2 size={12} className="animate-spin" />}
                {t('admin.orders.repeatDeleteConfirmBtn')}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}

// ─── Main tab ─────────────────────────────────────────────────────────────────

export function RepeatBuyersTab() {
  const { t } = useTranslation()

  const [input, setInput] = useState('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const [exporting, setExporting] = useState(false)
  const [filter, setFilter] = useState<FilterType>('all')
  const [exportScope, setExportScope] = useState<ExportScope>('confirmed')
  const [drillBuyer, setDrillBuyer] = useState<AdminMultiBuyerRow | null>(null)

  useEffect(() => {
    const id = setTimeout(() => { setQ(input); setPage(1) }, 350)
    return () => clearTimeout(id)
  }, [input])

  // Reset page when filter changes.
  useEffect(() => { setPage(1) }, [filter])

  const { data: buyersPage, isPending } = useQuery<AdminMultiBuyersPage>({
    queryKey: ['admin-orders-multi-buyers', q, page, filter],
    queryFn: () =>
      api
        .get(`/admin/orders/multi-buyers?q=${encodeURIComponent(q)}&page=${page}&limit=${PAGE_SIZE}&filter=${filter}`)
        .then((r) => r.data),
    placeholderData: keepPreviousData,
  })
  const buyers = buyersPage?.items ?? []
  const total = buyersPage?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  // Export: fetch ALL orders for the chosen status(es) via /admin/orders/all,
  // then deduplicate by memberCode keeping only the first occurrence.
  // Note: this export covers EVERYONE (all buyers, not just repeat buyers) — one
  // row per person, independent of the filter/search above.
  const exportCSV = async () => {
    setExporting(true)
    try {
      const statuses: (string | undefined)[] =
        exportScope === 'all'
          ? [undefined]
          : exportScope === 'confirmed,paid'
          ? ['confirmed', 'paid']
          : ['confirmed']

      const all: AdminAllOrderRow[] = []
      for (const status of statuses) {
        const statusParam = status ? `&status=${status}` : ''
        for (let pg = 1; ; pg++) {
          const res: AdminOrdersPage = await api
            .get(`/admin/orders/all?page=${pg}&limit=100${statusParam}`)
            .then((r) => r.data)
          all.push(...res.items)
          if (res.items.length === 0 || all.length >= res.total) break
        }
      }

      const seen = new Set<string>()
      const deduped = all.filter((r) => {
        if (seen.has(r.memberCode)) return false
        seen.add(r.memberCode)
        return true
      })

      const headers = [
        t('admin.orders.allColOrderId'),
        t('admin.orders.colMember'),
        t('admin.orders.allColPhone'),
        t('admin.orders.colProduct'),
        `${t('admin.orders.colAmount')} (₹)`,
        t('admin.orders.allColStatus'),
        t('admin.orders.allColPaymentRef'),
        t('admin.orders.colDate'),
        t('admin.orders.colConfirmedAt'),
      ]
      const rows = deduped.map((r) => [
        r.orderId,
        `${r.memberCode} – ${r.memberName}`,
        r.memberPhone,
        r.productName,
        (r.totalPaise / 100).toFixed(2),
        r.status,
        r.paymentRef ?? '',
        formatDate(r.createdAt),
        r.confirmedAt ? formatDate(r.confirmedAt) : '',
      ])
      downloadCsv(
        `orders-one-per-person-${new Date().toISOString().slice(0, 10)}.csv`,
        headers,
        rows,
      )
    } finally {
      setExporting(false)
    }
  }

  const columns: Column<AdminMultiBuyerRow>[] = [
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
      key: 'phone',
      header: t('admin.orders.allColPhone'),
      render: (r) => <span className="text-sm text-ink-muted">{r.memberPhone}</span>,
    },
    {
      key: 'type',
      header: t('admin.orders.repeatColType'),
      render: (r) =>
        r.isPromotional ? (
          <Badge variant="violet" size="sm">{t('admin.orders.repeatBadgePromotional')}</Badge>
        ) : (
          <Badge variant="warning" size="sm">{t('admin.orders.repeatBadgeDuplicate')}</Badge>
        ),
    },
    {
      key: 'count',
      header: t('admin.orders.repeatColCount'),
      render: (r) => (
        <div className="text-sm">
          <span className="font-semibold text-primary">{r.confirmedCount}</span>
          {r.genuineCount !== r.confirmedCount && (
            <span className="text-ink-muted ml-1">
              ({r.genuineCount} {t('admin.orders.repeatColGenuineCount').toLowerCase()})
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'total',
      header: t('admin.orders.repeatColTotal'),
      render: (r) => (
        <span className="text-sm font-semibold text-ink">{formatINR(r.totalConfirmedPaise)}</span>
      ),
    },
    {
      key: 'lastOrder',
      header: t('admin.orders.repeatColLastOrder'),
      render: (r) => (
        <span className="text-xs text-ink-muted">{formatDate(r.lastOrderAt)}</span>
      ),
    },
    {
      key: 'actions',
      header: t('admin.orders.repeatColActions'),
      render: (r) => (
        <button
          onClick={(e) => { e.stopPropagation(); setDrillBuyer(r) }}
          className="flex items-center gap-1.5 text-primary hover:text-primary/80 transition-colors cursor-pointer text-xs font-medium"
        >
          <ListOrdered size={13} />
          {t('admin.orders.repeatManageBtn')}
        </button>
      ),
    },
  ]

  return (
    <>
      <div className="space-y-4">
        <div className="avg-card">
          <div className="p-5 pb-3">
            {/* Header row */}
            <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
              <div>
                <h2 className="text-sm font-semibold text-ink">{t('admin.orders.repeatTitle')}</h2>
                <p className="text-xs text-ink-muted mt-0.5">{t('admin.orders.repeatSubtitle')}</p>
                <p className="text-[11px] text-ink-muted/70 mt-1">{t('admin.orders.repeatManageHint')}</p>
              </div>

              {/* Export control */}
              <div className="flex items-center gap-2 flex-wrap">
                <div className="flex flex-col gap-0.5">
                  <label className="text-[10px] text-ink-muted">{t('admin.orders.repeatExportScopeLabel')}</label>
                  <select
                    value={exportScope}
                    onChange={(e) => setExportScope(e.target.value as ExportScope)}
                    className="rounded-lg border border-surface-line bg-[#10141F] px-2 py-1.5 text-xs text-ink outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
                  >
                    {EXPORT_SCOPE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {t(`admin.orders.${o.labelKey}`)}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  onClick={exportCSV}
                  disabled={exporting}
                  className="avg-btn-secondary flex items-center gap-1.5 text-xs py-2 disabled:opacity-40 self-end"
                >
                  {exporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                  {exporting
                    ? t('admin.membersExport.exporting')
                    : t('admin.orders.repeatExportBtn')}
                </button>
              </div>
            </div>

            {/* Filter + Search row */}
            <div className="flex items-center gap-3 flex-wrap">
              {/* Filter selector */}
              <div className="flex flex-col gap-0.5">
                <label className="text-[10px] text-ink-muted">{t('admin.orders.repeatFilterLabel')}</label>
                <select
                  value={filter}
                  onChange={(e) => setFilter(e.target.value as FilterType)}
                  className="rounded-lg border border-surface-line bg-[#10141F] px-2 py-1.5 text-xs text-ink outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
                >
                  {FILTER_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {t(`admin.orders.${o.labelKey}`)}
                    </option>
                  ))}
                </select>
              </div>

              {/* Search — filters only the on-screen list, NOT the export */}
              <div className="flex flex-col gap-0.5">
                <label className="text-[10px] text-ink-muted opacity-0 select-none">s</label>
                <div className="relative">
                  <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted" />
                  <input
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder={t('admin.orders.repeatSearchPlaceholder')}
                    className="w-64 rounded-lg border border-surface-line bg-[#10141F] pl-9 pr-3 py-1.5 text-sm text-ink placeholder:text-ink-muted/60 outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
                  />
                </div>
              </div>
            </div>
          </div>

          <DataTable
            columns={columns}
            data={buyers}
            loading={isPending}
            rowKey={(r) => r.memberCode}
            onRowClick={(r) => setDrillBuyer(r)}
            emptyTitle={t('admin.orders.repeatEmptyTitle')}
            emptyDescription={t('admin.orders.repeatEmptyDesc')}
          />

          {total > 0 && (
            <div className="px-5 py-3 border-t border-surface-line flex items-center justify-between gap-4 flex-wrap">
              <span className="text-xs text-ink-muted">
                {t('admin.bank.showingRange', {
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
                  {t('admin.bank.prev')}
                </button>
                <span className="px-3 text-xs font-medium text-ink">{page} / {totalPages}</span>
                <button
                  onClick={() => setPage((p) => p + 1)}
                  disabled={page >= totalPages}
                  className="avg-btn-secondary py-1.5 px-3 text-xs disabled:opacity-40"
                >
                  {t('admin.bank.next')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Drill-in orders modal */}
      <OrdersModal buyer={drillBuyer} onClose={() => setDrillBuyer(null)} />
    </>
  )
}
