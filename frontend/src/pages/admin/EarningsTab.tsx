import { useEffect, useState } from 'react'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Search, Download, TrendingUp, GitMerge, ArrowDownToLine, BadgePercent } from 'lucide-react'
import api from '../../lib/api'
import { formatDate, formatINR } from '../../lib/format'
import { DataTable, type Column } from '../../components/ui/DataTable'
import { Badge } from '../../components/ui/Badge'
import { Modal } from '../../components/ui/Modal'
import { StatCard } from '../../components/ui/StatCard'
import type {
  AdminEarningsRow,
  AdminEarningsPage,
  AdminEarningsDetail,
  AdminCutoff,
  AdminEarningsExport,
} from '../../types/api'

const PAGE_SIZE = 20

export function EarningsTab() {
  const { t } = useTranslation()
  const [input, setInput] = useState('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedCutoffId, setSelectedCutoffId] = useState<string>('')
  const [exporting, setExporting] = useState(false)
  // When on, the export only includes members whose KYC + bank are both verified
  // (i.e. the people we can actually send money to).
  const [verifiedOnly, setVerifiedOnly] = useState(true)

  // Debounce search
  useEffect(() => {
    const id = setTimeout(() => { setQ(input); setPage(1) }, 350)
    return () => clearTimeout(id)
  }, [input])

  // Main earnings list
  const { data: earningsPage, isPending } = useQuery<AdminEarningsPage>({
    queryKey: ['admin-earnings', q, page],
    queryFn: () =>
      api
        .get(`/admin/earnings?q=${encodeURIComponent(q)}&page=${page}&limit=${PAGE_SIZE}`)
        .then((r) => r.data),
    placeholderData: keepPreviousData,
  })
  const items = earningsPage?.items ?? []
  const total = earningsPage?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  // Summary stats (from current page — quick at-a-glance figures)
  const pageNetEarned = items.reduce((a, b) => a + b.netEarnedPaise, 0)
  const pagePairs = items.reduce((a, b) => a + b.pairsMatched, 0)
  const pageWithdrawn = items.reduce((a, b) => a + b.withdrawnPaise, 0)

  // Per-member detail
  const { data: detail, isPending: detailLoading } = useQuery<AdminEarningsDetail>({
    queryKey: ['admin-earnings-detail', selectedId],
    queryFn: () => api.get(`/admin/earnings/${selectedId}`).then((r) => r.data),
    enabled: !!selectedId,
  })

  // Cutoff list for the export week selector
  const { data: cutoffsData } = useQuery<{ items: AdminCutoff[] }>({
    queryKey: ['admin-cutoffs'],
    queryFn: () => api.get('/admin/cutoffs').then((r) => r.data),
    staleTime: 60_000,
  })
  const cutoffs = cutoffsData?.items ?? []

  // Default the selector to the last completed (closed) week.
  // Fall back to the open (in-progress) week only if nothing is closed yet.
  useEffect(() => {
    if (cutoffs.length > 0 && !selectedCutoffId) {
      // Default to the current (open) week so "this week up to now" exports without an
      // empty result; fall back to the last completed week, then the newest cutoff.
      const openWeek = cutoffs.find((c) => c.status === 'open')
      const lastClosed = cutoffs.find((c) => c.status === 'closed')
      setSelectedCutoffId((openWeek ?? lastClosed ?? cutoffs[0]).id)
    }
  }, [cutoffs, selectedCutoffId])

  const exportCSV = async () => {
    setExporting(true)
    try {
      const params = new URLSearchParams()
      if (selectedCutoffId) params.set('cutoffId', selectedCutoffId)
      if (verifiedOnly) params.set('verifiedOnly', 'true')
      const qs = params.toString()
      const url = qs ? `/admin/earnings/export?${qs}` : '/admin/earnings/export'
      const res: AdminEarningsExport = await api.get(url).then((r) => r.data)

      const startLabel = formatDate(res.windowStart)
      const endLabel = formatDate(res.windowEnd)
      const csvCell = (v: string) => `"${(v ?? '').replace(/"/g, '""')}"`
      const headers = [
        t('admin.earnings.exportColCode'),
        t('admin.earnings.exportColName'),
        t('admin.earnings.exportColEarned'),
        t('admin.earnings.exportColBankName'),
        t('admin.earnings.exportColBankNumber'),
        t('admin.earnings.exportColBankIfsc'),
        t('admin.earnings.exportColKyc'),
        t('admin.earnings.exportColBankStatus'),
      ]
      const rows = res.rows.map((r) => [
        r.memberCode,
        csvCell(r.name),
        (r.earnedPaise / 100).toFixed(2),
        csvCell(r.bankAccountName),
        csvCell(r.bankAccountNumber),
        csvCell(r.bankIfsc),
        r.kycStatus,
        r.bankStatus,
      ])
      const csv = [headers, ...rows].map((r) => r.join(',')).join('\n')
      const blob = new Blob([csv], { type: 'text/csv' })
      const blobUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = blobUrl
      a.download = `earnings-${startLabel}-to-${endLabel}.csv`
      a.click()
      URL.revokeObjectURL(blobUrl)
    } finally {
      setExporting(false)
    }
  }

  const columns: Column<AdminEarningsRow>[] = [
    {
      key: 'code',
      header: t('admin.earnings.colCode'),
      render: (r) => (
        <span className="font-mono text-xs font-semibold text-ink">{r.memberCode}</span>
      ),
    },
    {
      key: 'name',
      header: t('admin.earnings.colName'),
      render: (r) => <span className="text-sm font-medium text-ink">{r.name}</span>,
    },
    {
      key: 'earned',
      header: t('admin.earnings.colNetEarned'),
      align: 'right',
      render: (r) => (
        <span className="font-bold text-sm text-success">{formatINR(r.netEarnedPaise)}</span>
      ),
    },
    {
      key: 'pairs',
      header: t('admin.earnings.colPairs'),
      align: 'right',
      render: (r) => (
        <span className="text-sm font-semibold text-ink">{r.pairsMatched}</span>
      ),
    },
    {
      key: 'withdrawn',
      header: t('admin.earnings.colWithdrawn'),
      align: 'right',
      render: (r) => (
        <span className="text-sm text-ink-muted">{formatINR(r.withdrawnPaise)}</span>
      ),
    },
    {
      key: 'action',
      header: '',
      align: 'right',
      render: (r) => (
        <button
          onClick={() => setSelectedId(r.id)}
          className="avg-btn-secondary py-1.5 px-3 text-xs"
        >
          {t('admin.earnings.viewDetail')}
        </button>
      ),
    },
  ]

  const selectedRow = items.find((r) => r.id === selectedId)

  return (
    <div className="space-y-5">
      {/* Stats header — page-level snapshot */}
      {items.length > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
          <StatCard
            label={t('admin.earnings.statNetEarned')}
            value={formatINR(pageNetEarned)}
            sub={t('admin.earnings.statPageSub', { count: items.length })}
            icon={<TrendingUp size={18} />}
            tint="success"
          />
          <StatCard
            label={t('admin.earnings.statPairs')}
            value={String(pagePairs)}
            sub={t('admin.earnings.statPageSub', { count: items.length })}
            icon={<GitMerge size={18} />}
            tint="primary"
          />
          <StatCard
            label={t('admin.earnings.statWithdrawn')}
            value={formatINR(pageWithdrawn)}
            sub={t('admin.earnings.statPageSub', { count: items.length })}
            icon={<ArrowDownToLine size={18} />}
            tint="violet"
          />
        </div>
      )}

      <div className="avg-card">
        <div className="p-5 pb-3 space-y-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="text-sm font-semibold text-ink">{t('admin.earnings.title')}</h2>

            {/* Export row */}
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={selectedCutoffId}
                onChange={(e) => setSelectedCutoffId(e.target.value)}
                className="rounded-lg border border-surface-line bg-[#10141F] px-3 py-2 text-xs text-ink outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
              >
                {cutoffs.map((c, i) => {
                  // cutoffs are newest-first; first closed = "Last week", open = in-progress
                  const isOpen = c.status === 'open'
                  const isLastClosed = !isOpen && cutoffs.slice(0, i).every((x) => x.status === 'open')
                  const dateRange = `${formatDate(c.windowStart)} – ${formatDate(c.windowEnd)}`
                  const suffix = isOpen
                    ? ` — ${t('admin.earnings.weekCurrent')}`
                    : isLastClosed
                      ? ` — ${t('admin.earnings.weekLast')}`
                      : ''
                  return (
                    <option key={c.id} value={c.id}>
                      {dateRange}{suffix}
                    </option>
                  )
                })}
                {cutoffs.length === 0 && (
                  <option value="">{t('admin.earnings.noCutoffs')}</option>
                )}
              </select>
              <label className="flex items-center gap-1.5 text-xs text-ink-muted cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={verifiedOnly}
                  onChange={(e) => setVerifiedOnly(e.target.checked)}
                  className="accent-primary"
                />
                {t('admin.earnings.exportVerifiedOnly')}
              </label>
              <button
                onClick={exportCSV}
                disabled={exporting || cutoffs.length === 0}
                className="avg-btn-secondary flex items-center gap-1.5 text-xs py-2 disabled:opacity-40"
              >
                <Download size={13} />
                {exporting ? t('admin.earnings.exporting') : t('admin.earnings.exportBtn')}
              </button>
            </div>
          </div>

          {/* Search */}
          <div className="relative max-w-md">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted" />
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={t('admin.earnings.searchPlaceholder')}
              className="w-full rounded-lg border border-surface-line bg-[#10141F] pl-9 pr-3 py-2.5 text-sm text-ink placeholder:text-ink-muted/60 outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
            />
          </div>
        </div>

        <DataTable
          columns={columns}
          data={items}
          loading={isPending}
          rowKey={(r) => r.id}
          emptyTitle={t('admin.earnings.emptyTitle')}
          emptyDescription={t('admin.earnings.emptyDesc')}
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

      {/* Per-member detail modal */}
      <Modal
        open={!!selectedId}
        onClose={() => setSelectedId(null)}
        title={
          selectedRow
            ? `${selectedRow.name} — ${selectedRow.memberCode}`
            : (detail ? `${detail.name} — ${detail.memberCode}` : t('admin.earnings.detailTitle'))
        }
        size="lg"
      >
        {detailLoading && (
          <div className="py-8 text-center text-sm text-ink-muted">{t('admin.earnings.loading')}</div>
        )}
        {detail && !detailLoading && (
          <div className="space-y-5 max-h-[70vh] overflow-y-auto pr-1">
            {/* Member status badges */}
            <div className="flex flex-wrap gap-2">
              <Badge size="sm" variant={detail.isActive ? 'success' : 'neutral'}>
                {detail.isActive ? t('admin.earnings.active') : t('admin.earnings.inactive')}
              </Badge>
              <Badge size="sm" variant={detail.isQualified ? 'primary' : 'warning'}>
                {detail.isQualified ? t('admin.earnings.qualified') : t('admin.earnings.notQualified')}
              </Badge>
            </div>

            {/* Earnings breakdown */}
            <section>
              <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-wider mb-3">
                {t('admin.earnings.sectionEarnings')}
              </h3>
              <div className="grid grid-cols-2 gap-3">
                <div className="avg-card p-3 space-y-0.5">
                  <p className="text-[10px] text-ink-muted uppercase tracking-wider">
                    {t('admin.earnings.netEarned')}
                  </p>
                  <p className="text-lg font-bold text-success">{formatINR(detail.netEarnedPaise)}</p>
                  <p className="text-[10px] text-ink-muted">{t('admin.earnings.netEarnedHint')}</p>
                </div>
                <div className="avg-card p-3 space-y-0.5">
                  <p className="text-[10px] text-ink-muted uppercase tracking-wider">
                    {t('admin.earnings.grossEarned')}
                  </p>
                  <p className="text-lg font-bold text-ink">{formatINR(detail.grossEarnedPaise)}</p>
                  <p className="text-[10px] text-ink-muted">{t('admin.earnings.grossEarnedHint')}</p>
                </div>
                {detail.forfeitedPaise > 0 && (
                  <div className="avg-card p-3 space-y-0.5 col-span-2 border border-warning/20">
                    <div className="flex items-center gap-1.5">
                      <BadgePercent size={12} className="text-warning" />
                      <p className="text-[10px] text-warning uppercase tracking-wider font-semibold">
                        {t('admin.earnings.forfeited')}
                      </p>
                    </div>
                    <p className="text-base font-bold text-warning">{formatINR(detail.forfeitedPaise)}</p>
                    <p className="text-[10px] text-ink-muted">{t('admin.earnings.forfeitedHint')}</p>
                  </div>
                )}
                <div className="avg-card p-3 space-y-0.5">
                  <p className="text-[10px] text-ink-muted uppercase tracking-wider">
                    {t('admin.earnings.pairsDetail')}
                  </p>
                  <p className="text-lg font-bold text-ink">{detail.pairsMatched}</p>
                  <p className="text-[10px] text-ink-muted">{t('admin.earnings.pairsDetailHint')}</p>
                </div>
              </div>
            </section>

            {/* Withdrawals breakdown */}
            <section>
              <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-wider mb-3">
                {t('admin.earnings.sectionWithdrawals')}
              </h3>
              <div className="grid grid-cols-2 gap-3">
                <div className="avg-card p-3 space-y-0.5">
                  <p className="text-[10px] text-ink-muted uppercase tracking-wider">
                    {t('admin.earnings.withdrawnGross')}
                  </p>
                  <p className="text-base font-bold text-ink">{formatINR(detail.withdrawnGrossPaise)}</p>
                  <p className="text-[10px] text-ink-muted">
                    {t('admin.earnings.withdrawalCount', { count: detail.withdrawalCount })}
                  </p>
                </div>
                <div className="avg-card p-3 space-y-0.5">
                  <p className="text-[10px] text-ink-muted uppercase tracking-wider">
                    {t('admin.earnings.withdrawnNet')}
                  </p>
                  <p className="text-base font-bold text-ink">{formatINR(detail.withdrawnNetPaise)}</p>
                  <p className="text-[10px] text-ink-muted">{t('admin.earnings.withdrawnNetHint')}</p>
                </div>
                {detail.pendingWithdrawalPaise > 0 && (
                  <div className="avg-card p-3 space-y-0.5 border border-warning/20">
                    <p className="text-[10px] text-warning uppercase tracking-wider font-semibold">
                      {t('admin.earnings.pendingWithdrawal')}
                    </p>
                    <p className="text-base font-bold text-warning">
                      {formatINR(detail.pendingWithdrawalPaise)}
                    </p>
                    <p className="text-[10px] text-ink-muted">{t('admin.earnings.pendingWithdrawalHint')}</p>
                  </div>
                )}
              </div>
            </section>
          </div>
        )}
      </Modal>
    </div>
  )
}
