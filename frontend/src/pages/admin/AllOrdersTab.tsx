import { useEffect, useState } from 'react'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Download, Loader2, Search } from 'lucide-react'
import api from '../../lib/api'
import { downloadCsv } from '../../lib/exportCsv'
import { formatINR, formatDate } from '../../lib/format'
import { DataTable, type Column } from '../../components/ui/DataTable'
import { Badge } from '../../components/ui/Badge'
import type { AdminAllOrderRow, AdminOrdersPage, AdminProduct } from '../../types/api'

type StatusFilter = 'all' | 'created' | 'paid' | 'confirmed' | 'rejected' | 'failed' | 'refunded'

const PAGE_SIZE = 20

const STATUS_PILLS: { key: StatusFilter; labelKey: string }[] = [
  { key: 'all',       labelKey: 'statusAll' },
  { key: 'created',   labelKey: 'statusCreated' },
  { key: 'paid',      labelKey: 'statusPaid' },
  { key: 'confirmed', labelKey: 'statusConfirmed' },
  { key: 'rejected',  labelKey: 'statusRejected' },
  { key: 'failed',    labelKey: 'statusFailed' },
  { key: 'refunded',  labelKey: 'statusRefunded' },
]

function statusBadge(status: string, t: (k: string) => string) {
  switch (status) {
    case 'confirmed': return <Badge variant="success">{t('admin.orders.statusConfirmed')}</Badge>
    case 'paid':      return <Badge variant="warning">{t('admin.orders.statusPaid')}</Badge>
    case 'created':   return <Badge variant="neutral">{t('admin.orders.statusCreated')}</Badge>
    case 'rejected':  return <Badge variant="danger">{t('admin.orders.statusRejected')}</Badge>
    case 'failed':    return <Badge variant="danger">{t('admin.orders.statusFailed')}</Badge>
    case 'refunded':  return <Badge variant="neutral">{t('admin.orders.statusRefunded')}</Badge>
    default:          return <Badge variant="neutral">{status}</Badge>
  }
}

