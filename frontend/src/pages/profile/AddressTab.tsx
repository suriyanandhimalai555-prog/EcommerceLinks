import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Loader2, MapPin, Lock, AlertTriangle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { FormField } from '../../components/ui/FormField'
import api from '../../lib/api'
import type { Me } from '../../types/api'

const addressSchema = z.object({
  recipientName: z.string().min(1, 'Recipient name is required'),
  phone:         z.string().min(10, 'Valid phone number is required'),
  line1:         z.string().min(1, 'Address line 1 is required'),
  line2:         z.string().optional(),
  city:          z.string().min(1, 'City is required'),
  state:         z.string().min(1, 'State is required'),
  pincode:       z.string().regex(/^\d{6}$/, 'Pincode must be exactly 6 digits'),
})

type AddressFormData = z.infer<typeof addressSchema>

export function AddressTab() {
  const { t } = useTranslation()
  const qc = useQueryClient()

  const { data: me } = useQuery<Me>({
    queryKey: ['me'],
    queryFn: () => api.get('/me').then((r) => r.data),
  })

  const existing = me?.deliveryAddress

  const form = useForm<AddressFormData>({
    resolver: zodResolver(addressSchema),
    defaultValues: {
      recipientName: '',
      phone: '',
      line1: '',
      line2: '',
      city: '',
      state: '',
      pincode: '',
    },
  })

  const mutation = useMutation({
    mutationFn: (data: AddressFormData) => api.put('/me/address', data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['me'] })
    },
  })

  // ── Already set: show read-only locked view ──────────────────────────────
  if (existing) {
    return (
      <div className="avg-card p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Lock size={15} className="text-ink-muted" />
          <h3 className="text-sm font-semibold text-ink">{t('profile.address.lockedTitle')}</h3>
        </div>

        <div className="rounded-xl bg-white/5 border border-surface-line p-4 space-y-1.5 text-sm text-ink">
          <p className="font-semibold">{existing.recipientName}</p>
          <p className="text-ink-muted">{existing.phone}</p>
          <p>{existing.line1}</p>
          {existing.line2 && <p>{existing.line2}</p>}
          <p>{existing.city}, {existing.state} — {existing.pincode}</p>
        </div>

        <div
          className="flex items-start gap-2.5 rounded-xl p-3"
          style={{ background: 'rgba(148,163,184,0.06)', border: '1px solid rgba(148,163,184,0.15)' }}
        >
          <Lock size={13} className="shrink-0 mt-0.5 text-ink-muted" />
          <p className="text-xs text-ink-muted">{t('profile.address.lockedNotice')}</p>
        </div>
      </div>
    )
  }

  // ── Not yet set: show the one-time entry form ────────────────────────────
  return (
    <div className="avg-card p-5 space-y-4">
      <div className="flex items-center gap-2">
        <MapPin size={15} className="text-primary" />
        <h3 className="text-sm font-semibold text-ink">{t('profile.address.title')}</h3>
      </div>
      <p className="text-xs text-ink-muted">{t('profile.address.hint')}</p>

      {mutation.isSuccess ? (
        <div className="rounded-xl bg-success/10 border border-success/20 p-4 text-sm text-success font-medium">
          {t('profile.address.saved')}
        </div>
      ) : (
        <form
          onSubmit={form.handleSubmit((data) => mutation.mutate(data))}
          className="space-y-4"
        >
          <FormField
            label={t('profile.address.recipientName')}
            placeholder={t('profile.address.recipientNamePlaceholder')}
            {...form.register('recipientName')}
            error={form.formState.errors.recipientName?.message}
          />
          <FormField
            label={t('profile.address.phone')}
            placeholder={t('profile.address.phonePlaceholder')}
            {...form.register('phone')}
            error={form.formState.errors.phone?.message}
          />
          <FormField
            label={t('profile.address.line1')}
            placeholder={t('profile.address.line1Placeholder')}
            {...form.register('line1')}
            error={form.formState.errors.line1?.message}
          />
          <FormField
            label={t('profile.address.line2')}
            placeholder={t('profile.address.line2Placeholder')}
            {...form.register('line2')}
            error={form.formState.errors.line2?.message}
          />
          <div className="grid grid-cols-2 gap-3">
            <FormField
              label={t('profile.address.city')}
              placeholder={t('profile.address.cityPlaceholder')}
              {...form.register('city')}
              error={form.formState.errors.city?.message}
            />
            <FormField
              label={t('profile.address.state')}
              placeholder={t('profile.address.statePlaceholder')}
              {...form.register('state')}
              error={form.formState.errors.state?.message}
            />
          </div>
          <FormField
            label={t('profile.address.pincode')}
            placeholder="600001"
            maxLength={6}
            {...form.register('pincode')}
            error={form.formState.errors.pincode?.message}
          />

          {/* Big one-time warning — always visible before save */}
          <div
            className="rounded-2xl p-4 space-y-2"
            style={{
              background: 'rgba(251,191,36,0.10)',
              border: '2px solid rgba(251,191,36,0.50)',
            }}
          >
            <div className="flex items-center gap-2">
              <AlertTriangle size={18} className="text-warning shrink-0" />
              <p className="text-sm font-bold text-warning">{t('profile.address.warningTitle')}</p>
            </div>
            <p className="text-sm text-warning/90 leading-relaxed">
              {t('profile.address.warningBody')}
            </p>
          </div>

          {mutation.isError && (
            <p className="text-xs text-danger">
              {t('errors.generic')}
            </p>
          )}

          <button
            type="submit"
            disabled={mutation.isPending}
            className="avg-btn-primary flex items-center gap-2"
          >
            {mutation.isPending ? <Loader2 size={14} className="animate-spin" /> : null}
            {t('profile.address.save')}
          </button>
        </form>
      )}
    </div>
  )
}
