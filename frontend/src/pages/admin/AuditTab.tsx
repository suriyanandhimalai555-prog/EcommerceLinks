import { useEffect, useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Search, X } from 'lucide-react'
import api from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import { DataTable, type Column } from '../../components/ui/DataTable'
import { Badge } from '../../components/ui/Badge'
import type { AuditRow } from '../../types/api'

const PAGE = 50

function stateSummary(r: AuditRow): string {
  const fmt = (s: Record<string, unknown> | null) => (s ? JSON.stringify(s) : '—')
  if (!r.beforeState && !r.afterState) return '—'
  return `${fmt(r.beforeState)} → ${fmt(r.afterState)}`
}

export function AuditTab() {
  const { t } = useTranslation()

  // Debounced text search (350ms — repo-wide convention)
  const [input, setInput] = useState('')
  const [q, setQ] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  useEffect(() => {
    const id = setTimeout(() => setQ(input), 350)
    return () => clearTimeout(id)
  }, [input])

  const hasFilter = q !== '' || from !== '' || to !== ''

  const clearFilters = () => {
    setInput('')
    setQ('')
    setFrom('')
    setTo('')
  }

  // Offset-based infinite scroll. Filters in queryKey reset to page 0 on change.
  const { data, isPending, isFetchingNextPage, hasNextPage, fetchNextPage } =
    useInfiniteQuery<AuditRow[]>({
      queryKey: ['admin-audit', q, from, to],
      queryFn: async ({ pageParam }) => {
        const params = new URLSearchParams({
          limit: String(PAGE),
          offset: String(pageParam as number),
        })
        if (q)    params.set('q',    q)
        if (from) params.set('from', from)
        if (to)   params.set('to',   to)
        const res = await api.get(`/admin/audit-log?${params}`)
        return res.data as AuditRow[]
      },
      initialPageParam: 0,
      getNextPageParam: (lastPage, allPages) =>
        lastPage.length === PAGE ? allPages.length * PAGE : undefined,
    })

  const rows = data?.pages.flat() ?? []

  const columns: Column<AuditRow>[] = [
    {
      key: 'at', header: t('admin.audit.colWhen'),
      render: (r) => <span className="text-xs text-ink-muted whitespace-nowrap">{formatDateTime(r.createdAt)}</span>,
    },
    {
      key: 'actor', header: t('admin.audit.colActor'),
      render: (r) => <span className="text-sm font-medium text-ink">{r.actorName}</span>,
    },
    {
      key: 'action', header: t('admin.audit.colAction'),
      render: (r) => <Badge variant="primary" size="sm">{r.action}</Badge>,
    },
    {
      key: 'target', header: t('admin.audit.colTarget'),
      render: (r) => <span className="font-mono text-xs text-ink-muted">{r.targetType}{r.targetId ? ` #${r.targetId}` : ''}</span>,
    },
    {
      key: 'change', header: t('admin.audit.colChange'),
      render: (r) => <span className="text-xs text-ink-muted break-all">{stateSummary(r)}</span>,
    },
  ]

  return (
    <div className="avg-card">
      <div className="p-5 pb-3 space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-sm font-semibold text-ink">{t('admin.audit.title')}</h2>
          {hasFilter && (
            <button
              onClick={clearFilters}
              className="flex items-center gap-1.5 text-xs text-ink-muted hover:text-ink transition-colors self-start sm:self-auto"
            >
              <X size={12} />
              {t('admin.audit.clear')}
            </button>
          )}
        </div>

        {/* Search + date range */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          {/* Text search */}
          <div className="relative flex-1 min-w-0">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted" />
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={t('admin.audit.searchPlaceholder')}
              className="w-full rounded-lg border border-surface-line bg-[#10141F] pl-9 pr-3 py-2.5 text-sm text-ink placeholder:text-ink-muted/60 outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
            />
          </div>

          {/* From / To date pickers */}
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-xs text-ink-muted whitespace-nowrap">{t('admin.audit.fromLabel')}</span>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="rounded-lg border border-surface-line bg-[#10141F] px-3 py-2.5 text-sm text-ink outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
            />
            <span className="text-xs text-ink-muted whitespace-nowrap">{t('admin.audit.toLabel')}</span>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="rounded-lg border border-surface-line bg-[#10141F] px-3 py-2.5 text-sm text-ink outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
            />
          </div>
        </div>
      </div>

      <DataTable
        columns={columns}
        data={rows}
        loading={isPending}
        rowKey={(r) => r.id}
        emptyTitle={t('admin.audit.emptyTitle')}
        emptyDescription={hasFilter ? t('admin.audit.emptyFiltered') : undefined}
        hasMore={hasNextPage}
        onLoadMore={() => fetchNextPage()}
        loadingMore={isFetchingNextPage}
      />
    </div>
  )
}
