import { useQuery, useInfiniteQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Wallet as WalletIcon, ArrowDownToLine, AlertCircle, Clock, CheckCircle2, XCircle } from 'lucide-react'
import { Link } from 'react-router-dom'
import api from '../lib/api'
import { formatINR, formatDateTime, orDash } from '../lib/format'
import { StatCard } from '../components/ui/StatCard'
import { SkeletonCard } from '../components/ui/Skeleton'
import { DataTable, type Column } from '../components/ui/DataTable'
import { Badge } from '../components/ui/Badge'
import type { Wallet as WalletType, LedgerEntry, LedgerRes, Withdrawal, WithdrawalsRes, Me } from '../types/api'

export default function WalletPage() {
  const { t } = useTranslation()

  const { data: me } = useQuery<Me>({
    queryKey: ['me'],
    queryFn: () => api.get('/me').then(r => r.data),
  })

  const { data: wallet, isLoading: walletLoading } = useQuery<WalletType>({
    queryKey: ['wallet'],
    queryFn: () => api.get('/wallet').then(r => r.data),
  })

  const { data: withdrawalsData } = useQuery<WithdrawalsRes>({
    queryKey: ['me-withdrawals'],
    queryFn: () => api.get('/me/withdrawals').then(r => r.data),
  })
  const withdrawals = withdrawalsData?.items ?? []

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

  const kycOk = me?.kycStatus === 'verified'
  const bankOk = me?.bankStatus === 'verified'
  const bothVerified = kycOk && bankOk

  const ledgerCols: Column<LedgerEntry>[] = [
    { key: 'date', header: t('wallet.date'), render: r => <span className="text-xs text-ink-muted">{formatDateTime(r.at)}</span> },
    { key: 'desc', header: t('wallet.description'), render: r => <span className="font-medium">{r.description}</span> },
    {
      key: 'type', header: t('wallet.type'),
      render: r => <Badge variant={
        r.refType === 'pair' ? 'success' :
        r.refType === 'payout' ? 'primary' :
        r.refType === 'sweep' || r.refType === 'wsweep' ? 'warning' :
        r.refType === 'withdrawal' ? 'danger' :
        'neutral'
      }>
        {r.refType === 'wsweep' ? 'sweep' : r.refType}
      </Badge>
    },
    {
      key: 'amount', header: t('wallet.amount'), align: 'right',
      render: r => <span className={`font-bold ${r.direction === 'credit' ? 'text-success' : 'text-danger'}`}>
        {r.direction === 'credit' ? '+' : '-'}{formatINR(r.amountPaise)}
      </span>
    },
  ]

  const withdrawalCols: Column<Withdrawal>[] = [
    { key: 'date', header: t('wallet.date'), render: r => <span className="text-xs text-ink-muted">{formatDateTime(r.requestedAt)}</span> },
    {
      key: 'amount', header: t('wallet.amount'), align: 'right',
      render: r => <span className="font-bold">{formatINR(r.amountPaise)}</span>
    },
    {
      key: 'net', header: t('wallet.net'), align: 'right',
      render: r => r.netPaise != null
        ? <span className="text-sm text-ink-muted">{formatINR(r.netPaise)}</span>
        : <span className="text-ink-muted">—</span>
    },
    {
      key: 'status', header: t('wallet.status'),
      render: r => (
        <Badge variant={
          r.status === 'paid' ? 'success' :
          r.status === 'rejected' ? 'danger' :
          r.status === 'pending' ? 'warning' :
          'neutral'
        }>
          {r.status === 'pending' ? t('wallet.statusPending') :
           r.status === 'paid' ? t('wallet.statusPaid') :
           r.status === 'rejected' ? t('wallet.statusRejected') :
           r.status}
        </Badge>
      )
    },
    {
      key: 'proof', header: t('wallet.proof'),
      render: r => r.status === 'paid' && r.proofUrls?.length
        ? (
          <div className="flex gap-1.5 flex-wrap">
            {r.proofUrls.map((url, i) => (
              <a key={i} href={url} target="_blank" rel="noreferrer">
                <img
                  src={url}
                  alt={t('wallet.proofAlt', { n: i + 1 })}
                  className="w-10 h-10 rounded object-cover border border-surface-line hover:opacity-80 transition-opacity"
                />
              </a>
            ))}
          </div>
        )
        : <span className="text-ink-muted">—</span>
    },
  ]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-ink">{t('wallet.title')}</h1>
        <p className="text-sm text-ink-muted">{t('wallet.subtitle')}</p>
      </div>

      {walletLoading ? (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
          <SkeletonCard /><SkeletonCard /><SkeletonCard />
        </div>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
          <StatCard
            label={t('wallet.earnings')}
            value={orDash(wallet?.balancePaise, formatINR)}
            icon={<WalletIcon />}
            tint="violet"
            sub={t('wallet.earningsHint')}
          />
          <StatCard
            label={t('wallet.withdrawable')}
            value={orDash(wallet?.withdrawablePaise, formatINR)}
            icon={<ArrowDownToLine />}
            tint="success"
            sub={t('wallet.withdrawableHint')}
          />
          <div className="avg-card p-5 col-span-2 lg:col-span-1">
            <div className="flex items-center justify-between mb-3">
              <div>
                <p className="text-xs font-semibold text-ink-muted uppercase tracking-wider mb-1">{t('wallet.currentWindow')}</p>
                <p className="text-lg font-bold text-ink">{orDash(wallet?.currentWindow?.earnedPaise, formatINR)}</p>
                <p className="text-xs text-ink-muted">{t('wallet.capOf', { cap: orDash(wallet?.currentWindow?.capPaise, formatINR) })}</p>
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

      {/* Payout info / KYC–bank prompt */}
      <div className="avg-card p-5 space-y-3">
        <div className="flex items-center gap-2">
          <CheckCircle2 size={16} className="text-primary" />
          <h2 className="text-sm font-semibold text-ink">{t('wallet.autoPayout')}</h2>
        </div>
        <p className="text-xs text-ink-muted">{t('wallet.autoPayoutDesc')}</p>

        {!bothVerified && (
          <div className="flex items-start gap-2 bg-warning/10 border border-warning/20 rounded-xl p-3">
            <AlertCircle size={14} className="text-warning shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="text-xs text-ink-muted">
                {!kycOk && !bankOk
                  ? t('wallet.kycBankRequired')
                  : !kycOk
                    ? t('wallet.kycRequired')
                    : t('wallet.bankRequired')}
              </p>
              <Link to="/profile" className="text-xs font-semibold text-primary underline underline-offset-2">
                {t('wallet.completeProfile')}
              </Link>
            </div>
          </div>
        )}

        {bothVerified && (
          <div className="flex items-center gap-2 bg-success/10 border border-success/20 rounded-xl p-3">
            <CheckCircle2 size={13} className="text-success shrink-0" />
            <p className="text-xs text-ink-muted">{t('wallet.eligibleForPayout')}</p>
          </div>
        )}

        <p className="text-xs text-ink-muted">{t('wallet.tdsNote')}</p>
      </div>

      {/* Payout history */}
      {withdrawals.length > 0 && (
        <div className="avg-card">
          <div className="p-5 border-b border-surface-line flex items-center gap-2">
            <Clock size={14} className="text-ink-muted" />
            <h2 className="text-sm font-semibold text-ink">{t('wallet.withdrawalHistory')}</h2>
          </div>
          <DataTable
            columns={withdrawalCols}
            data={withdrawals}
            rowKey={r => r.id}
            emptyTitle={t('wallet.noWithdrawals')}
          />
        </div>
      )}

      {withdrawals.length === 0 && !walletLoading && (
        <div className="avg-card p-8 text-center">
          <XCircle size={28} className="text-ink-muted mx-auto mb-2 opacity-40" />
          <p className="text-sm text-ink-muted">{t('wallet.noWithdrawals')}</p>
        </div>
      )}

      {/* Transaction ledger */}
      <div className="avg-card">
        <div className="p-5 border-b border-surface-line">
          <h2 className="text-sm font-semibold text-ink">{t('wallet.ledger')}</h2>
        </div>
        <DataTable
          columns={ledgerCols}
          data={ledgerItems}
          rowKey={r => r.at + r.description}
          onLoadMore={() => ledgerQ.fetchNextPage()}
          hasMore={!!ledgerQ.hasNextPage}
          emptyTitle={t('wallet.noTransactions')}
        />
      </div>
    </div>
  )
}
