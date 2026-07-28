import { useState } from 'react'
import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Wallet as WalletIcon, ArrowDownToLine, TrendingUp, Loader2, AlertCircle } from 'lucide-react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import api from '../lib/api'
import { formatINR, formatDateTime, orDash } from '../lib/format'
import { apiErrorMessage } from '../lib/apiError'
import { StatCard } from '../components/ui/StatCard'
import { SkeletonCard } from '../components/ui/Skeleton'
import { DataTable, type Column } from '../components/ui/DataTable'
import { Badge } from '../components/ui/Badge'
import type { Wallet as WalletType, LedgerEntry, LedgerRes, Withdrawal, WithdrawalsRes, Me } from '../types/api'

const withdrawSchema = z.object({
  amountPaise: z
    .number()
    .int()
    .min(50000, 'Minimum withdrawal is ₹500'),
})
type WithdrawForm = z.infer<typeof withdrawSchema>

const MIN_PAISE = 50000 // ₹500

export default function WalletPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [withdrawError, setWithdrawError] = useState<string | null>(null)
  const [withdrawSuccess, setWithdrawSuccess] = useState(false)

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

  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm<WithdrawForm>({
    resolver: zodResolver(withdrawSchema),
  })

  const requestWithdrawal = useMutation({
    mutationFn: (data: WithdrawForm) =>
      api.post('/me/withdrawals', { amountPaise: data.amountPaise }),
    onSuccess: () => {
      setWithdrawSuccess(true)
      setWithdrawError(null)
      reset()
      qc.invalidateQueries({ queryKey: ['wallet'] })
      qc.invalidateQueries({ queryKey: ['me-withdrawals'] })
    },
    onError: (err) => {
      setWithdrawError(apiErrorMessage(err, t, t('wallet.withdrawFailed')))
    },
  })

  const onSubmit = (data: WithdrawForm) => {
    setWithdrawSuccess(false)
    setWithdrawError(null)
    // Friendly client-side guard so the user never hits the server's 409.
    if (data.amountPaise > withdrawablePaise) {
      setWithdrawError(t('wallet.exceedsBalance', { balance: formatINR(withdrawablePaise) }))
      return
    }
    requestWithdrawal.mutate(data)
  }

  const kycOk = me?.kycStatus === 'verified'
  const bankOk = me?.bankStatus === 'verified'
  const canWithdraw = kycOk && bankOk
  // Withdrawals draw from the withdrawable balance (funded at each weekly cutoff).
  // Below the ₹500 minimum there is nothing to withdraw yet.
  const withdrawablePaise = wallet?.withdrawablePaise ?? 0
  const hasFunds = withdrawablePaise >= MIN_PAISE

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
          r.status === 'requested' ? 'warning' :
          'neutral'
        }>
          {r.status}
        </Badge>
      )
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
          <div className="avg-card p-5">
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

      {/* Withdraw form */}
      <div className="avg-card p-5 space-y-4">
        <div className="flex items-center gap-2">
          <TrendingUp size={16} className="text-primary" />
          <h2 className="text-sm font-semibold text-ink">{t('wallet.requestWithdrawal')}</h2>
        </div>

        {!canWithdraw && (
          <div className="flex items-start gap-2 bg-warning/10 border border-warning/20 rounded-xl p-3">
            <AlertCircle size={14} className="text-warning shrink-0 mt-0.5" />
            <p className="text-xs text-ink-muted">
              {!kycOk && !bankOk
                ? t('wallet.kycBankRequired')
                : !kycOk
                  ? t('wallet.kycRequired')
                  : t('wallet.bankRequired')}
            </p>
          </div>
        )}

        {canWithdraw && !hasFunds && (
          <div className="flex items-start gap-2 bg-warning/10 border border-warning/20 rounded-xl p-3">
            <AlertCircle size={14} className="text-warning shrink-0 mt-0.5" />
            <p className="text-xs text-ink-muted">{t('wallet.noWithdrawableFunds')}</p>
          </div>
        )}

        {withdrawSuccess && (
          <div className="flex items-center gap-2 bg-success/10 text-success text-sm p-3 rounded-lg border border-success/20">
            {t('wallet.withdrawSuccess')}
          </div>
        )}
        {withdrawError && (
          <div className="flex items-center gap-2 bg-danger/10 text-danger text-sm p-3 rounded-lg border border-danger/20">
            <AlertCircle size={14} /> {withdrawError}
          </div>
        )}

        <form onSubmit={handleSubmit(onSubmit)} className="flex gap-3 items-end">
          <div className="flex-1 space-y-1">
            <label className="text-xs font-semibold text-ink-muted uppercase tracking-wider">
              {t('wallet.withdrawAmount')}
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-ink-muted">₹</span>
              <input
                type="number"
                step="1"
                min={MIN_PAISE / 100}
                placeholder="500"
                disabled={!canWithdraw || !hasFunds || isSubmitting}
                className="w-full rounded-lg border border-surface-line bg-[#10141F] pl-7 pr-3 py-2.5 text-sm text-ink placeholder:text-ink-muted/60 outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary disabled:opacity-50"
                {...register('amountPaise', {
                  setValueAs: (v) => v === '' ? undefined : Math.round(Number(v) * 100),
                })}
              />
            </div>
            {errors.amountPaise && (
              <p className="text-xs text-danger">{errors.amountPaise.message}</p>
            )}
            <p className="text-xs text-ink-muted">
              {t('wallet.withdrawableBalance')}: {orDash(wallet?.withdrawablePaise, formatINR)} · {t('wallet.minWithdrawal')}
            </p>
          </div>
          <button
            type="submit"
            disabled={!canWithdraw || !hasFunds || isSubmitting}
            className="avg-btn-primary py-2.5 px-5 flex items-center gap-1.5 whitespace-nowrap"
          >
            {isSubmitting ? <Loader2 size={14} className="animate-spin" /> : <ArrowDownToLine size={14} />}
            {t('wallet.withdraw')}
          </button>
        </form>
        <p className="text-xs text-ink-muted">{t('wallet.tdsNote')}</p>
      </div>

      {/* Withdrawal history */}
      {withdrawals.length > 0 && (
        <div className="avg-card">
          <div className="p-5 border-b border-surface-line">
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