export function AllOrdersTab() {
  const { t } = useTranslation()

  // Search is debounced; other filters apply immediately.
  const [input, setInput] = useState('')
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [productId, setProductId] = useState<number | ''>('')
  const [page, setPage] = useState(1)
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    const id = setTimeout(() => { setQ(input); setPage(1) }, 350)
    return () => clearTimeout(id)
  }, [input])

  // Build URLSearchParams for the current filter state with optional overrides.
  const buildSearch = (overrides?: { pg?: number; limit?: number }) => {
    const p = new URLSearchParams()
    p.set('page', String(overrides?.pg ?? page))
    p.set('limit', String(overrides?.limit ?? PAGE_SIZE))
    if (q) p.set('q', q)
    if (status !== 'all') p.set('status', status)
    if (from) p.set('from', from)
    if (to) p.set('to', to)
    if (productId !== '') p.set('productId', String(productId))
    return p.toString()
  }

  const { data: ordersPage, isPending } = useQuery<AdminOrdersPage>({
    queryKey: ['admin-orders-all', q, status, from, to, productId, page],
    queryFn: () =>
      api.get(`/admin/orders/all?${buildSearch()}`).then((r) => r.data),
    placeholderData: keepPreviousData,
  })
  const orders = ordersPage?.items ?? []
  const total = ordersPage?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const { data: productsData } = useQuery<AdminProduct[]>({
    queryKey: ['admin-products'],
    queryFn: () => api.get('/admin/products').then((r) => r.data),
    staleTime: 60_000,
  })

  const exportCSV = async () => {
    setExporting(true)
    try {
      const all: AdminAllOrderRow[] = []
      for (let pg = 1; ; pg++) {
        const res: AdminOrdersPage = await api
          .get(`/admin/orders/all?${buildSearch({ pg, limit: 100 })}`)
          .then((r) => r.data)
        all.push(...res.items)
        if (res.items.length === 0 || all.length >= res.total) break
      }
      const headers = [
        t('admin.orders.allColOrderId'),
        t('admin.orders.colMember'),
        t('admin.orders.allColPhone'),
        t('admin.orders.colProduct'),
        `${t('admin.orders.colAmount')} (₹)`,
        t('admin.orders.allColStatus'),
        t('admin.orders.allColPaymentRef'),
        t('admin.orders.allColRejection'),
        t('admin.orders.colDate'),
        t('admin.orders.colConfirmedAt'),
      ]
      const rows = all.map((r) => [
        r.orderId,
        `${r.memberCode} – ${r.memberName}`,
        r.memberPhone,
        r.productName,
        (r.totalPaise / 100).toFixed(2),
        r.status,
        r.paymentRef ?? '',
        r.rejectionReason ?? '',
        formatDate(r.createdAt),
        r.confirmedAt ? formatDate(r.confirmedAt) : '',
      ])
      downloadCsv(`orders-${new Date().toISOString().slice(0, 10)}.csv`, headers, rows)
    } finally {
      setExporting(false)
    }
  }

  const columns: Column<AdminAllOrderRow>[] = [
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
      render: (r) => (
        <span className="text-sm font-semibold text-primary">{formatINR(r.totalPaise)}</span>
      ),
    },
    {
      key: 'status',
      header: t('admin.orders.allColStatus'),
      render: (r) => statusBadge(r.status, t),
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
      key: 'date',
      header: t('admin.orders.colDate'),
      render: (r) => <span className="text-xs text-ink-muted">{formatDate(r.createdAt)}</span>,
    },
  ]

  return (
    <div className="avg-card">
      <div className="p-5 pb-3">
        {/* Header row */}
        <div className="flex items-center justify-between gap-3 mb-4">
          <div>
            <h2 className="text-sm font-semibold text-ink">{t('admin.orders.allTitle')}</h2>
            <p className="text-xs text-ink-muted mt-0.5">{t('admin.orders.allSubtitle')}</p>
          </div>
          <button
            onClick={exportCSV}
            disabled={exporting || total === 0}
            className="avg-btn-secondary flex items-center gap-1.5 text-xs py-2 disabled:opacity-40"
          >
            {exporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
            {exporting ? t('admin.membersExport.exporting') : t('admin.membersExport.button')}
          </button>
        </div>

        {/* Status filter pills */}
        <div className="flex flex-wrap gap-1 bg-white/5 p-1 rounded-lg w-fit mb-3">
          {STATUS_PILLS.map((p) => (
            <button
              key={p.key}
              onClick={() => { setStatus(p.key); setPage(1) }}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all cursor-pointer whitespace-nowrap ${
                status === p.key
                  ? 'bg-white/10 text-ink shadow-sm'
                  : 'text-ink-muted hover:text-ink'
              }`}
            >
              {t(`admin.orders.${p.labelKey}`)}
            </button>
          ))}
        </div>

        {/* Filter row: search + date range + product */}
        <div className="flex flex-wrap items-end gap-3">
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted" />
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={t('admin.orders.allSearchPlaceholder')}
              className="w-56 rounded-lg border border-surface-line bg-[#10141F] pl-9 pr-3 py-2.5 text-sm text-ink placeholder:text-ink-muted/60 outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs text-ink-muted">{t('admin.orders.allFrom')}</label>
            <input
              type="date"
              value={from}
              onChange={(e) => { setFrom(e.target.value); setPage(1) }}
              className="rounded-lg border border-surface-line bg-[#10141F] px-3 py-2 text-sm text-ink outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs text-ink-muted">{t('admin.orders.allTo')}</label>
            <input
              type="date"
              value={to}
              onChange={(e) => { setTo(e.target.value); setPage(1) }}
              className="rounded-lg border border-surface-line bg-[#10141F] px-3 py-2 text-sm text-ink outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs text-ink-muted">{t('admin.orders.colProduct')}</label>
            <select
              value={productId}
              onChange={(e) => {
                setProductId(e.target.value === '' ? '' : Number(e.target.value))
                setPage(1)
              }}
              className="rounded-lg border border-surface-line bg-[#10141F] px-3 py-2 text-sm text-ink outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
            >
              <option value="">{t('admin.orders.allProductAll')}</option>
              {(productsData ?? []).map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <DataTable
        columns={columns}
        data={orders}
        loading={isPending}
        rowKey={(r) => r.orderId}
        emptyTitle={t('admin.orders.allEmptyTitle')}
        emptyDescription={t('admin.orders.allEmptyDesc')}
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
  )
}
