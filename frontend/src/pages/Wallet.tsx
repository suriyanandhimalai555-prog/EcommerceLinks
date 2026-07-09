import { useState } from 'react'
import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Wallet as WalletIcon, ArrowUpRight, Clock, AlertCircle, Loader2 } from 'lucide-react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import api from '../lib/api'
import { formatINR, formatDateTime, orDash } from '../lib/format'
import { StatCard } from '../components/ui/StatCard'
import { SkeletonCard } from '../components/ui/Skeleton'
import { Modal } from '../components/ui/Modal'
import { DataTable, type Column } from '../components/ui/DataTable'
import { Badge } from '../components/ui/Badge'
import { FormField } from '../components/ui/FormField'
import type { Wallet as WalletType, LedgerEntry, LedgerRes, Withdrawal } from '../types/api'

const withdrawSchema = z.object({
  amount: z.number().min(500, 'Minimum withdrawal is ₹500'),
})
type WithdrawForm = z.infer<typeof withdrawSchema>

export default function Wallet() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [showModal, setShowModal] = useState(false)

  const { data: wallet, isLoading: walletLoading } = useQuery<WalletType>({
    queryKey: ['wallet'],
    queryFn: () => api.get('/wallet').then(r => r.data),
  })
  const { data: withdrawals } = useQuery<{ items: Withdrawal[] }>({
    queryKey: ['withdrawals'],
    queryFn: () => api.get('/withdrawals').then(r => r.data),
  })

  // Infinite query for ledger — replaces the mock-seeded useState + fake cursor
  const ledgerQ = useInfiniteQuery({
    queryKey: ['wallet-ledger'],
    queryFn: ({ pageParam }) =>
      api.get(`/wallet/ledger${pageParam ? `?cursor=${pageParam}` : ''}`).then(r => r.data as LedgerRes),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  })
  const ledgerItems = ledgerQ.data?.pages.flatMap(p => p.items) ?? []

  // Guard divide-by-zero: capPaise can be 0 on a fresh account
  const windowPct = wallet?.currentWindow && wallet.currentWindow.capPaise > 0
    ? Math.min(100, (wallet.currentWindow.earnedPaise / wallet.currentWindow.capPaise) * 100)
    : 0

  const { register, handleSubmit, formState: { errors }, setError, reset } = useForm<WithdrawForm>({
    resolver: zodResolver(withdrawSchema),
  })

  const withdraw = useMutation({
    mutationFn: (data: WithdrawForm) => api.post('/withdrawals', { amountPaise: data.amount * 100 }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['wallet'] })
      qc.invalidateQueries({ queryKey: ['withdrawals'] })
      qc.invalidateQueries({ queryKey: ['wallet-ledger'] })
      setShowModal(false)
      reset()
    },
    onError: (err: any) => {
      setError('root', { message: err.response?.data?.error?.message || 'Withdrawal failed' })
    },
  })

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

  const wdCols: Column<Withdrawal>[] = [
    { key: 'id', header: 'ID', render: r => <span className="font-mono text-xs">{r.id}</span> },
    { key: 'amount', header: 'Amount', render: r => <span className="font-semibold">{formatINR(r.amountPaise)}</span> },
    {
      key: 'status', header: 'Status',
      render: r => <Badge variant={r.status === 'done' ? 'success' : r.status === 'failed' ? 'danger' : 'warning'}>{r.status}</Badge>
    },
    { key: 'date', header: 'Requested', render: r => <span className="text-xs text-ink-muted">{formatDateTime(r.requestedAt)}</span> },
  ]

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold text-ink">Wallet</h1>
          <p className="text-sm text-ink-muted">Manage your earnings and withdrawals</p>
        </div>
        <button onClick={() => setShowModal(true)} className="avg-btn-primary sm:self-auto self-start">
          <ArrowUpRight size={15} /> {t('wallet.requestWithdrawal')}
        </button>
      </div>

      {/* Stat cards */}
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
            <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${windowPct >= 90 ? 'bg-danger' : windowPct >= 70 ? 'bg-warning' : 'bg-gradient-to-r from-primary to-violet'}`}
                style={{ width: `${windowPct}%` }}
              />
            </div>
            <p className="text-xs text-ink-muted mt-2">{t('wallet.capNote')}</p>
          </div>
        </div>
      )}

      {/* Ledger */}
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

      {/* Withdrawals */}
      <div className="avg-card">
        <div className="p-5 border-b border-surface-line">
          <h2 className="text-sm font-semibold text-ink">Withdrawal Requests</h2>
        </div>
        <DataTable
          columns={wdCols}
          data={withdrawals?.items ?? []}
          rowKey={r => r.id}
          emptyTitle="No withdrawals yet"
        />
      </div>

      {/* Withdrawal modal */}
      <Modal open={showModal} onClose={() => setShowModal(false)} title={t('wallet.requestWithdrawal')} size="sm">
        <form onSubmit={handleSubmit((d) => withdraw.mutate(d))} className="space-y-4">
          {errors.root && (
            <div className="flex items-center gap-2 bg-red-50 text-danger text-sm p-3 rounded-lg border border-danger/20">
              <AlertCircle size={14} /> {errors.root.message}
            </div>
          )}
          <FormField
            label="Amount (₹)"
            type="number"
            min={500}
            max={wallet ? wallet.balancePaise / 100 : undefined}
            placeholder="Enter amount in rupees"
            {...register('amount', { valueAsNumber: true })}
            error={errors.amount?.message}
            hint={`Available: ${orDash(wallet?.balancePaise, formatINR)} · ${t('wallet.minWithdrawal')}`}
          />
          <button type="submit" disabled={withdraw.isPending} className="avg-btn-primary w-full py-3">
            {withdraw.isPending ? <Loader2 size={15} className="animate-spin" /> : <ArrowUpRight size={15} />}
            Submit Withdrawal
          </button>
        </form>
      </Modal>
    </div>
  )
}
