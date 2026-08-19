import { useEffect, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  Search, CheckCircle2, AlertTriangle, Loader2, X, BadgeIndianRupee, MapPin, Pencil,
} from 'lucide-react'
import { z } from 'zod'
import api from '../../lib/api'
import { formatINR } from '../../lib/format'
import type { AdminMemberRow, AdminMembersPage, AdminProduct, OnBehalfRes, PresignRes, SystemSettings } from '../../types/api'
import { ImageUploader, type ImageUploaderHandle, type UploadedImage } from '../../components/ui/ImageUploader'

const addressSchema = z.object({
  recipientName: z.string().min(1, 'Recipient name is required'),
  phone:         z.string().min(10, 'Valid phone number is required'),
  line1:         z.string().min(1, 'Address line 1 is required'),
  line2:         z.string().optional(),
  city:          z.string().min(1, 'City is required'),
  state:         z.string().min(1, 'State is required'),
  pincode:       z.string().regex(/^\d{6}$/, 'Pincode must be exactly 6 digits'),
})
type AddressData = z.infer<typeof addressSchema>

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState<T>(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return debounced
}

export function RecordPaymentTab() {
  const { t } = useTranslation()
  const qc = useQueryClient()

  // ── form state ───────────────────────────────────────────────────────────
  const [searchQ, setSearchQ] = useState('')
  const debouncedQ = useDebounce(searchQ, 300)
  const [selectedMember, setSelectedMember] = useState<AdminMemberRow | null>(null)
  const [selectedProduct, setSelectedProduct] = useState<AdminProduct | null>(null)
  const [proofImages, setProofImages] = useState<UploadedImage[]>([])
  const [paymentRef, setPaymentRef] = useState('')
  const [submitError, setSubmitError] = useState('')
  const [successState, setSuccessState] = useState<OnBehalfRes | null>(null)
  const uploaderRef = useRef<ImageUploaderHandle>(null)

  // Address editing state (management can always edit)
  const [editingAddress, setEditingAddress] = useState(false)
  const [addrForm, setAddrForm] = useState<AddressData>({
    recipientName: '', phone: '', line1: '', line2: '', city: '', state: '', pincode: '',
  })
  const [addrErrors, setAddrErrors] = useState<Partial<Record<keyof AddressData, string>>>({})

  // ── queries ──────────────────────────────────────────────────────────────
  const { data: memberResults } = useQuery<AdminMembersPage>({
    queryKey: ['admin-members-search', debouncedQ],
    queryFn: () =>
      api
        .get(`/admin/members?q=${encodeURIComponent(debouncedQ)}&limit=10`)
        .then((r) => r.data),
    enabled: debouncedQ.length >= 2,
  })

  const { data: products = [] } = useQuery<AdminProduct[]>({
    queryKey: ['admin-products'],
    queryFn: () => api.get('/admin/products').then((r) => r.data),
  })

  const { data: settings } = useQuery<SystemSettings>({
    queryKey: ['admin-settings'],
    queryFn: () => api.get('/admin/settings').then((r) => r.data),
  })

  const activeProducts = products.filter((p) => p.active)

  // Whether the selected member currently has a complete address on file.
  const memberHasAddress = Boolean(selectedMember?.deliveryAddress?.recipientName)
  const addressOptional = Boolean(settings?.addressOptional)

  // ── presign (per file selection) ────────────────────────────────────────
  function getPresign(file: File): Promise<PresignRes> {
    return api
      .post('/admin/orders/on-behalf/presign', {
        memberId: selectedMember!.id,
        contentType: file.type,
        sizeBytes: file.size,
      })
      .then((r) => r.data)
  }

  // ── address save mutation ────────────────────────────────────────────────
  const saveAddress = useMutation({
    mutationFn: (data: AddressData) =>
      api.put(`/admin/members/${selectedMember!.id}/address`, data).then((r) => r.data),
    onSuccess: () => {
      // Refresh the search results so the member row shows the updated address.
      qc.invalidateQueries({ queryKey: ['admin-members-search'] })
      // Update the selected member locally to reflect the saved address immediately.
      setSelectedMember((prev) =>
        prev ? { ...prev, deliveryAddress: addrForm } : prev,
      )
      setEditingAddress(false)
    },
  })

  function handleSaveAddress() {
    const result = addressSchema.safeParse(addrForm)
    if (!result.success) {
      const errs: Partial<Record<keyof AddressData, string>> = {}
      for (const issue of result.error.issues) {
        const key = issue.path[0] as keyof AddressData
        if (!errs[key]) errs[key] = issue.message
      }
      setAddrErrors(errs)
      return
    }
    setAddrErrors({})
    saveAddress.mutate(result.data)
  }

  // ── submit mutation ──────────────────────────────────────────────────────
  const submit = useMutation({
    mutationFn: async () => {
      // Upload any staged proof images first, then submit.
      const keys = uploaderRef.current ? await uploaderRef.current.upload() : []
      return api
        .post<OnBehalfRes>('/admin/orders/on-behalf', {
          memberId: selectedMember!.id,
          productId: selectedProduct!.id,
          proofKeys: keys,
          paymentRef: paymentRef.trim(),
        })
        .then((r) => r.data)
    },
    onSuccess: (data) => {
      setSuccessState(data)
      qc.invalidateQueries({ queryKey: ['admin-orders'] })
      qc.invalidateQueries({ queryKey: ['admin-overview'] })
    },
    onError: (e: unknown) => {
      const err = e as { response?: { data?: { error?: string | Record<string, unknown> } }; message?: string }
      const raw = err.response?.data?.error
      const msg = typeof raw === 'string' ? raw : err.message ?? t('errors.generic')
      setSubmitError(msg)
    },
  })

  function handleSubmit() {
    setSubmitError('')
    if (!selectedMember || !selectedProduct || !paymentRef.trim()) return
    if (!addressOptional && !memberHasAddress) return
    submit.mutate()
  }

  function reset() {
    setSearchQ('')
    setSelectedMember(null)
    setSelectedProduct(null)
    setProofImages([])
    setPaymentRef('')
    setSubmitError('')
    setSuccessState(null)
    setEditingAddress(false)
    setAddrForm({ recipientName: '', phone: '', line1: '', line2: '', city: '', state: '', pincode: '' })
    setAddrErrors({})
  }

  // ── success screen ───────────────────────────────────────────────────────
  if (successState) {
    return (
      <div className="max-w-md mx-auto py-16 text-center space-y-5 animate-fade-in">
        <div className="w-20 h-20 bg-success/10 rounded-full flex items-center justify-center mx-auto">
          <CheckCircle2 size={40} className="text-success" />
        </div>
        <div>
          <h2 className="text-xl font-bold text-ink">
            {successState.activated
              ? t('admin.recordPayment.successActivated')
              : t('admin.recordPayment.successAlreadyActive')}
          </h2>
          <p className="text-sm text-ink-muted mt-1">
            {selectedMember?.name} · Order #{successState.orderId}
          </p>
        </div>
        <button onClick={reset} className="avg-btn-primary px-6 py-2.5 mx-auto">
          {t('admin.recordPayment.recordAnother')}
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Header */}
      <div>
        <h2 className="text-lg font-semibold text-ink">{t('admin.recordPayment.title')}</h2>
        <p className="text-sm text-ink-muted mt-0.5">{t('admin.recordPayment.subtitle')}</p>
      </div>

      {/* ── Step 1: Member picker ───────────────────────────────────────── */}
      <div className="avg-card p-5 space-y-3">
        <div className="flex items-center gap-2">
          <BadgeIndianRupee size={15} className="text-primary" />
          <h3 className="text-sm font-semibold text-ink">{t('admin.recordPayment.step1')}</h3>
        </div>

        {selectedMember ? (
          <div className="flex items-center justify-between bg-white/5 rounded-xl px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-ink">{selectedMember.name}</p>
              <p className="text-xs text-ink-muted">
                {selectedMember.memberCode}
                {selectedMember.email ? ` · ${selectedMember.email}` : ''}
              </p>
            </div>
            <button
              onClick={() => setSelectedMember(null)}
              className="p-1.5 rounded-lg hover:bg-white/10 text-ink-muted transition-colors"
              aria-label="Clear selection"
            >
              <X size={14} />
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted pointer-events-none" />
              <input
                value={searchQ}
                onChange={(e) => setSearchQ(e.target.value)}
                placeholder={t('admin.recordPayment.searchPlaceholder')}
                className="w-full bg-white/5 border border-surface-line rounded-xl pl-9 pr-3 py-2.5 text-sm text-ink placeholder-ink-muted outline-none focus:border-primary/60 transition-colors"
              />
            </div>
            {debouncedQ.length >= 2 && memberResults?.items.length === 0 && (
              <p className="text-xs text-ink-muted px-1">{t('admin.recordPayment.noResults')}</p>
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
                {m.isActive && (
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-success/10 text-success shrink-0">
                    Active
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        {/* Warn if the member is already active */}
        {selectedMember?.isActive && (
          <div
            className="flex items-start gap-2.5 rounded-xl p-3"
            style={{ background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.2)' }}
          >
            <AlertTriangle size={13} className="shrink-0 mt-0.5 text-warning" />
            <p className="text-xs text-warning/90">{t('admin.recordPayment.alreadyActiveWarning')}</p>
          </div>
        )}
      </div>

      {/* ── Step 1b: Delivery Address ──────────────────────────────────── */}
      {selectedMember && (
        <div className="avg-card p-5 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <MapPin size={15} className="text-primary" />
              <h3 className="text-sm font-semibold text-ink">{t('admin.recordPayment.addressTitle')}</h3>
            </div>
            {/* Management can always edit */}
            {memberHasAddress && !editingAddress && (
              <button
                onClick={() => {
                  const a = selectedMember.deliveryAddress!
                  setAddrForm({
                    recipientName: a.recipientName,
                    phone: a.phone,
                    line1: a.line1,
                    line2: a.line2 ?? '',
                    city: a.city,
                    state: a.state,
                    pincode: a.pincode,
                  })
                  setEditingAddress(true)
                }}
                className="flex items-center gap-1 text-xs text-primary hover:underline cursor-pointer"
              >
                <Pencil size={11} />
                {t('admin.recordPayment.addressEdit')}
              </button>
            )}
          </div>

          {/* Show existing address read-only (unless editing) */}
          {memberHasAddress && !editingAddress && selectedMember.deliveryAddress && (
            <div className="rounded-xl bg-white/5 border border-surface-line p-3 space-y-0.5 text-sm">
              <p className="font-semibold text-ink">{selectedMember.deliveryAddress.recipientName}</p>
              <p className="text-xs text-ink-muted">{selectedMember.deliveryAddress.phone}</p>
              <p className="text-xs text-ink-muted">{selectedMember.deliveryAddress.line1}{selectedMember.deliveryAddress.line2 ? `, ${selectedMember.deliveryAddress.line2}` : ''}</p>
              <p className="text-xs text-ink-muted">{selectedMember.deliveryAddress.city}, {selectedMember.deliveryAddress.state} — {selectedMember.deliveryAddress.pincode}</p>
            </div>
          )}

          {/* No address yet — warn and show form */}
          {(!memberHasAddress || editingAddress) && (
            <div className="space-y-3">
              {!memberHasAddress && (
                <div
                  className="flex items-start gap-2.5 rounded-xl p-3"
                  style={{ background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.2)' }}
                >
                  <AlertTriangle size={13} className="shrink-0 mt-0.5 text-warning" />
                  <p className="text-xs text-warning/90">{t('admin.recordPayment.addressMissing')}</p>
                </div>
              )}

              {/* Inline address form */}
              <div className="space-y-2">
                {(
                  [
                    { field: 'recipientName' as const, label: t('admin.recordPayment.addrRecipient'), placeholder: 'Full name' },
                    { field: 'phone' as const, label: t('admin.recordPayment.addrPhone'), placeholder: '10-digit mobile' },
                    { field: 'line1' as const, label: t('admin.recordPayment.addrLine1'), placeholder: 'Street / house / flat' },
                    { field: 'line2' as const, label: t('admin.recordPayment.addrLine2'), placeholder: 'Landmark (optional)' },
                    { field: 'city' as const, label: t('admin.recordPayment.addrCity'), placeholder: 'City' },
                    { field: 'state' as const, label: t('admin.recordPayment.addrState'), placeholder: 'State' },
                    { field: 'pincode' as const, label: t('admin.recordPayment.addrPincode'), placeholder: '6-digit pincode' },
                  ] as const
                ).map(({ field, label, placeholder }) => (
                  <div key={field} className="space-y-1">
                    <label className="block text-xs font-medium text-ink">{label}</label>
                    <input
                      value={addrForm[field] ?? ''}
                      onChange={(e) => setAddrForm((f) => ({ ...f, [field]: e.target.value }))}
                      placeholder={placeholder}
                      maxLength={field === 'pincode' ? 6 : undefined}
                      className="w-full bg-white/5 border border-surface-line rounded-xl px-3 py-2 text-sm text-ink placeholder-ink-muted outline-none focus:border-primary/60 transition-colors"
                    />
                    {addrErrors[field] && (
                      <p className="text-xs text-danger">{addrErrors[field]}</p>
                    )}
                  </div>
                ))}
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={handleSaveAddress}
                  disabled={saveAddress.isPending}
                  className="avg-btn-primary py-2 px-4 flex items-center gap-2 text-sm"
                >
                  {saveAddress.isPending && <Loader2 size={13} className="animate-spin" />}
                  {t('admin.recordPayment.addressSave')}
                </button>
                {editingAddress && (
                  <button
                    onClick={() => setEditingAddress(false)}
                    className="text-sm text-ink-muted hover:text-ink transition-colors cursor-pointer"
                  >
                    {t('admin.recordPayment.addressCancel')}
                  </button>
                )}
                {saveAddress.isError && (
                  <p className="text-xs text-danger">{t('errors.generic')}</p>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Step 2: Product picker ──────────────────────────────────────── */}
      {selectedMember && (
        <div className="avg-card p-5 space-y-3">
          <h3 className="text-sm font-semibold text-ink">{t('admin.recordPayment.step2')}</h3>
          <div className="space-y-2">
            {activeProducts.map((p) => (
              <button
                key={p.id}
                onClick={() =>
                  setSelectedProduct(selectedProduct?.id === p.id ? null : p)
                }
                className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border transition-all text-left cursor-pointer ${
                  selectedProduct?.id === p.id
                    ? 'border-primary/60 bg-primary/8'
                    : 'border-surface-line bg-white/5 hover:bg-white/10'
                }`}
              >
                <div>
                  <p className="text-sm font-medium text-ink">{p.name}</p>
                  {p.description && (
                    <p className="text-xs text-ink-muted mt-0.5 line-clamp-1">{p.description}</p>
                  )}
                </div>
                <p className="text-sm font-bold text-primary shrink-0 ml-3">
                  {formatINR(p.basePricePaise)}
                </p>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Step 3: Proof + payment reference ──────────────────────────── */}
      {selectedMember && selectedProduct && (
        <div className="avg-card p-5 space-y-5">
          <h3 className="text-sm font-semibold text-ink">{t('admin.recordPayment.step3')}</h3>

          {/* Optional proof upload */}
          <ImageUploader
            ref={uploaderRef}
            label={t('admin.recordPayment.proofLabel')}
            maxFiles={3}
            value={proofImages}
            onChange={setProofImages}
            getPresign={getPresign}
            deferUpload
          />

          {/* Required payment reference */}
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-ink">
              {t('admin.recordPayment.paymentRefLabel')}{' '}
              <span className="text-danger">*</span>
            </label>
            <input
              value={paymentRef}
              onChange={(e) => setPaymentRef(e.target.value)}
              placeholder={t('admin.recordPayment.paymentRefPlaceholder')}
              className="w-full bg-white/5 border border-surface-line rounded-xl px-4 py-2.5 text-sm text-ink placeholder-ink-muted outline-none focus:border-primary/60 transition-colors"
            />
          </div>
        </div>
      )}

      {/* ── Submit ─────────────────────────────────────────────────────── */}
      {selectedMember && selectedProduct && (
        <div className="space-y-3">
          {submitError && (
            <div className="flex items-center gap-2 bg-danger/10 border border-danger/30 rounded-xl p-3">
              <AlertTriangle size={14} className="text-danger shrink-0" />
              <p className="text-sm text-danger">{submitError}</p>
            </div>
          )}
          <button
            onClick={handleSubmit}
            disabled={submit.isPending || !paymentRef.trim() || (!addressOptional && !memberHasAddress)}
            className="avg-btn-primary w-full py-3 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submit.isPending && <Loader2 size={15} className="animate-spin" />}
            {t('admin.recordPayment.submit')}
          </button>
        </div>
      )}
    </div>
  )
}
