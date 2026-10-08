import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle, CheckCircle2, Coins, Loader2, Minus, Plus, Search, X,
} from 'lucide-react'
import api from '../../lib/api'
import type { AdminMemberCoins, AdminMembersPage, AdminMemberRow } from '../../types/api'

// ── local debounce (mirrors UpgradeTab) ─────────────────────────────────────
function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState<T>(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return debounced
}

type Mode = 'add' | 'deduct'

interface SuccessState {
  name: string
  delta: number
  newTotal: number
}

export function CoinsTab() {
  const { t } = useTranslation()
  const qc = useQueryClient()

  // member search
  const [searchQ, setSearchQ] = useState('')
  const debouncedQ = useDebounce(searchQ, 300)
  const [selectedMember, setSelectedMember] = useState<AdminMemberRow | null>(null)

  // form
  const [mode, setMode] = useState<Mode>('add')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [submitError, setSubmitError] = useState('')
  const [successState, setSuccessState] = useState<SuccessState | null>(null)

  // Member search results
  const { data: memberResults } = useQuery<AdminMembersPage>({
    queryKey: ['admin-members-search-coins', debouncedQ],
    queryFn: () =>
      api.get(`/admin/members?q=${encodeURIComponent(debouncedQ)}&limit=10`).then((r) => r.data),
    enabled: debouncedQ.length >= 2,
  })

  // Coin detail for selected member
  const { data: coinDetail, isLoading: loadingCoins } = useQuery<AdminMemberCoins>({
    queryKey: ['admin-member-coins', selectedMember?.id],
    queryFn: () =>
      api.get(`/admin/members/${selectedMember!.id}/coins`).then((r) => r.data),
    enabled: !!selectedMember,
  })

  const amountNum = parseInt(amount, 10)
  const validAmount = !Number.isNaN(amountNum) && amountNum > 0
  const currentTotal = coinDetail?.totalCoins ?? 0
  // guard: cannot deduct more than current balance
  const deductWouldGoBelowZero = mode === 'deduct' && validAmount && amountNum > currentTotal

  const submit = useMutation({
    mutationFn: () => {
      const delta = mode === 'deduct' ? -amountNum : amountNum
      return api
        .post(`/admin/members/${selectedMember!.id}/coins/adjust`, {
          delta,
          reason: reason.trim(),
        })
        .then((r) => r.data as { ok: boolean; totalCoins: number })
    },
    onSuccess: (data) => {
      const delta = mode === 'deduct' ? -amountNum : amountNum
      setSuccessState({
        name: selectedMember!.name,
        delta,
        newTotal: data.totalCoins,
      })
      qc.invalidateQueries({ queryKey: ['admin-member-coins', selectedMember?.id] })
      qc.invalidateQueries({ queryKey: ['me'] })
    },
    onError: (e: unknown) => {
      const err = e as { response?: { data?: { error?: string } }; message?: string }
      const raw = err.response?.data?.error ?? err.message ?? ''
      if (raw.toLowerCase().includes('negative'))
        setSubmitError(t('admin.coins.errorNegative'))
      else
        setSubmitError(t('admin.coins.errorGeneric'))
    },
  })

  function handleSubmit() {
    setSubmitError('')
    if (!selectedMember || !validAmount || !reason.trim() || deductWouldGoBelowZero) return
    submit.mutate()
  }

  function resetForm() {
    setAmount('')
    setReason('')
    setSubmitError('')
    setSuccessState(null)
    setMode('add')
  }

  function resetAll() {
    setSearchQ('')
    setSelectedMember(null)
    resetForm()
  }

  // ── success screen ──────────────────────────────────────────────────────────
  if (successState) {
    const isAdd = successState.delta > 0
    return (
      <div className="max-w-md mx-auto py-16 text-center space-y-5 animate-fade-in">
        <div className="w-20 h-20 bg-success/10 rounded-full flex items-center justify-center mx-auto">
          <CheckCircle2 size={40} className="text-success" />
        </div>
        <div>
          <h2 className="text-xl font-bold text-ink">{t('admin.coins.successTitle')}</h2>
          <p className="text-sm text-ink-muted mt-1">
            {isAdd
              ? t('admin.coins.successBodyAdd', { name: successState.name, coins: Math.abs(successState.delta) })
              : t('admin.coins.successBodyDeduct', { name: successState.name, coins: Math.abs(successState.delta) })}
          </p>
        </div>
        <div className="flex items-center justify-center gap-2 text-amber-400">
          <Coins size={18} />
          <span className="font-bold text-lg">
            {t('admin.coins.newTotal', { total: successState.newTotal })}
          </span>
        </div>
        <div className="flex gap-3 justify-center">
          <button
            onClick={resetForm}
            className="avg-btn-primary px-5 py-2.5"
          >
            {t('admin.coins.adjustAnother')}
          </button>
          <button
            onClick={resetAll}
            className="px-5 py-2.5 rounded-xl border border-surface-line text-sm text-ink-muted hover:text-ink transition-colors"
          >
            {t('admin.coins.changeMember')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Header */}
      <div>
        <h2 className="text-lg font-semibold text-ink">{t('admin.coins.title')}</h2>
        <p className="text-sm text-ink-muted mt-0.5">{t('admin.coins.subtitle')}</p>
      </div>

      {/* ── Step 1: Member picker (mirrors UpgradeTab exactly) ───────────── */}
      <div className="avg-card p-5 space-y-3">
        <h3 className="text-sm font-semibold text-ink">{t('admin.coins.step1')}</h3>

        {selectedMember ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between bg-white/5 rounded-xl px-4 py-3">
              <div>
                <p className="text-sm font-semibold text-ink">{selectedMember.name}</p>
                <p className="text-xs text-ink-muted">
                  {selectedMember.memberCode}
                  {selectedMember.email ? ` · ${selectedMember.email}` : ''}
                </p>
              </div>
              <button
                onClick={resetAll}
                className="p-1.5 rounded-lg hover:bg-white/10 text-ink-muted transition-colors"
                aria-label="Clear selection"
              >
                <X size={14} />
              </button>
            </div>

            {/* Current coin balance */}
            {loadingCoins ? (
              <div className="flex items-center gap-2 px-1 text-ink-muted">
                <Loader2 size={13} className="animate-spin" />
                <span className="text-xs">{t('admin.coins.loadingBalance')}</span>
              </div>
            ) : (
              <div className="flex items-center gap-2 px-1">
                <Coins size={14} className="text-amber-400" />
                <span className="text-xs text-ink-muted">{t('admin.coins.currentBalance')}:</span>
                <span className="text-sm font-bold text-amber-400">{currentTotal} AVG Coins</span>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted pointer-events-none" />
              <input
                value={searchQ}
                onChange={(e) => setSearchQ(e.target.value)}
                placeholder={t('admin.coins.searchPlaceholder')}
                className="w-full bg-white/5 border border-surface-line rounded-xl pl-9 pr-3 py-2.5 text-sm text-ink placeholder-ink-muted outline-none focus:border-primary/60 transition-colors"
              />
            </div>
            {debouncedQ.length >= 2 && memberResults?.items.length === 0 && (
              <p className="text-xs text-ink-muted px-1">{t('admin.upgrade.noResults')}</p>
            )}
            {memberResults?.items.map((m) => (
              <button
                key={m.id}
                onClick={() => { setSelectedMember(m); setSearchQ('') }}
                className="w-full flex items-center gap-3 px-4 py-2.5 rounded-xl bg-white/5 hover:bg-white/10 text-left transition-colors cursor-pointer"
              >
                <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-xs font-bold text-primary shrink-0">
                  {m.name[0]?.toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-ink truncate">{m.name}</p>
                  <p className="text-xs text-ink-muted">{m.memberCode}</p>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Step 2: Adjustment form ───────────────────────────────────────── */}
      {selectedMember && !loadingCoins && (
        <div className="avg-card p-5 space-y-4">
          <h3 className="text-sm font-semibold text-ink">{t('admin.coins.step2')}</h3>

          {/* Add / Deduct toggle */}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => { setMode('add'); setSubmitError('') }}
              className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl border text-sm font-semibold transition-all cursor-pointer ${
                mode === 'add'
                  ? 'border-success/60 bg-success/8 text-success'
                  : 'border-surface-line bg-white/5 text-ink-muted hover:text-ink'
              }`}
            >
              <Plus size={14} />
              {t('admin.coins.modeAdd')}
            </button>
            <button
              type="button"
              onClick={() => { setMode('deduct'); setSubmitError('') }}
              className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl border text-sm font-semibold transition-all cursor-pointer ${
                mode === 'deduct'
                  ? 'border-danger/60 bg-danger/8 text-danger'
                  : 'border-surface-line bg-white/5 text-ink-muted hover:text-ink'
              }`}
            >
              <Minus size={14} />
              {t('admin.coins.modeDeduct')}
            </button>
          </div>

          {/* Amount input */}
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-ink">
              {t('admin.coins.amountLabel')} <span className="text-danger">*</span>
            </label>
            <input
              type="number"
              min={1}
              max={mode === 'deduct' ? currentTotal : undefined}
              value={amount}
              onChange={(e) => { setAmount(e.target.value); setSubmitError('') }}
              placeholder={t('admin.coins.amountPlaceholder')}
              className="w-full bg-white/5 border border-surface-line rounded-xl px-4 py-2.5 text-sm text-ink placeholder-ink-muted outline-none focus:border-primary/60 transition-colors"
            />
            {mode === 'deduct' && validAmount && (
              <p className={`text-xs px-1 ${deductWouldGoBelowZero ? 'text-danger' : 'text-ink-muted'}`}>
                {deductWouldGoBelowZero
                  ? t('admin.coins.errorNegative')
                  : t('admin.coins.afterDeduct', { result: currentTotal - amountNum })}
              </p>
            )}
            {mode === 'add' && validAmount && (
              <p className="text-xs text-ink-muted px-1">
                {t('admin.coins.afterAdd', { result: currentTotal + amountNum })}
              </p>
            )}
          </div>

          {/* Reason */}
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-ink">
              {t('admin.coins.reasonLabel')} <span className="text-danger">*</span>
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('admin.coins.reasonPlaceholder')}
              rows={2}
              maxLength={280}
              className="w-full bg-white/5 border border-surface-line rounded-xl px-4 py-2.5 text-sm text-ink placeholder-ink-muted outline-none focus:border-primary/60 transition-colors resize-none"
            />
            <p className="text-xs text-ink-muted text-right px-1">{reason.length}/280</p>
          </div>
        </div>
      )}

      {/* ── Coin history (grants + adjustments) ─────────────────────────── */}
      {selectedMember && coinDetail && (coinDetail.grants.length > 0 || coinDetail.adjustments.length > 0) && (
        <div className="avg-card p-5 space-y-3">
          <h3 className="text-sm font-semibold text-ink">{t('admin.coins.historyTitle')}</h3>
          <div className="space-y-1.5 max-h-60 overflow-y-auto">
            {/* Campaign grants */}
            {coinDetail.grants.map((g) => (
              <div key={g.id} className="flex items-center justify-between text-xs px-3 py-2 rounded-lg bg-white/5">
                <div>
                  <span className="text-ink-muted">{t('admin.coins.historyGrant')}</span>
                  <span className="text-ink-muted ml-2">{new Date(g.grantedAt).toLocaleDateString()}</span>
                </div>
                <span className="font-semibold text-amber-400">+{g.coins}</span>
              </div>
            ))}
            {/* Manual adjustments */}
            {coinDetail.adjustments.map((a) => (
              <div key={a.id} className="flex items-start justify-between text-xs px-3 py-2 rounded-lg bg-white/5 gap-3">
                <div className="flex-1 min-w-0">
                  <span className="text-ink-muted">{t('admin.coins.historyAdjustment')}</span>
                  <span className="text-ink-muted ml-2">{new Date(a.createdAt).toLocaleDateString()}</span>
                  <p className="text-ink-muted truncate mt-0.5">{a.reason}</p>
                </div>
                <span className={`font-semibold shrink-0 ${a.delta > 0 ? 'text-success' : 'text-danger'}`}>
                  {a.delta > 0 ? '+' : ''}{a.delta}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Submit ──────────────────────────────────────────────────────── */}
      {selectedMember && !loadingCoins && (
        <div className="space-y-3">
          {submitError && (
            <div className="flex items-center gap-2 bg-danger/10 border border-danger/30 rounded-xl p-3">
              <AlertTriangle size={14} className="text-danger shrink-0" />
              <p className="text-sm text-danger">{submitError}</p>
            </div>
          )}
          <button
            onClick={handleSubmit}
            disabled={
              submit.isPending ||
              !validAmount ||
              !reason.trim() ||
              deductWouldGoBelowZero
            }
            className="avg-btn-primary w-full py-3 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submit.isPending && <Loader2 size={15} className="animate-spin" />}
            {mode === 'add'
              ? t('admin.coins.submitAdd', { coins: validAmount ? amountNum : '…' })
              : t('admin.coins.submitDeduct', { coins: validAmount ? amountNum : '…' })}
          </button>
        </div>
      )}
    </div>
  )
}
