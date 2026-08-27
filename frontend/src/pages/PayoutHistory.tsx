import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Clock, Info } from 'lucide-react'
import api from '../lib/api'
import { formatINR, formatDate } from '../lib/format'
import { DataTable, type Column } from '../components/ui/DataTable'
import { Badge } from '../components/ui/Badge'
import { Skeleton } from '../components/ui/Skeleton'
import { EmptyState } from '../components/ui/EmptyState'
import type { Payout } from '../types/api'

const statusVariant = (s: string) => {
  if (s === 'paid') return 'success'
  if (s === 'rejected') return 'danger'
  if (s === 'approved') return 'primary'
  return 'warning' // pending | requested
}

export default function PayoutHistory() {
  const { t } = useTranslation()
  const { data, isLoading } = useQuery<{ items: Payout[] }>({
    queryKey: ['payouts'],
    queryFn: () => api.get('/payouts').then(r => r.data),
  })

  const items = data?.items ?? []

  const cols: Column<Payout>[] = [
    { key: 'date', header: 'Date', render: r => <span className="text-sm">{formatDate(r.date)}</span> },
    { key: 'gross', header: 'Gross Amount', align: 'right', render: r => <span className="font-semibold">{formatINR(r.grossPaise)}</span> },
    {
      key: 'tds', header: 'TDS (10%)', align: 'right',
      render: r => r.tdsPaise != null
        ? <span className="text-danger">{formatINR(r.tdsPaise)}</span>
        : <span className="text-ink-muted text-xs">—</span>
    },
    {
      key: 'net', header: 'Net Paid', align: 'right',
      render: r => r.netPaise != null
        ? <span className="font-bold text-success">{formatINR(r.netPaise)}</span>
        : <span className="text-ink-muted text-xs">—</span>
    },
    {
      key: 'status', header: 'Status',
      render: r => <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
    },
    {
      key: 'ref', header: 'Bank Ref',
      render: r => r.bankRef
        ? <span className="font-mono text-xs text-ink-muted">{r.bankRef}</span>
        : <span className="text-ink-muted text-xs">—</span>
    },
  ]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-ink">Payout History</h1>
        <p className="text-sm text-ink-muted">All your bank payouts and TDS details</p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Total Paid Out', value: formatINR(items.filter(p => p.status === 'paid').reduce((a, b) => a + (b.netPaise ?? 0), 0)), color: 'text-success' },
          { label: 'TDS Deducted', value: formatINR(items.filter(p => p.status === 'paid').reduce((a, b) => a + (b.tdsPaise ?? 0), 0)), color: 'text-danger' },
          { label: 'Pending', value: formatINR(items.filter(p => p.status === 'pending' || p.status === 'requested').reduce((a, b) => a + b.grossPaise, 0)), color: 'text-warning' },
        ].map(s => (
          <div key={s.label} className="avg-card p-3 sm:p-4">
            <p className="text-[10px] sm:text-xs font-semibold text-ink-muted uppercase tracking-wider mb-1 leading-tight">{s.label}</p>
            <p className={`text-base sm:text-xl font-bold ${s.color}`}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Payout list */}
      <div className="avg-card">
        <div className="p-4 sm:p-5 border-b border-surface-line">
          <h2 className="text-sm font-semibold text-ink">Payout Transactions</h2>
        </div>

        {/* Mobile card list — hidden on sm+ */}
        <div className="sm:hidden">
          {isLoading ? (
            <div className="space-y-3 p-4">
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-24 w-full" />)}
            </div>
          ) : items.length === 0 ? (
            <EmptyState title="No payouts yet" />
          ) : (
            <ul className="divide-y divide-surface-line">
              {items.map((r, idx) => (
                <li key={r.date + r.grossPaise + idx} className="p-4 space-y-2">
                  {/* Top row: date (left) + amount + badge (right) */}
                  <div className="flex items-start justify-between gap-3">
                    <span className="text-sm font-medium text-ink mt-0.5">{formatDate(r.date)}</span>
                    <div className="flex flex-col items-end gap-1">
                      <span className="text-lg font-bold text-ink">{formatINR(r.grossPaise)}</span>
                      <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
                    </div>
                  </div>

                  {/* Breakdown — only shown when paid (tdsPaise/netPaise become non-null) */}
                  {r.netPaise != null && (
                    <div className="border-t border-surface-line pt-2 space-y-1">
                      <div className="flex items-center gap-2 text-xs">
                        <span className="text-ink-muted">TDS</span>
                        <span className="font-semibold text-danger">{formatINR(r.tdsPaise ?? 0)}</span>
                        <span className="text-ink-muted">·</span>
                        <span className="text-ink-muted">Net</span>
                        <span className="font-bold text-success">{formatINR(r.netPaise)}</span>
                      </div>
                      {r.bankRef && (
                        <div className="flex items-center gap-1.5">
                          <span className="text-[10px] font-semibold text-ink-muted uppercase tracking-wider">Ref:</span>
                          <span className="font-mono text-xs text-ink-muted truncate">{r.bankRef}</span>
                        </div>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Desktop table — hidden on mobile */}
        <div className="hidden sm:block">
          <DataTable
            columns={cols}
            data={items}
            loading={isLoading}
            rowKey={r => r.date + r.grossPaise}
            emptyTitle="No payouts yet"
          />
        </div>

        <div className="p-4 border-t border-surface-line space-y-1">
          <div className="flex items-start gap-2 text-xs text-ink-muted">
            <Clock size={12} className="mt-0.5 shrink-0" />
            <span>Payouts processed every Saturday to KYC + bank-verified members.</span>
          </div>
          <div className="flex items-start gap-2 text-xs text-ink-muted">
            <Info size={12} className="mt-0.5 shrink-0" />
            <span>{t('payout.tdsNote')}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
