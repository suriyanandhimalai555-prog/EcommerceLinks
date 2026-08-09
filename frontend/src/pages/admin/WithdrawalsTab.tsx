import { useEffect, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Loader2, Search, CheckCircle2, XCircle, AlertCircle, CalendarDays, Download } from 'lucide-react'
import api from '../../lib/api'
import { apiErrorMessage } from '../../lib/apiError'
import { formatDate, formatINR } from '../../lib/format'
import { downloadCsv } from '../../lib/exportCsv'
import { DataTable, type Column } from '../../components/ui/DataTable'
import { Badge } from '../../components/ui/Badge'
import { Modal } from '../../components/ui/Modal'
import { ImageUploader, type UploadedImage, type ImageUploaderHandle } from '../../components/ui/ImageUploader'
import type {
  AdminWithdrawal,
  AdminWithdrawalsPage,
  AdminWithdrawalWeeksRes,
  AdminWithdrawalExport,
  PresignRes,
} from '../../types/api'

type FilterStatus = 'pending' | 'requested' | 'paid' | 'rejected' | 'all'

const PAGE_SIZE = 20

export function WithdrawalsTab() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [statusFilter, setStatusFilter] = useState<FilterStatus>('pending')
  const [weekFilter, setWeekFilter] = useState<string>('all')
  const [input, setInput] = useState('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<AdminWithdrawal | null>(null)
  const [revertTarget, setRevertTarget] = useState<AdminWithdrawal | null>(null)
  const [notes, setNotes] = useState('')
  const [bankRef, setBankRef] = useState('')
  const [proofImages, setProofImages] = useState<UploadedImage[]>([])
  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null)
  const [exporting, setExporting] = useState(false)
  const uploaderRef = useRef<ImageUploaderHandle>(null)

  useEffect(() => {
    const id = setTimeout(() => { setQ(input); setPage(1) }, 350)
    return () => clearTimeout(id)
  }, [input])

  // ── Per-week aggregates (week dropdown + summary strip) ───────────────────
  const { data: weeksData } = useQuery<AdminWithdrawalWeeksRes>({
    queryKey: ['admin-withdrawal-weeks'],
    queryFn: () => api.get('/admin/withdrawals/weeks').then((r) => r.data),
  })
  const weeks = weeksData?.weeks ?? []

  // ── Withdrawal list ───────────────────────────────────────────────────────
  const { data: wdPage, isPending } = useQuery<AdminWithdrawalsPage>({
    queryKey: ['admin-withdrawals', statusFilter, weekFilter, q, page],
    queryFn: () => {
      const params = new URLSearchParams({
        status: statusFilter,
        page: String(page),
        limit: String(PAGE_SIZE),
        q,
      })
      if (weekFilter !== 'all') params.set('cutoffId', weekFilter)
      return api.get(`/admin/withdrawals?${params}`).then((r) => r.data)
    },
    placeholderData: keepPreviousData,
  })
  const items = wdPage?.items ?? []
  const total = wdPage?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  function resetModal() {
    setSelected(null)
    setNotes('')
    setBankRef('')
    setProofImages([])
  }

  const decide = useMutation({
    mutationFn: async ({ action, id }: { action: 'approve' | 'reject'; id: string }) => {
      let proofKeys: string[] = []
      if (action === 'approve' && uploaderRef.current) {
        proofKeys = await uploaderRef.current.upload()
      }
      return api.post(`/admin/withdrawals/${id}/${action}`, {
        notes: notes.trim() || undefined,
        bankRef: action === 'approve' ? (bankRef.trim() || undefined) : undefined,
        proofKeys: action === 'approve' && proofKeys.length > 0 ? proofKeys : undefined,
      })
    },
    onSuccess: (_, { action }) => {
      qc.invalidateQueries({ queryKey: ['admin-withdrawals'] })
      qc.invalidateQueries({ queryKey: ['admin-withdrawal-weeks'] })
      qc.invalidateQueries({ queryKey: ['admin-overview'] })
      qc.invalidateQueries({ queryKey: ['admin-earnings'] })
      setBanner({ ok: true, text: t(action === 'approve' ? 'admin.withdrawals.approved' : 'admin.withdrawals.rejected') })
      resetModal()
    },
    onError: (err) =>
      setBanner({ ok: false, text: apiErrorMessage(err, t, t('admin.withdrawals.actionFailed')) }),
  })

  // Revert a wrongly-marked-paid row back to pending (record correction; the app
  // does not move real money — disbursement is external).
  const revert = useMutation({
    mutationFn: (id: string) => api.post(`/admin/withdrawals/${id}/revert`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-withdrawals'] })
      qc.invalidateQueries({ queryKey: ['admin-withdrawal-weeks'] })
      qc.invalidateQueries({ queryKey: ['admin-overview'] })
      qc.invalidateQueries({ queryKey: ['admin-earnings'] })
      setBanner({ ok: true, text: t('admin.withdrawals.reverted') })
      setRevertTarget(null)
    },
    onError: (err) =>
      setBanner({ ok: false, text: apiErrorMessage(err, t, t('admin.withdrawals.revertFailed')) }),
  })

  // ── Summary strip data ────────────────────────────────────────────────────
  // For a single selected week, use that week's figures. For "all weeks", use the
  // server-computed global totals (which include paid rows with a NULL cutoff) so
  // "Already paid" reconciles with the Earnings tab — NOT a sum of the week rows.
  const selectedWeek = weeks.find((w) => w.cutoffId === weekFilter)
  const summaryPendingAmount = selectedWeek
    ? selectedWeek.pendingTotalPaise
    : (weeksData?.totals?.pendingPaise ?? 0)
  const summaryPendingCount = selectedWeek
    ? selectedWeek.pendingCount
    : (weeksData?.totals?.pendingCount ?? 0)
  const summaryPaidAmount = selectedWeek
    ? selectedWeek.paidTotalPaise
    : (weeksData?.totals?.paidPaise ?? 0)

  // ── CSV export — all rows matching the current status/week/search filters ───
  const exportCSV = async () => {
    setExporting(true)
    try {
      const params = new URLSearchParams({ status: statusFilter })
      if (weekFilter !== 'all') params.set('cutoffId', weekFilter)
      if (q) params.set('q', q)
      const res: AdminWithdrawalExport = await api
        .get(`/admin/withdrawals/export?${params}`)
        .then((r) => r.data)

      const headers = [
        t('admin.withdrawals.colCode'),
        t('admin.withdrawals.colName'),
        t('admin.withdrawals.colAmount'),
        t('admin.withdrawals.colNet'),
        t('admin.withdrawals.colStatus'),
        t('admin.withdrawals.exportColBankRef'),
        t('admin.withdrawals.exportColWeekEnd'),
        t('admin.withdrawals.exportColProcessedAt'),
        t('admin.bank.notesLabel'),
      ]
      const rows = res.rows.map((r) => [
        r.memberCode,
        r.memberName,
        (r.amountPaise / 100).toFixed(2),
        r.netPaise != null ? (r.netPaise / 100).toFixed(2) : '',
        r.status,
        r.bankRef ?? '',
        r.weekEnd ? formatDate(r.weekEnd) : '',
        r.processedAt ? formatDate(r.processedAt) : '',
        r.notes ?? '',
      ])
      downloadCsv(`withdrawals-${statusFilter}-${formatDate(new Date().toISOString())}.csv`, headers, rows)
    } finally {
      setExporting(false)
    }
  }

  // ── Filter pills ──────────────────────────────────────────────────────────
  const filterPills: { key: FilterStatus; label: string }[] = [
    { key: 'pending', label: t('admin.withdrawals.filterPending') },
    { key: 'paid', label: t('admin.withdrawals.filterPaid') },
    { key: 'rejected', label: t('admin.withdrawals.filterRejected') },
    { key: 'all', label: t('admin.withdrawals.filterAll') },
  ]

  // ── Table columns ─────────────────────────────────────────────────────────
  const columns: Column<AdminWithdrawal>[] = [
    {
      key: 'code', header: t('admin.withdrawals.colCode'),
      render: (r) => <span className="font-mono text-xs font-semibold text-ink">{r.memberCode}</span>,
    },
    { key: 'name', header: t('admin.withdrawals.colName'), render: (r) => <span className="text-sm font-medium text-ink">{r.memberName}</span> },
    {
      key: 'amount', header: t('admin.withdrawals.colAmount'), align: 'right',
      render: (r) => <span className="font-bold text-sm">{formatINR(r.amountPaise)}</span>,
    },
    {
      key: 'net', header: t('admin.withdrawals.colNet'), align: 'right',
      render: (r) => r.netPaise != null
        ? <span className="text-sm text-ink-muted">{formatINR(r.netPaise)}</span>
        : <span className="text-ink-muted">—</span>,
    },
    {
      key: 'kyc', header: t('admin.withdrawals.colKyc'),
      render: (r) => (
        <Badge size="sm" variant={r.kycStatus === 'verified' ? 'success' : r.kycStatus === 'rejected' ? 'danger' : 'warning'}>
          {r.kycStatus}
        </Badge>
      ),
    },
    {
      key: 'bank', header: t('admin.withdrawals.colBank'),
      render: (r) => (
        <Badge size="sm" variant={r.bankStatus === 'verified' ? 'success' : r.bankStatus === 'rejected' ? 'danger' : 'warning'}>
          {r.bankStatus}
        </Badge>
      ),
    },
    {
      key: 'status', header: t('admin.withdrawals.colStatus'),
      render: (r) => (
        <Badge size="sm" variant={
          r.status === 'paid' ? 'success' :
          r.status === 'rejected' ? 'danger' :
          r.status === 'pending' || r.status === 'requested' ? 'warning' :
          'neutral'
        }>
          {r.status}
        </Badge>
      ),
    },
    {
      key: 'date', header: t('admin.withdrawals.colDate'),
      render: (r) => (
        <span className="text-xs text-ink-muted">
          {r.weekEnd ? formatDate(r.weekEnd) : formatDate(r.requestedAt)}
        </span>
      ),
    },
    {
      key: 'action', header: '', align: 'right',
      render: (r) => (r.status === 'pending' || r.status === 'requested') ? (
        <button
          onClick={() => { setSelected(r); setBanner(null); setNotes(''); setBankRef(''); setProofImages([]) }}
          className="avg-btn-secondary py-1.5 px-3 text-xs"
        >
          {t('admin.withdrawals.review')}
        </button>
      ) : r.status === 'paid' ? (
        <div className="flex items-center gap-2 justify-end">
          {r.proofUrls?.map((url, i) => (
            <a key={i} href={url} target="_blank" rel="noreferrer">
              <img src={url} alt="" className="w-8 h-8 rounded object-cover border border-surface-line hover:opacity-80" />
            </a>
          ))}
          <button
            onClick={() => { setRevertTarget(r); setBanner(null) }}
            className="text-xs font-medium text-warning hover:text-warning/80 whitespace-nowrap cursor-pointer"
          >
            {t('admin.withdrawals.revert')}
          </button>
        </div>
      ) : null,
    },
  ]

  const selectedCanPay = selected?.kycStatus === 'verified' && selected?.bankStatus === 'verified'

  return (
    <div className="avg-card">
      <div className="p-5 pb-3 space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-sm font-semibold text-ink">{t('admin.withdrawals.title')}</h2>
          <button
            onClick={exportCSV}
            disabled={exporting}
            className="avg-btn-secondary flex items-center gap-1.5 text-xs py-2 disabled:opacity-40 self-start sm:self-auto"
          >
            <Download size={13} />
            {exporting ? t('admin.withdrawals.exporting') : t('admin.withdrawals.exportBtn')}
          </button>
        </div>

        {/* Row 1 — status pills + week selector */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex gap-1 bg-white/5 p-1 rounded-lg">
            {filterPills.map((p) => (
              <button
                key={p.key}
                onClick={() => { setStatusFilter(p.key); setPage(1) }}
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition-all duration-200 cursor-pointer whitespace-nowrap ${
                  statusFilter === p.key
                    ? 'bg-white/10 text-ink shadow-sm'
                    : 'text-ink-muted hover:text-ink'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* Week selector */}
          <div className="flex items-center gap-2">
            <CalendarDays size={15} className="text-ink-muted flex-shrink-0" />
            <select
              value={weekFilter}
              onChange={(e) => { setWeekFilter(e.target.value); setPage(1) }}
              className="rounded-lg border border-surface-line bg-[#10141F] px-3 py-1.5 text-sm text-ink outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary cursor-pointer"
            >
              <option value="all">{t('admin.withdrawals.allWeeks')}</option>
              {weeks.map((w) => (
                <option key={w.cutoffId} value={w.cutoffId}>
                  {formatDate(w.weekStart)} → {formatDate(w.weekEnd)}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Summary strip */}
        {weeks.length > 0 && (
          <div className="flex flex-wrap gap-4 bg-primary/5 border border-primary/10 rounded-xl px-4 py-3">
            <div>
              <p className="text-[11px] text-ink-muted uppercase tracking-wider font-medium mb-0.5">
                {weekFilter === 'all' ? t('admin.withdrawals.allWeeks') : t('admin.withdrawals.weekLabel')}
              </p>
              <p className="text-sm font-bold text-ink">
                {t('admin.withdrawals.toPayThisWeek', {
                  amount: formatINR(summaryPendingAmount),
                  count: summaryPendingCount,
                })}
              </p>
            </div>
            <div className="border-l border-primary/15 pl-4">
              <p className="text-[11px] text-ink-muted uppercase tracking-wider font-medium mb-0.5">
                &nbsp;
              </p>
              <p className="text-sm text-ink-muted">
                {t(weekFilter === 'all' ? 'admin.withdrawals.alreadyPaidAll' : 'admin.withdrawals.alreadyPaid', { amount: formatINR(summaryPaidAmount) })}
              </p>
            </div>
          </div>
        )}

        {/* Search */}
        <div className="relative max-w-md">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted" />
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t('admin.withdrawals.searchPlaceholder')}
            className="w-full rounded-lg border border-surface-line bg-[#10141F] pl-9 pr-3 py-2.5 text-sm text-ink placeholder:text-ink-muted/60 outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
          />
        </div>
      </div>

      {banner && (
        <div className={`mx-5 mb-3 text-sm rounded-lg px-3 py-2 ${banner.ok ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger'}`}>
          {banner.text}
        </div>
      )}

      <DataTable
        columns={columns}
        data={items}
        loading={isPending}
        rowKey={(r) => r.id}
        emptyTitle={t('admin.withdrawals.emptyTitle')}
        emptyDescription={t('admin.withdrawals.emptyDesc')}
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

      <Modal
        open={!!selected}
        onClose={resetModal}
        title={selected ? `${selected.memberName} — ${selected.memberCode}` : ''}
        size="lg"
      >
        {selected && (
          <div className="space-y-5 max-h-[70vh] overflow-y-auto pr-1">
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
              <span className="text-ink-muted">{t('admin.withdrawals.requestedOn', { date: formatDate(selected.weekEnd ?? selected.requestedAt) })}</span>
              <span className="text-ink font-semibold">{t('admin.withdrawals.gross')}: {formatINR(selected.amountPaise)}</span>
              <span className="text-ink-muted">{t('admin.withdrawals.tds5pct')}</span>
            </div>

            {/* KYC + bank status — disable approve when not both verified */}
            <div className="flex flex-wrap gap-3">
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-ink-muted">KYC:</span>
                <Badge size="sm" variant={selected.kycStatus === 'verified' ? 'success' : selected.kycStatus === 'rejected' ? 'danger' : 'warning'}>
                  {selected.kycStatus}
                </Badge>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-ink-muted">{t('admin.withdrawals.bankLabel')}:</span>
                <Badge size="sm" variant={selected.bankStatus === 'verified' ? 'success' : selected.bankStatus === 'rejected' ? 'danger' : 'warning'}>
                  {selected.bankStatus}
                </Badge>
              </div>
            </div>

            {!selectedCanPay && (
              <div className="flex items-start gap-2 bg-warning/10 border border-warning/20 rounded-xl p-3">
                <AlertCircle size={13} className="text-warning shrink-0 mt-0.5" />
                <p className="text-xs text-ink-muted">{t('admin.withdrawals.kycBankNeeded')}</p>
              </div>
            )}

            <section className="space-y-2">
              <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-wider">
                {t('admin.withdrawals.bankRefLabel')}
              </h3>
              <input
                value={bankRef}
                onChange={(e) => setBankRef(e.target.value)}
                placeholder={t('admin.withdrawals.bankRefPlaceholder')}
                className="w-full rounded-lg border border-surface-line bg-[#10141F] px-3 py-2.5 text-sm text-ink outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
              />
            </section>

            {/* Optional payment proof screenshot upload */}
            <section className="space-y-2">
              <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-wider">
                {t('admin.withdrawals.proofLabel')}
              </h3>
              <p className="text-xs text-ink-muted">{t('admin.withdrawals.proofHint')}</p>
              <ImageUploader
                ref={uploaderRef}
                deferUpload
                value={proofImages}
                onChange={setProofImages}
                maxFiles={4}
                getPresign={(file) =>
                  api.post<PresignRes>(`/admin/withdrawals/${selected.id}/proof/presign`, {
                    contentType: file.type,
                    sizeBytes: file.size,
                  }).then(r => r.data)
                }
              />
            </section>

            <section className="space-y-2">
              <label className="block text-xs font-semibold text-ink-muted uppercase tracking-wider">
                {t('admin.bank.notesLabel')}
              </label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                className="w-full rounded-lg border border-surface-line bg-[#10141F] px-3 py-2.5 text-sm text-ink outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
              />
            </section>

            <div className="flex flex-wrap gap-2 border-t border-surface-line pt-4">
              <button
                onClick={() => decide.mutate({ action: 'approve', id: selected.id })}
                disabled={decide.isPending || !selectedCanPay}
                title={!selectedCanPay ? t('admin.withdrawals.kycBankNeeded') : undefined}
                className="avg-btn-primary py-1.5 px-4 text-sm flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {decide.isPending ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
                {t('admin.withdrawals.approve')}
              </button>
              <button
                onClick={() => decide.mutate({ action: 'reject', id: selected.id })}
                disabled={decide.isPending}
                className="avg-btn-danger text-sm flex items-center gap-1.5"
              >
                <XCircle size={13} />
                {t('admin.withdrawals.reject')}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Revert-to-pending confirmation (paid rows) */}
      <Modal
        open={!!revertTarget}
        title={t('admin.withdrawals.revertConfirmTitle')}
        onClose={() => setRevertTarget(null)}
      >
        {revertTarget && (
          <div className="space-y-4">
            <p className="text-sm text-ink">
              {revertTarget.memberName} — <span className="font-mono text-xs">{revertTarget.memberCode}</span>
              {' · '}<span className="font-semibold">{formatINR(revertTarget.amountPaise)}</span>
            </p>
            <p className="text-sm text-ink-muted">{t('admin.withdrawals.revertConfirmBody')}</p>
            <div className="flex gap-3 justify-end pt-2">
              <button
                type="button"
                className="avg-btn-secondary px-4 py-2 text-sm"
                onClick={() => setRevertTarget(null)}
                disabled={revert.isPending}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="flex items-center gap-1.5 bg-warning hover:bg-warning/90 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
                onClick={() => revert.mutate(revertTarget.id)}
                disabled={revert.isPending}
              >
                {revert.isPending ? <Loader2 size={14} className="animate-spin" /> : null}
                {t('admin.withdrawals.revert')}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
