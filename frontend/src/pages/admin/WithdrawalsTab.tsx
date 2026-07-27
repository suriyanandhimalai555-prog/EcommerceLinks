import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Loader2, Search, CheckCircle2, XCircle } from 'lucide-react'
import api from '../../lib/api'
import { apiErrorMessage } from '../../lib/apiError'
import { formatDate, formatINR } from '../../lib/format'
import { DataTable, type Column } from '../../components/ui/DataTable'
import { Badge } from '../../components/ui/Badge'
import { Modal } from '../../components/ui/Modal'
import type { AdminWithdrawal, AdminWithdrawalsPage } from '../../types/api'

type FilterStatus = 'requested' | 'paid' | 'rejected' | 'all'

const PAGE_SIZE = 20

export function WithdrawalsTab() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [statusFilter, setStatusFilter] = useState<FilterStatus>('requested')
  const [input, setInput] = useState('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<AdminWithdrawal | null>(null)
  const [notes, setNotes] = useState('')
  const [bankRef, setBankRef] = useState('')
  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    const id = setTimeout(() => { setQ(input); setPage(1) }, 350)
    return () => clearTimeout(id)
  }, [input])

  const { data: wdPage, isPending } = useQuery<AdminWithdrawalsPage>({
    queryKey: ['admin-withdrawals', statusFilter, q, page],
    queryFn: () =>
      api
        .get(`/admin/withdrawals?status=${statusFilter}&page=${page}&limit=${PAGE_SIZE}`)
        .then((r) => r.data),
    placeholderData: keepPreviousData,
  })
  const items = wdPage?.items ?? []
  const total = wdPage?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const decide = useMutation({
    mutationFn: ({ action, id }: { action: 'approve' | 'reject'; id: string }) =>
      api.post(`/admin/withdrawals/${id}/${action}`, {
        notes: notes.trim() || undefined,
        bankRef: action === 'approve' ? (bankRef.trim() || undefined) : undefined,
      }),
    onSuccess: (_, { action }) => {
      qc.invalidateQueries({ queryKey: ['admin-withdrawals'] })
      qc.invalidateQueries({ queryKey: ['admin-overview'] })
      setBanner({ ok: true, text: t(action === 'approve' ? 'admin.withdrawals.approved' : 'admin.withdrawals.rejected') })
      setSelected(null)
      setNotes('')
      setBankRef('')
    },
    onError: (err) =>
      setBanner({ ok: false, text: apiErrorMessage(err, t, t('admin.withdrawals.actionFailed')) }),
  })

  const filterPills: { key: FilterStatus; label: string }[] = [
    { key: 'requested', label: t('admin.withdrawals.filterPending') },
    { key: 'paid', label: t('admin.withdrawals.filterPaid') },
    { key: 'rejected', label: t('admin.withdrawals.filterRejected') },
    { key: 'all', label: t('admin.withdrawals.filterAll') },
  ]

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
      key: 'status', header: t('admin.withdrawals.colStatus'),
      render: (r) => (
        <Badge size="sm" variant={
          r.status === 'paid' ? 'success' :
          r.status === 'rejected' ? 'danger' :
          r.status === 'requested' ? 'warning' :
          'neutral'
        }>
          {r.status}
        </Badge>
      ),
    },
    { key: 'date', header: t('admin.withdrawals.colDate'), render: (r) => <span className="text-xs text-ink-muted">{formatDate(r.requestedAt)}</span> },
    {
      key: 'action', header: '', align: 'right',
      render: (r) => r.status === 'requested' ? (
        <button
          onClick={() => { setSelected(r); setBanner(null); setNotes(''); setBankRef('') }}
          className="avg-btn-secondary py-1.5 px-3 text-xs"
        >
          {t('admin.withdrawals.review')}
        </button>
      ) : null,
    },
  ]

  return (
    <div className="avg-card">
      <div className="p-5 pb-3">
        <h2 className="text-sm font-semibold text-ink mb-3">{t('admin.withdrawals.title')}</h2>
        <div className="flex gap-1 bg-white/5 p-1 rounded-lg w-fit">
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
        <div className="relative max-w-md mt-3">
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
        onClose={() => { setSelected(null); setNotes(''); setBankRef('') }}
        title={selected ? `${selected.memberName} — ${selected.memberCode}` : ''}
        size="lg"
      >
        {selected && (
          <div className="space-y-5 max-h-[70vh] overflow-y-auto pr-1">
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
              <span className="text-ink-muted">{t('admin.withdrawals.requestedOn', { date: formatDate(selected.requestedAt) })}</span>
              <span className="text-ink font-semibold">{t('admin.withdrawals.gross')}: {formatINR(selected.amountPaise)}</span>
              <span className="text-ink-muted">{t('admin.withdrawals.tds5pct')}</span>
            </div>

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
                disabled={decide.isPending}
                className="avg-btn-primary py-1.5 px-4 text-sm flex items-center gap-1.5"
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
    </div>
  )
}
