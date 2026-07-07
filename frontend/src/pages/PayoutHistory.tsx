import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Clock, Info } from 'lucide-react'
import api from '../lib/api'
import { formatINR, formatDate } from '../lib/format'
import { DataTable, type Column } from '../components/ui/DataTable'
import { Badge } from '../components/ui/Badge'
import type { Payout } from '../types/api'

const statusVariant = (s: string) => {
  if (s === 'settled') return 'success'
  if (s === 'failed') return 'danger'
  if (s === 'sent') return 'primary'
  return 'warning'
}

export default function PayoutHistory() {
  const { t } = useTranslation()
  const { data } = useQuery<{ items: Payout[] }>({
    queryKey: ['payouts'],
    queryFn: () => api.get('/payouts').then(r => r.data),
  })

  const cols: Column<Payout>[] = [
    { key: 'date', header: 'Date', render: r => <span className="text-sm">{formatDate(r.date)}</span> },
    { key: 'gross', header: 'Gross Amount', align: 'right', render: r => <span className="font-semibold">{formatINR(r.grossPaise)}</span> },
    {
      key: 'tds', header: 'TDS (5%)', align: 'right',
      render: r => <span className="text-danger">{formatINR(r.tdsPaise)}</span>
    },
    { key: 'net', header: 'Net Paid', align: 'right', render: r => <span className="font-bold text-success">{formatINR(r.netPaise)}</span> },
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
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {[
          { label: 'Total Paid Out', value: formatINR((data?.items ?? []).filter(p => p.status === 'settled').reduce((a, b) => a + b.netPaise, 0)), color: 'text-success' },
          { label: 'TDS Deducted', value: formatINR((data?.items ?? []).reduce((a, b) => a + b.tdsPaise, 0)), color: 'text-danger' },
          { label: 'Pending', value: formatINR((data?.items ?? []).filter(p => p.status === 'pending').reduce((a, b) => a + b.netPaise, 0)), color: 'text-warning' },
        ].map(s => (
          <div key={s.label} className="avg-card p-4">
            <p className="text-xs font-semibold text-ink-muted uppercase tracking-wider mb-1">{s.label}</p>
            <p className={`text-xl font-bold ${s.color}`}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Table */}
      <div className="avg-card">
        <div className="p-5 border-b border-surface-line">
          <h2 className="text-sm font-semibold text-ink">Payout Transactions</h2>
        </div>
        <DataTable
          columns={cols}
          data={data?.items ?? []}
          rowKey={r => r.date + r.grossPaise}
          emptyTitle="No payouts yet"
        />
        <div className="p-4 border-t border-surface-line">
          <div className="flex items-center gap-2 text-xs text-ink-muted">
            <Clock size={12} />
            <span>Payouts processed every Saturday to KYC + bank-verified members.</span>
          </div>
          <div className="flex items-center gap-2 text-xs text-ink-muted mt-1">
            <Info size={12} />
            <span>{t('payout.tdsNote')}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
