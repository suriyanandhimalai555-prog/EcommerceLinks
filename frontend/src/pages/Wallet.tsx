import { useQuery, useInfiniteQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Wallet as WalletIcon, Clock } from 'lucide-react'
import api from '../lib/api'
import { formatINR, formatDateTime, orDash } from '../lib/format'
import { StatCard } from '../components/ui/StatCard'
import { SkeletonCard } from '../components/ui/Skeleton'
import { DataTable, type Column } from '../components/ui/DataTable'
import { Badge } from '../components/ui/Badge'
import type { Wallet as WalletType, LedgerEntry, LedgerRes } from '../types/api'

export default function Wallet() {
  const { t } = useTranslation()

  const { data: wallet, isLoading: walletLoading } = useQuery<WalletType>({
    queryKey: ['wallet'],
    queryFn: () => api.get('/wallet').then(r => r.data),
  })

  const ledgerQ = useInfiniteQuery({
    queryKey: ['wallet-ledger'],
    queryFn: ({ pageParam }) =>
      api.get(`/wallet/ledger${pageParam ? `?cursor=${pageParam}` : ''}`).then(r => r.data as LedgerRes),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  })
  const ledgerItems = ledgerQ.data?.pages.flatMap(p => p.items) ?? []

  const windowPct = wallet?.currentWindow && wallet.currentWindow.capPaise > 0
    ? Math.min(100, (wallet.currentWindow.earnedPaise / wallet.currentWindow.capPaise) * 100)
    : 0

  const ledgerCols: Column<LedgerEntry>[] = [
    { key: 'date', header: 'Date', render: r => <span className="text-xs text-ink-muted">{formatDateTime(r.at)}</span> },
    { key: 'desc', header: 'Description', render: r => <span className="font-medium">{r.description}</span> },
    {
      key: 'type', header: 'Type',
      render: r => <Badge variant={r.refType === 'pair' ? 'success' : r.refType === 'payout' ? 'primary' : r.refType === 'sweep' ? 'warning' : 'neutral'}>
        {r.refType}
      </Badge>
    },
    {
      key: 'amount', header: 'Amount', align: 'right',
      render: r => <span className={`font-bold ${r.direction === 'credit' ? 'text-success' : 'text-danger'}`}>
        {r.direction === 'credit' ? '+' : '-'}{formatINR(r.amountPaise)}
      </span>
    },
  ]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-ink">Wallet</h1>
        <p className="text-sm text-ink-muted">{t('wallet.deferred')}</p>
      </div>

      {walletLoading ? (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
          <SkeletonCard /><SkeletonCard /><SkeletonCard />
        </div>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
          <StatCard label="Available Balance" value={orDash(wallet?.balancePaise, formatINR)} icon={<WalletIcon />} tint="violet" />
          <StatCard label="Deferred Balance" value={orDash(wallet?.deferredPaise, formatINR)} icon={<Clock />} tint="warning"
            sub={t('wallet.deferred')} />
          <div className="avg-card p-5 lg:col-span-1 col-span-2">
            <div className="flex items-center justify-between mb-3">
              <div>
                <p className="text-xs font-semibold text-ink-muted uppercase tracking-wider mb-1">Current Window</p>
                <p className="text-lg font-bold text-ink">{orDash(wallet?.currentWindow?.earnedPaise, formatINR)}</p>
                <p className="text-xs text-ink-muted">of {orDash(wallet?.currentWindow?.capPaise, formatINR)} cap</p>
              </div>
              <div className="text-right">
                <p className="text-2xl font-bold text-primary">{wallet ? windowPct.toFixed(1) + '%' : '—'}</p>
              </div>
            </div>
            <div className="h-2 bg-white/10 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${windowPct >= 90 ? 'bg-danger' : windowPct >= 70 ? 'bg-warning' : 'bg-gradient-to-r from-primary to-violet'}`}
                style={{ width: `${windowPct}%` }}
              />
            </div>
            <p className="text-xs text-ink-muted mt-2">{t('wallet.capNote')}</p>
          </div>
        </div>
      )}

      <div className="avg-card">
        <div className="p-5 border-b border-surface-line">
          <h2 className="text-sm font-semibold text-ink">Transaction Ledger</h2>
        </div>
        <DataTable
          columns={ledgerCols}
          data={ledgerItems}
          rowKey={r => r.at + r.description}
          onLoadMore={() => ledgerQ.fetchNextPage()}
          hasMore={!!ledgerQ.hasNextPage}
          emptyTitle="No transactions yet"
        />
      </div>
    </div>
  )
}
