import { useEffect, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle, CheckCircle2, ChevronRight, Coins, Loader2, Search, X,
} from 'lucide-react'
import api from '../../lib/api'
import { formatINR } from '../../lib/format'
import { isWithinCampaign } from '../../lib/campaign'
import { ImageUploader, type ImageUploaderHandle, type UploadedImage } from '../../components/ui/ImageUploader'
import type { AdminMemberRow, AdminMembersPage, PresignRes } from '../../types/api'

// The two upgradeable campaign tiers.
const UPGRADE_TIERS = [
  { targetPaise: 3_000_000, label: '₹30,000', coins: 250 },
  { targetPaise: 5_000_000, label: '₹50,000', coins: 500 },
] as const

type UpgradeTier = (typeof UPGRADE_TIERS)[number]

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState<T>(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return debounced
}

/** Format paise as "₹X,XX,XXX" — reuses formatINR which already handles paise. */
function tierLabel(paise: number): string {
  if (paise >= 5_000_000) return '₹50,000'
  if (paise >= 3_000_000) return '₹30,000'
  return '₹10,000'
}

interface SuccessState {
  name: string
  tierLabel: string
  coins: number
}

export function UpgradeTab() {
  const { t } = useTranslation()
  const qc = useQueryClient()

  const [searchQ, setSearchQ] = useState('')
  const debouncedQ = useDebounce(searchQ, 300)
  const [selectedMember, setSelectedMember] = useState<AdminMemberRow | null>(null)
  const [selectedTier, setSelectedTier] = useState<UpgradeTier | null>(null)
  const [paymentRef, setPaymentRef] = useState('')
  const [proofImages, setProofImages] = useState<UploadedImage[]>([])
  const uploaderRef = useRef<ImageUploaderHandle>(null)
  const [submitError, setSubmitError] = useState('')
  const [successState, setSuccessState] = useState<SuccessState | null>(null)

  const { data: memberResults } = useQuery<AdminMembersPage>({
    queryKey: ['admin-members-search', debouncedQ],
    queryFn: () =>
      api
        .get(`/admin/members?q=${encodeURIComponent(debouncedQ)}&limit=10`)
        .then((r) => r.data),
    enabled: debouncedQ.length >= 2,
  })

  // Normalize raw packageValuePaise to the canonical tier floor.
  // Handles 31 early members who paid ₹11,800 (old GST price, raw = 1_180_000)
  // so they are treated as ₹10k members and the delta is ₹20,000, not ₹18,200.
  function canonicalTierPaise(raw: number): number {
    if (raw >= 5_000_000) return 5_000_000
    if (raw >= 3_000_000) return 3_000_000
    return 1_000_000  // ₹10k floor — matches tierLabel() default; upgrade is always FROM ₹10k
  }

  // Compute which tiers are available for the selected member.
  // Only offer tiers strictly above their current package value.
  const currentPaise = canonicalTierPaise(selectedMember?.packageValuePaise ?? 0)
  const availableTiers = UPGRADE_TIERS.filter((tier) => tier.targetPaise > currentPaise)
  const atTopTier = selectedMember !== null && currentPaise >= 5_000_000

  // Computed delta (what the member pays) for the selected tier.
  const deltaPaise = selectedTier ? Math.max(0, selectedTier.targetPaise - currentPaise) : 0

  function getPresign(file: File): Promise<PresignRes> {
    return api
      .post('/admin/orders/on-behalf/presign', {
        memberId: selectedMember!.id,
        contentType: file.type,
        sizeBytes: file.size,
      })
      .then((r) => r.data)
  }

  const submit = useMutation({
    mutationFn: async () => {
      const keys = uploaderRef.current ? await uploaderRef.current.upload() : []
      return api
        .post('/admin/members/upgrade', {
          memberId: selectedMember!.id,
          targetTierPaise: selectedTier!.targetPaise,
          paymentRef: paymentRef.trim(),
          proofKeys: keys,
        })
        .then((r) => r.data)
    },
    onSuccess: () => {
      setSuccessState({
        name: selectedMember!.name,
        tierLabel: selectedTier!.label,
        coins: selectedTier!.coins,
      })
      qc.invalidateQueries({ queryKey: ['admin-members-search'] })
      qc.invalidateQueries({ queryKey: ['admin-overview'] })
    },
    onError: (e: unknown) => {
      const err = e as { response?: { data?: { error?: string } }; message?: string }
      const raw = err.response?.data?.error ?? err.message ?? ''
      // Map known backend 409 messages to i18n keys.
      if (raw.toLowerCase().includes('not yet active'))
        setSubmitError(t('admin.upgrade.errorNotActive'))
      else if (raw.toLowerCase().includes('already at or above'))
        setSubmitError(t('admin.upgrade.errorAlreadyAtTier'))
      else if (raw.toLowerCase().includes('management'))
        setSubmitError(t('admin.upgrade.errorManagement'))
      else
        setSubmitError(t('admin.upgrade.errorGeneric'))
    },
  })

  function handleSubmit() {
    setSubmitError('')
    if (!selectedMember || !selectedTier || !paymentRef.trim()) return
    submit.mutate()
  }

  function reset() {
    setSearchQ('')
    setSelectedMember(null)
    setSelectedTier(null)
    setPaymentRef('')
    setProofImages([])
    setSubmitError('')
    setSuccessState(null)
  }

  // ── Success screen ─────────────────────────────────────────────────────────
  if (successState) {
    return (
      <div className="max-w-md mx-auto py-16 text-center space-y-5 animate-fade-in">
        <div className="w-20 h-20 bg-success/10 rounded-full flex items-center justify-center mx-auto">
          <CheckCircle2 size={40} className="text-success" />
        </div>
        <div>
          <h2 className="text-xl font-bold text-ink">{t('admin.upgrade.successTitle')}</h2>
          <p className="text-sm text-ink-muted mt-1">
            {t('admin.upgrade.successBody', {
              name: successState.name,
              tier: successState.tierLabel,
              coins: successState.coins,
            })}
          </p>
        </div>
        <div className="flex items-center justify-center gap-2 text-amber-400">
          <Coins size={18} />
          <span className="font-bold text-lg">{successState.coins} AVG Coins</span>
        </div>
        <button onClick={reset} className="avg-btn-primary px-6 py-2.5 mx-auto">
          {t('admin.upgrade.upgradeAnother')}
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Header */}
      <div>
        <h2 className="text-lg font-semibold text-ink">{t('admin.upgrade.title')}</h2>
        <p className="text-sm text-ink-muted mt-0.5">{t('admin.upgrade.subtitle')}</p>
      </div>

      {/* Campaign-ended warning (non-blocking) */}
      {!isWithinCampaign() && (
        <div className="flex items-start gap-2.5 rounded-xl p-3 bg-warning/8 border border-warning/20">
          <AlertTriangle size={14} className="shrink-0 mt-0.5 text-warning" />
          <p className="text-xs text-warning/90">{t('admin.upgrade.campaignEndedWarning')}</p>
        </div>
      )}

      {/* ── Step 1: Member picker ──────────────────────────────────────────── */}
      <div className="avg-card p-5 space-y-3">
        <h3 className="text-sm font-semibold text-ink">{t('admin.upgrade.step1')}</h3>

        {selectedMember ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between bg-white/5 rounded-xl px-4 py-3">
              <div>
                <p className="text-sm font-semibold text-ink">{selectedMember.name}</p>
                <p className="text-xs text-ink-muted">
                  {selectedMember.memberCode}
                  {selectedMember.email ? ` · ${selectedMember.email}` : ''}
                </p>
              </div>
              <button
                onClick={() => { setSelectedMember(null); setSelectedTier(null) }}
                className="p-1.5 rounded-lg hover:bg-white/10 text-ink-muted transition-colors"
                aria-label="Clear selection"
              >
                <X size={14} />
              </button>
            </div>
            {/* Current tier badge */}
            <div className="flex items-center gap-2 px-1">
              <span className="text-xs text-ink-muted">{t('admin.upgrade.currentTier')}:</span>
              <span className="text-xs font-semibold text-amber-400">
                {tierLabel(currentPaise)}
              </span>
              {!selectedMember.isActive && (
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-warning/10 text-warning">
                  Not Active
                </span>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted pointer-events-none" />
              <input
                value={searchQ}
                onChange={(e) => setSearchQ(e.target.value)}
                placeholder={t('admin.upgrade.searchPlaceholder')}
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
                {/* Current tier chip on each search result */}
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-400/10 text-amber-400 shrink-0">
                  {tierLabel(m.packageValuePaise)}
                </span>
                {m.isActive ? (
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-success/10 text-success shrink-0">
                    Active
                  </span>
                ) : (
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-warning/10 text-warning shrink-0">
                    Inactive
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        {/* Warn if not active (management may still upgrade, backend enforces) */}
        {selectedMember && !selectedMember.isActive && (
          <div className="flex items-start gap-2.5 rounded-xl p-3 bg-warning/8 border border-warning/20">
            <AlertTriangle size={13} className="shrink-0 mt-0.5 text-warning" />
            <p className="text-xs text-warning/90">{t('admin.upgrade.errorNotActive')}</p>
          </div>
        )}
      </div>

      {/* ── Step 2: Target tier picker ─────────────────────────────────────── */}
      {selectedMember && (
        <div className="avg-card p-5 space-y-3">
          <h3 className="text-sm font-semibold text-ink">{t('admin.upgrade.step2')}</h3>

          {atTopTier ? (
            <div className="flex items-start gap-2.5 rounded-xl p-3 bg-success/8 border border-success/20">
              <CheckCircle2 size={13} className="shrink-0 mt-0.5 text-success" />
              <p className="text-xs text-success/90">{t('admin.upgrade.alreadyTopTier')}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {availableTiers.map((tier) => {
                const delta = Math.max(0, tier.targetPaise - currentPaise)
                const isSelected = selectedTier?.targetPaise === tier.targetPaise
                return (
                  <button
                    key={tier.targetPaise}
                    onClick={() => setSelectedTier(isSelected ? null : tier)}
                    className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border transition-all text-left cursor-pointer ${
                      isSelected
                        ? 'border-primary/60 bg-primary/8'
                        : 'border-surface-line bg-white/5 hover:bg-white/10'
                    }`}
                  >
                    <div>
                      <p className="text-xs text-ink-muted">
                        {t('admin.upgrade.targetLabel')}: <span className="font-medium text-ink">{tier.label}</span>
                      </p>
                      <p className="text-base font-bold text-warning mt-0.5">
                        {t('admin.upgrade.deltaLabel')}: {formatINR(delta)}
                      </p>
                      <p className="text-xs text-ink-muted mt-0.5">
                        {t('admin.upgrade.coinsLabel')}: <span className="text-amber-400 font-semibold">{tier.coins}</span>
                      </p>
                    </div>
                    <ChevronRight
                      size={16}
                      className={`shrink-0 ml-2 transition-colors ${isSelected ? 'text-primary' : 'text-ink-muted'}`}
                    />
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Step 3: Payment reference ─────────────────────────────────────── */}
      {selectedMember && selectedTier && (
        <div className="avg-card p-5 space-y-4">
          <h3 className="text-sm font-semibold text-ink">{t('admin.upgrade.step3')}</h3>

          {/* Summary — amount to collect is shown first and largest */}
          <div className="bg-white/5 rounded-xl p-3 space-y-1.5 text-sm">
            <div className="flex justify-between items-center">
              <span className="text-ink-muted">{t('admin.upgrade.deltaLabel')}</span>
              <span className="font-bold text-warning text-base">{formatINR(deltaPaise)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-ink-muted">{t('admin.upgrade.targetLabel')}</span>
              <span className="font-semibold text-primary">{selectedTier.label}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-ink-muted">{t('admin.upgrade.coinsLabel')}</span>
              <span className="font-bold text-amber-400 flex items-center gap-1">
                <Coins size={12} /> {selectedTier.coins}
              </span>
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-ink">
              {t('admin.upgrade.paymentRefLabel')}{' '}
              <span className="text-danger">*</span>
            </label>
            <input
              value={paymentRef}
              onChange={(e) => setPaymentRef(e.target.value)}
              placeholder={t('admin.upgrade.paymentRefPlaceholder')}
              className="w-full bg-white/5 border border-surface-line rounded-xl px-4 py-2.5 text-sm text-ink placeholder-ink-muted outline-none focus:border-primary/60 transition-colors"
            />
          </div>

          <ImageUploader
            deferUpload
            ref={uploaderRef}
            maxFiles={5}
            value={proofImages}
            onChange={setProofImages}
            getPresign={getPresign}
            label={t('admin.upgrade.proofLabel')}
          />
        </div>
      )}

      {/* ── Submit ────────────────────────────────────────────────────────── */}
      {selectedMember && selectedTier && (
        <div className="space-y-3">
          {submitError && (
            <div className="flex items-center gap-2 bg-danger/10 border border-danger/30 rounded-xl p-3">
              <AlertTriangle size={14} className="text-danger shrink-0" />
              <p className="text-sm text-danger">{submitError}</p>
            </div>
          )}
          <button
            onClick={handleSubmit}
            disabled={submit.isPending || !paymentRef.trim()}
            className="avg-btn-primary w-full py-3 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submit.isPending && <Loader2 size={15} className="animate-spin" />}
            {t('admin.upgrade.submit')}
          </button>
        </div>
      )}
    </div>
  )
}
