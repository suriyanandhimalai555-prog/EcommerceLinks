import { useInfiniteQuery } from '@tanstack/react-query'
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
  // Offset-based pages: each "Load more" fetches only the next PAGE rows.
  const { data, isPending, isFetchingNextPage, hasNextPage, fetchNextPage } =
    useInfiniteQuery<AuditRow[]>({
      queryKey: ['admin-audit'],
      queryFn: ({ pageParam }) =>
        api.get(`/admin/audit-log?limit=${PAGE}&offset=${pageParam}`).then((r) => r.data),
      initialPageParam: 0,
      getNextPageParam: (lastPage, allPages) =>
        lastPage.length === PAGE ? allPages.length * PAGE : undefined,
    })

  const rows = data?.pages.flat() ?? []

  const columns: Column<AuditRow>[] = [
    { key: 'at', header: 'When', render: (r) => <span className="text-xs text-ink-muted whitespace-nowrap">{formatDateTime(r.createdAt)}</span> },
    { key: 'actor', header: 'Actor', render: (r) => <span className="text-sm font-medium text-ink">{r.actorName}</span> },
    { key: 'action', header: 'Action', render: (r) => <Badge variant="primary" size="sm">{r.action}</Badge> },
    { key: 'target', header: 'Target', render: (r) => <span className="font-mono text-xs text-ink-muted">{r.targetType}{r.targetId ? ` #${r.targetId}` : ''}</span> },
    { key: 'change', header: 'Change', render: (r) => <span className="text-xs text-ink-muted break-all">{stateSummary(r)}</span> },
  ]

  return (
    <div className="avg-card">
      <div className="p-5 pb-0"><h2 className="text-sm font-semibold text-ink">Admin audit trail</h2></div>
      <DataTable
        columns={columns}
        data={rows}
        loading={isPending}
        rowKey={(r) => r.id}
        emptyTitle="No admin actions yet"
        hasMore={hasNextPage}
        onLoadMore={() => fetchNextPage()}
        loadingMore={isFetchingNextPage}
      />
    </div>
  )
}
