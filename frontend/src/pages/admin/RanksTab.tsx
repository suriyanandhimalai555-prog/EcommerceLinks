import { useEffect, useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Check, X, Loader2, Search, PackageCheck } from 'lucide-react'
import api from '../../lib/api'
import { apiErrorMessage } from '../../lib/apiError'
import { isManagement } from '../../lib/roles'
import { formatDate } from '../../lib/format'
import { DataTable, type Column } from '../../components/ui/DataTable'
import { Badge } from '../../components/ui/Badge'
import { Modal } from '../../components/ui/Modal'
import type { Me, PendingRank, RanksPage, RankSummaryRow } from '../../types/api'

type RankStatus = 'pending' | 'approved' | 'received' | 'rejected'
const STATUS_TABS: { value: RankStatus; label: string }[] = [
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'received', label: 'Received' },
  { value: 'rejected', label: 'Rejected' },
]
const RANK_LEVELS = Array.from({ length: 12 }, (_, i) => i + 1)
const PAGE_SIZE = 50

export function RanksTab() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const rankName = (level: number) => t(`ranks.l${level}`)

  const [status, setStatus] = useState<RankStatus>('pending')
  const [rankLevel, setRankLevel] = useState<number | ''>('')
  const [input, setInput] = useState('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)

  const [action, setAction] = useState<{ rank: PendingRank; kind: 'approve' | 'reject' } | null>(null)
  const [notes, setNotes] = useState('')

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [markOpen, setMarkOpen] = useState(false)
  const [markNotes, setMarkNotes] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  // Debounced search — mirrors MembersTab. Reset to page 1 on new query.
  useEffect(() => {
    const id = setTimeout(() => { setQ(input); setPage(1) }, 350)
    return () => clearTimeout(id)
  }, [input])

  const { data: me } = useQuery<Me>({ queryKey: ['me'], queryFn: () => api.get('/me').then((r) => r.data) })
  const canHandOver = isManagement(me)

  const { data, isPending } = useQuery<RanksPage>({
    queryKey: ['admin-ranks', status, rankLevel, q, page],
    queryFn: () =>
      api
        .get('/admin/ranks', {
          params: {
            status,
            rankLevel: rankLevel || undefined,
            q: q || undefined,
            page,
            limit: PAGE_SIZE,
          },
        })
        .then((r) => r.data),
    placeholderData: keepPreviousData,
  })
  const ranks = data?.ranks ?? []
  const total = data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const { data: summary } = useQuery<RankSummaryRow[]>({
    queryKey: ['admin-ranks-summary'],
    queryFn: () => api.get('/admin/ranks/summary').then((r) => r.data),
  })

  // Selection is only meaningful for management on the Approved tab.
  const selectable = canHandOver && status === 'approved'
  useEffect(() => { setSelected(new Set()) }, [status, rankLevel, q, page])

  const pageIds = useMemo(() => ranks.map((r) => r.id), [ranks])
  const allSelected = selectable && pageIds.length > 0 && pageIds.every((id) => selected.has(id))
  const toggleOne = (id: string) =>
    setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const toggleAll = () =>
    setSelected((s) => (allSelected ? new Set() : new Set([...s, ...pageIds])))

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['admin-ranks'] })
    qc.invalidateQueries({ queryKey: ['admin-ranks-summary'] })
    qc.invalidateQueries({ queryKey: ['admin-overview'] })
  }

  const decide = useMutation({
    mutationFn: ({ rank, kind }: { rank: PendingRank; kind: 'approve' | 'reject' }) =>
      api.post(`/admin/ranks/${rank.id}/${kind}`, { notes: notes || undefined }),
    onSuccess: () => { invalidate(); setAction(null); setNotes('') },
    onError: (err) => setMsg({ ok: false, text: apiErrorMessage(err, t, 'Action failed') }),
  })

  const markReceived = useMutation({
    mutationFn: () =>
      api
        .post('/admin/ranks/mark-received', { ids: [...selected], notes: markNotes || undefined })
        .then((r) => r.data as { updated: number; skipped: number }),
    onSuccess: (res) => {
      invalidate()
      setMarkOpen(false)
      setMarkNotes('')
      setSelected(new Set())
      setMsg({ ok: true, text: `Marked ${res.updated} received${res.skipped ? `, ${res.skipped} skipped` : ''}` })
    },
    onError: (err) => setMsg({ ok: false, text: apiErrorMessage(err, t, 'Action failed') }),
  })

  const statusBadge = (r: PendingRank) => {
    if (r.verification_status === 'rejected') return <Badge variant="danger">Rejected</Badge>
    if (r.verification_status === 'pending') return <Badge variant="warning">Pending</Badge>
    // 'approved' splits into Received (reward handed over) vs Approved (awaiting hand-over).
    return r.fulfilled_at ? <Badge variant="primary">Received</Badge> : <Badge variant="success">Approved</Badge>
  }

  const columns: Column<PendingRank>[] = [
    ...(selectable
      ? [{
          key: 'select', header: '',
          render: (r: PendingRank) => (
            <input
              type="checkbox"
              checked={selected.has(r.id)}
              onChange={(e) => { e.stopPropagation(); toggleOne(r.id) }}
              className="h-4 w-4 accent-primary cursor-pointer"
            />
          ),
        } as Column<PendingRank>]
      : []),
    { key: 'code', header: 'Member', render: (r) => <span className="font-mono text-xs font-semibold text-ink">{r.member_code}</span> },
    { key: 'name', header: 'Name', render: (r) => <span className="font-medium text-ink">{r.name}</span> },
    { key: 'level', header: 'Rank', render: (r) => <Badge variant="warning">{rankName(r.rank_level)}</Badge> },
    { key: 'status', header: 'Status', render: (r) => statusBadge(r) },
    { key: 'achieved', header: 'Achieved', render: (r) => <span className="text-xs text-ink-muted">{formatDate(r.achieved_at)}</span> },
    {
      key: 'actions', header: 'Decision', align: 'right',
      render: (r) =>
        status === 'pending' ? (
          <div className="flex gap-2 justify-end">
            <button onClick={(e) => { e.stopPropagation(); setAction({ rank: r, kind: 'approve' }) }} className="avg-btn-secondary py-1.5 px-3 text-xs"><Check size={12} /> Approve</button>
            <button onClick={(e) => { e.stopPropagation(); setAction({ rank: r, kind: 'reject' }) }} className="avg-btn-danger"><X size={12} /> Reject</button>
          </div>
        ) : (
          <span className="text-xs text-ink-muted">{r.fulfillment_notes || '—'}</span>
        ),
    },
  ]

  return (
    <div className="avg-card">
      <div className="p-5 pb-3 space-y-4">
        <h2 className="text-sm font-semibold text-ink">Rank verifications</h2>

        {/* Per-rank summary — click a cell to jump to that rank's pending queue */}
        {summary && summary.length > 0 && (
          <div className="flex gap-2 overflow-x-auto pb-1">
            {summary.map((s) => (
              <button
                key={s.rank_level}
                onClick={() => { setStatus('pending'); setRankLevel(s.rank_level); setPage(1) }}
                className={`shrink-0 rounded-lg border px-3 py-2 text-left transition-colors ${
                  rankLevel === s.rank_level ? 'border-primary bg-primary/10' : 'border-surface-line hover:bg-white/5'
                }`}
              >
                <div className="text-xs font-medium text-ink whitespace-nowrap">{rankName(s.rank_level)}</div>
                <div className="mt-1 flex items-center gap-1.5">
                  {s.pending > 0 ? <Badge variant="warning" size="sm">{s.pending} pending</Badge> : <span className="text-[11px] text-ink-muted">0 pending</span>}
                </div>
              </button>
            ))}
          </div>
        )}

        {/* Status tabs (button group — server-driven, so not the internal-state Tabs component) */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex gap-1 bg-white/5 p-1 rounded-lg">
            {STATUS_TABS.map((tab) => (
              <button
                key={tab.value}
                onClick={() => { setStatus(tab.value); setPage(1) }}
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors cursor-pointer ${
                  status === tab.value ? 'bg-white/10 text-ink shadow-sm' : 'text-ink-muted hover:text-ink'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <select
            value={rankLevel}
            onChange={(e) => { setRankLevel(e.target.value ? Number(e.target.value) : ''); setPage(1) }}
            className="rounded-lg border border-surface-line bg-[#10141F] px-3 py-2 text-sm text-ink outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
          >
            <option value="">All ranks</option>
            {RANK_LEVELS.map((n) => <option key={n} value={n}>{rankName(n)}</option>)}
          </select>

          <div className="relative flex-1 min-w-[12rem] max-w-md">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted" />
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Search by name or member code…"
              className="w-full rounded-lg border border-surface-line bg-[#10141F] pl-9 pr-3 py-2 text-sm text-ink placeholder:text-ink-muted/60 outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
            />
          </div>
        </div>

        {msg && (
          <p className={`text-xs ${msg.ok ? 'text-success' : 'text-danger'}`}>{msg.text}</p>
        )}

        {/* Reward hand-over action bar — management only, Approved tab */}
        {selectable && (
          <div className="flex items-center gap-3 rounded-lg border border-surface-line bg-white/[0.03] px-3 py-2">
            <label className="flex items-center gap-2 text-xs text-ink-muted cursor-pointer">
              <input type="checkbox" checked={allSelected} onChange={toggleAll} className="h-4 w-4 accent-primary" />
              Select page
            </label>
            <span className="text-xs text-ink-muted">{selected.size} selected</span>
            <button
              onClick={() => setMarkOpen(true)}
              disabled={selected.size === 0}
              className="avg-btn-primary py-1.5 px-3 text-xs ml-auto disabled:opacity-40"
            >
              <PackageCheck size={13} /> Mark {selected.size} received
            </button>
          </div>
        )}
      </div>

      <DataTable
        columns={columns}
        data={ranks}
        loading={isPending}
        rowKey={(r) => r.id}
        emptyTitle="No ranks found"
        emptyDescription="Try a different status, rank or search"
      />

      {total > 0 && (
        <div className="px-5 py-3 border-t border-surface-line flex items-center justify-between gap-4 flex-wrap">
          <span className="text-xs text-ink-muted">
            Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total}
          </span>
          <div className="flex items-center gap-1">
            <button onClick={() => setPage((p) => p - 1)} disabled={page === 1} className="avg-btn-secondary py-1.5 px-3 text-xs disabled:opacity-40">‹ Prev</button>
            <span className="px-3 text-xs font-medium text-ink">{page} / {totalPages}</span>
            <button onClick={() => setPage((p) => p + 1)} disabled={page >= totalPages} className="avg-btn-secondary py-1.5 px-3 text-xs disabled:opacity-40">Next ›</button>
          </div>
        </div>
      )}

      {/* Approve / reject confirmation */}
      <Modal open={!!action} onClose={() => setAction(null)} title={action?.kind === 'approve' ? 'Approve rank' : 'Reject rank'}>
        {action && (
          <div className="space-y-4">
            <p className="text-sm text-ink-muted">
              {action.kind === 'approve' ? 'Approve' : 'Reject'}{' '}
              <span className="text-ink font-semibold">{rankName(action.rank.rank_level)}</span> for{' '}
              <span className="text-ink font-semibold">{action.rank.name}</span> ({action.rank.member_code})?
            </p>
            <div>
              <label className="block text-sm font-medium text-ink mb-1.5">Notes (optional)</label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                className="w-full rounded-lg border border-surface-line bg-[#10141F] px-3 py-2.5 text-sm text-ink outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
              />
            </div>
            <button
              onClick={() => decide.mutate(action)}
              disabled={decide.isPending}
              className={action.kind === 'approve' ? 'avg-btn-primary w-full' : 'w-full flex items-center justify-center gap-2 bg-danger text-white font-semibold rounded-lg px-4 py-2.5 text-sm cursor-pointer hover:bg-danger/90 transition-colors disabled:opacity-50'}
            >
              {decide.isPending ? <Loader2 size={15} className="animate-spin" /> : null}
              Confirm {action.kind}
            </button>
          </div>
        )}
      </Modal>

      {/* Reward hand-over confirmation */}
      <Modal open={markOpen} onClose={() => setMarkOpen(false)} title="Mark rewards received">
        <div className="space-y-4">
          <p className="text-sm text-ink-muted">
            Confirm physical hand-over of the reward for{' '}
            <span className="text-ink font-semibold">{selected.size}</span> approved rank{selected.size === 1 ? '' : 's'}.
            This cannot be undone.
          </p>
          <div>
            <label className="block text-sm font-medium text-ink mb-1.5">Notes (optional)</label>
            <textarea
              value={markNotes}
              onChange={(e) => setMarkNotes(e.target.value)}
              rows={3}
              className="w-full rounded-lg border border-surface-line bg-[#10141F] px-3 py-2.5 text-sm text-ink outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
            />
          </div>
          <button onClick={() => markReceived.mutate()} disabled={markReceived.isPending} className="avg-btn-primary w-full">
            {markReceived.isPending ? <Loader2 size={15} className="animate-spin" /> : null}
            Confirm hand-over
          </button>
        </div>
      </Modal>
    </div>
  )
}
