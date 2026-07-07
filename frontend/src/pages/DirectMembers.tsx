import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Info } from 'lucide-react'
import api from '../lib/api'
import { formatDate, orDash } from '../lib/format'
import { DataTable, type Column } from '../components/ui/DataTable'
import { Badge } from '../components/ui/Badge'
import type { DirectMember, NetworkSummary } from '../types/api'

export default function DirectMembers() {
  const { t } = useTranslation()
  const { data } = useQuery<{ items: DirectMember[] }>({
    queryKey: ['directs'],
    queryFn: () => api.get('/network/directs').then(r => r.data),
  })

  const directItems = data?.items ?? []

  const cols: Column<DirectMember>[] = [
    { key: 'code', header: 'Member Code', render: r => <span className="font-mono text-xs font-bold">{r.memberCode}</span> },
    { key: 'name', header: 'Name', render: r => <span className="font-medium">{r.name}</span> },
    { key: 'leg', header: 'Leg', render: r => <Badge variant={r.leg === 'L' ? 'primary' : 'violet'}>{r.leg === 'L' ? 'Left' : 'Right'}</Badge> },
    {
      key: 'active', header: t('counters.active'),
      render: r => r.isActive ? <Badge variant="success">Active</Badge> : <Badge variant="neutral">Inactive</Badge>
    },
    {
      key: 'qualified', header: t('counters.qualified'),
      render: r => r.isQualified ? <Badge variant="warning">Qualified</Badge> : <Badge variant="neutral">—</Badge>
    },
    { key: 'joined', header: 'Joined', render: r => <span className="text-xs text-ink-muted">{formatDate(r.joinedAt)}</span> },
  ]

  const { data: summary } = useQuery<NetworkSummary>({
    queryKey: ['network-summary'],
    queryFn: () => api.get('/network/summary').then((r) => r.data),
  })

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-ink">Direct Members</h1>
        <p className="text-sm text-ink-muted">Members you personally referred</p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="avg-card p-5">
          <p className="text-xs font-semibold text-ink-muted uppercase tracking-wider mb-1">Direct Left</p>
          <p className="text-2xl sm:text-3xl font-bold text-primary">{orDash(summary?.directs.left, String)}</p>
        </div>
        <div className="avg-card p-5">
          <p className="text-xs font-semibold text-ink-muted uppercase tracking-wider mb-1">Direct Right</p>
          <p className="text-2xl sm:text-3xl font-bold text-violet">{orDash(summary?.directs.right, String)}</p>
        </div>
      </div>

      <div className="flex items-center gap-2 bg-primary-50 border border-primary/20 rounded-xl p-3 text-xs text-ink-muted">
        <Info size={13} className="text-primary flex-shrink-0" />
        <span>
          <strong>{t('counters.active')}</strong> = activations in your leg. &nbsp;
          <strong>{t('counters.qualified')}</strong>: {t('counters.qualifiedTooltip')}
        </span>
      </div>

      <div className="avg-card">
        <div className="p-5 border-b border-surface-line">
          <h2 className="text-sm font-semibold text-ink">Your Direct Referrals</h2>
        </div>
        <DataTable
          columns={cols}
          data={directItems}
          rowKey={r => r.memberCode}
          emptyTitle="No direct members yet"
          emptyDescription="Share your referral link to add members"
        />
      </div>
    </div>
  )
}
