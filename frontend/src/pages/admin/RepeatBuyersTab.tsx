import { useEffect, useState } from 'react'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Download, Loader2, Search } from 'lucide-react'
import api from '../../lib/api'
import { downloadCsv } from '../../lib/exportCsv'
import { formatINR, formatDate } from '../../lib/format'
import { DataTable, type Column } from '../../components/ui/DataTable'
import type { AdminMultiBuyerRow, AdminMultiBuyersPage, AdminAllOrderRow, AdminOrdersPage } from '../../types/api'

type ExportScope = 'confirmed' | 'confirmed,paid' | 'all'

const EXPORT_SCOPE_OPTIONS: { value: ExportScope; labelKey: string }[] = [
  { value: 'confirmed',      labelKey: 'repeatExportScopeConfirmed' },
  { value: 'confirmed,paid', labelKey: 'repeatExportScopeConfirmedPaid' },
  { value: 'all',            labelKey: 'repeatExportScopeAll' },
]

const PAGE_SIZE = 20

export function RepeatBuyersTab() {
  const { t } = useTranslation()

  const [input, setInput] = useState('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const [exporting, setExporting] = useState(false)
  // Export scope: which order statuses to include in the "1 per person" CSV.
  // Default = confirmed only (dispatch/fulfilment list).
  const [exportScope, setExportScope] = useState<ExportScope>('confirmed')

  useEffect(() => {
    const id = setTimeout(() => { setQ(input); setPage(1) }, 350)
    return () => clearTimeout(id)
  }, [input])

  const { data: buyersPage, isPending } = useQuery<AdminMultiBuyersPage>({
    queryKey: ['admin-orders-multi-buyers', q, page],
    queryFn: () =>
      api
        .get(`/admin/orders/multi-buyers?q=${encodeURIComponent(q)}&page=${page}&limit=${PAGE_SIZE}`)
        .then((r) => r.data),
    placeholderData: keepPreviousData,
  })
  const buyers = buyersPage?.items ?? []
  const total = buyersPage?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  // Export: fetch ALL orders for the chosen status(es) via /admin/orders/all,
  // then deduplicate by memberCode keeping only the first occurrence.
  // Rows are returned created_at DESC, so the first seen per member = most recent.
  // Note: this export covers EVERYONE (all buyers, not just repeat buyers) — one
  // row per person, independent of the search box above.
  const exportCSV = async () => {
    setExporting(true)
    try {
      // If scope is 'confirmed,paid', fetch both statuses and merge.
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

      // Deduplicate: keep first occurrence per memberCode (= most recent, since DESC).
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
      key: 'count',
      header: t('admin.orders.repeatColCount'),
      render: (r) => (
        <span className="text-sm font-semibold text-primary">{r.confirmedCount}</span>
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
  ]

  return (
    <div className="space-y-4">
      <div className="avg-card">
        <div className="p-5 pb-3">
          {/* Header row */}
          <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
            <div>
              <h2 className="text-sm font-semibold text-ink">{t('admin.orders.repeatTitle')}</h2>
              <p className="text-xs text-ink-muted mt-0.5">{t('admin.orders.repeatSubtitle')}</p>
            </div>

            {/* Export control: scope selector + button.
                The export covers ALL buyers (not filtered by search), one row per person. */}
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

          {/* Search — filters only the on-screen list, NOT the export */}
          <div className="relative w-fit">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted" />
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={t('admin.orders.repeatSearchPlaceholder')}
              className="w-64 rounded-lg border border-surface-line bg-[#10141F] pl-9 pr-3 py-2.5 text-sm text-ink placeholder:text-ink-muted/60 outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
            />
          </div>
        </div>

        <DataTable
          columns={columns}
          data={buyers}
          loading={isPending}
          rowKey={(r) => r.memberCode}
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
  )
}
