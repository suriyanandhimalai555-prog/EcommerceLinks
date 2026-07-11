import { type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { EmptyState } from './EmptyState'
import { Skeleton } from './Skeleton'

export interface Column<T> {
  key: string
  header: string
  render: (row: T) => ReactNode
  align?: 'left' | 'center' | 'right'
}

interface Props<T> {
  columns: Column<T>[]
  data: T[]
  loading?: boolean
  onLoadMore?: () => void
  hasMore?: boolean
  loadingMore?: boolean
  emptyTitle?: string
  emptyDescription?: string
  rowKey: (row: T) => string
}

export function DataTable<T>({
  columns, data, loading, onLoadMore, hasMore, loadingMore,
  emptyTitle = 'No data', emptyDescription, rowKey,
}: Props<T>) {
  if (loading) {
    return (
      <div className="space-y-2 p-4">
        {[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
      </div>
    )
  }

  if (data.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />
  }

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-surface-line">
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={`px-4 py-3 text-xs font-semibold text-ink-muted uppercase tracking-wider ${
                    col.align === 'right' ? 'text-right' : col.align === 'center' ? 'text-center' : 'text-left'
                  }`}
                >
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((row, idx) => (
              <tr
                key={rowKey(row)}
                className={`border-b border-surface-line last:border-0 hover:bg-white/5 transition-colors duration-100 ${
                  idx % 2 === 0 ? '' : 'bg-white/[0.03]'
                }`}
              >
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={`px-4 py-3 text-sm text-ink ${
                      col.align === 'right' ? 'text-right' : col.align === 'center' ? 'text-center' : 'text-left'
                    }`}
                  >
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hasMore && onLoadMore && (
        <div className="p-4 flex justify-center border-t border-surface-line">
          <button
            onClick={onLoadMore}
            disabled={loadingMore}
            className="avg-btn-secondary"
          >
            {loadingMore ? <Loader2 size={14} className="animate-spin" /> : null}
            Load more
          </button>
        </div>
      )}
    </div>
  )
}
