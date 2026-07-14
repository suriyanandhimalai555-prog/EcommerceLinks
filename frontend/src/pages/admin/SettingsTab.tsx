import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ShieldCheck, AlertCircle, Loader2 } from 'lucide-react'
import api from '../../lib/api'
import type { SystemSettings } from '../../types/api'

export function SettingsTab() {
  const { t } = useTranslation()
  const qc = useQueryClient()

  const { data: settings, isPending } = useQuery<SystemSettings>({
    queryKey: ['admin-settings'],
    queryFn: () => api.get('/admin/settings').then((r) => r.data),
  })

  const update = useMutation({
    mutationFn: (kycOptional: boolean) =>
      api.patch('/admin/settings', { kycOptional }).then((r) => r.data),
    onSuccess: () => {
      // Refresh settings and me (kycMandatory changes for all members)
      qc.invalidateQueries({ queryKey: ['admin-settings'] })
      qc.invalidateQueries({ queryKey: ['me'] })
    },
  })

  const kycOptional = settings?.kycOptional ?? false

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h2 className="text-lg font-semibold text-ink">{t('adminSettings.title')}</h2>
        <p className="text-sm text-ink-muted mt-0.5">{t('adminSettings.subtitle')}</p>
      </div>

      {/* KYC toggle card */}
      <div className="avg-card p-5 space-y-4">
        <div className="flex items-center gap-2">
          <ShieldCheck size={16} className="text-primary" />
          <h3 className="text-sm font-semibold text-ink">{t('adminSettings.kycSection')}</h3>
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <p className="text-sm text-ink">{t('adminSettings.kycToggleLabel')}</p>
            <p className="text-xs text-ink-muted">{t('adminSettings.kycToggleHint')}</p>
          </div>

          {isPending ? (
            <Loader2 size={20} className="animate-spin text-ink-muted shrink-0" />
          ) : (
            <button
              onClick={() => update.mutate(!kycOptional)}
              disabled={update.isPending}
              className={`relative w-11 h-6 rounded-full transition-colors duration-200 cursor-pointer shrink-0 disabled:opacity-50 ${
                kycOptional ? 'bg-primary' : 'bg-white/10'
              }`}
              role="switch"
              aria-checked={kycOptional}
              aria-label={t('adminSettings.kycToggleLabel')}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${
                  kycOptional ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          )}
        </div>

        {/* Status badge */}
        {!isPending && (
          <div className="flex items-center gap-2 pt-1 border-t border-white/5">
            <span className="text-xs text-ink-muted">{t('adminSettings.currentStatus')}</span>
            <span
              className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${
                kycOptional
                  ? 'bg-success/10 text-success'
                  : 'bg-warning/10 text-warning'
              }`}
            >
              {kycOptional ? t('adminSettings.statusOptional') : t('adminSettings.statusMandatory')}
            </span>
          </div>
        )}
      </div>

      {/* Payout note */}
      <div className="flex items-start gap-2 bg-primary/5 border border-primary/20 rounded-xl p-4">
        <AlertCircle size={15} className="text-primary shrink-0 mt-0.5" />
        <p className="text-xs text-ink-muted">{t('adminSettings.payoutNote')}</p>
      </div>
    </div>
  )
}
