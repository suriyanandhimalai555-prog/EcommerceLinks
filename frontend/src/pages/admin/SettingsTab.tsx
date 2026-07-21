import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ShieldCheck, Mail, Lock, LockOpen, AlertCircle, Loader2 } from 'lucide-react'
import api from '../../lib/api'
import type { SystemSettings } from '../../types/api'

function ToggleSwitch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  label: string
}) {
  return (
    <button
      onClick={() => onChange(!checked)}
      disabled={disabled}
      className={`relative w-11 h-6 rounded-full transition-colors duration-200 cursor-pointer shrink-0 disabled:opacity-50 ${
        checked ? 'bg-primary' : 'bg-white/10'
      }`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${
          checked ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </button>
  )
}

function StatusBadge({ on, labelOn, labelOff }: { on: boolean; labelOn: string; labelOff: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${
        on ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'
      }`}
    >
      {on ? labelOn : labelOff}
    </span>
  )
}

export function SettingsTab() {
  const { t } = useTranslation()
  const qc = useQueryClient()

  const { data: settings, isPending } = useQuery<SystemSettings>({
    queryKey: ['admin-settings'],
    queryFn: () => api.get('/admin/settings').then((r) => r.data),
  })

  const update = useMutation({
    mutationFn: (patch: Partial<SystemSettings>) =>
      api.patch('/admin/settings', patch).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-settings'] })
      qc.invalidateQueries({ queryKey: ['me'] })
    },
  })

  const kycOptional = settings?.kycOptional ?? false
  const welcomeEmailEnabled = settings?.welcomeEmailEnabled ?? false
  const loginOtpEnabled = settings?.loginOtpEnabled ?? false

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h2 className="text-lg font-semibold text-ink">{t('adminSettings.title')}</h2>
        <p className="text-sm text-ink-muted mt-0.5">{t('adminSettings.subtitle')}</p>
      </div>

      {/* ── KYC toggle card ── */}
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
            <div className="flex items-center gap-2 shrink-0">
              {update.isPending && <Loader2 size={14} className="animate-spin text-ink-muted" />}
              <ToggleSwitch
                checked={kycOptional}
                onChange={(v) => update.mutate({ kycOptional: v })}
                disabled={update.isPending}
                label={t('adminSettings.kycToggleLabel')}
              />
            </div>
          )}
        </div>

        {!isPending && (
          <div className="flex items-center gap-2 pt-1 border-t border-white/5">
            <span className="text-xs text-ink-muted">{t('adminSettings.currentStatus')}</span>
            <StatusBadge
              on={kycOptional}
              labelOn={t('adminSettings.statusOptional')}
              labelOff={t('adminSettings.statusMandatory')}
            />
          </div>
        )}
      </div>

      {/* ── Welcome email toggle card ── */}
      <div className="avg-card p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Mail size={16} className="text-primary" />
          <h3 className="text-sm font-semibold text-ink">{t('adminSettings.emailSection')}</h3>
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <p className="text-sm text-ink">{t('adminSettings.welcomeEmailToggleLabel')}</p>
            <p className="text-xs text-ink-muted">{t('adminSettings.welcomeEmailToggleHint')}</p>
          </div>
          {isPending ? (
            <Loader2 size={20} className="animate-spin text-ink-muted shrink-0" />
          ) : (
            <div className="flex items-center gap-2 shrink-0">
              {update.isPending && <Loader2 size={14} className="animate-spin text-ink-muted" />}
              <ToggleSwitch
                checked={welcomeEmailEnabled}
                onChange={(v) => update.mutate({ welcomeEmailEnabled: v })}
                disabled={update.isPending}
                label={t('adminSettings.welcomeEmailToggleLabel')}
              />
            </div>
          )}
        </div>

        {!isPending && (
          <div className="flex items-center gap-2 pt-1 border-t border-white/5">
            <span className="text-xs text-ink-muted">{t('adminSettings.currentStatus')}</span>
            <StatusBadge
              on={welcomeEmailEnabled}
              labelOn={t('adminSettings.welcomeEmailStatusOn')}
              labelOff={t('adminSettings.welcomeEmailStatusOff')}
            />
          </div>
        )}
      </div>

      {/* ── OTP login control panel ── */}
      <div
        className="rounded-2xl p-5 space-y-4 transition-all duration-300"
        style={{
          background: 'var(--color-surface-card, #141927)',
          border: loginOtpEnabled
            ? '1px solid rgba(52,211,153,0.35)'
            : '1px solid rgba(248,113,113,0.35)',
          boxShadow: loginOtpEnabled
            ? '0 0 24px rgba(52,211,153,0.07)'
            : '0 0 24px rgba(248,113,113,0.07)',
        }}
      >
        {/* Header row */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className="p-2 rounded-xl transition-colors duration-300"
              style={{ background: loginOtpEnabled ? 'rgba(52,211,153,0.12)' : 'rgba(248,113,113,0.12)' }}
            >
              {loginOtpEnabled
                ? <Lock size={16} style={{ color: '#34D399' }} />
                : <LockOpen size={16} style={{ color: '#F87171' }} />}
            </div>
            <div>
              <h3 className="text-sm font-semibold text-ink">{t('adminSettings.otpSection')}</h3>
              <p className="text-xs text-ink-muted">System-wide login verification</p>
            </div>
          </div>
          {/* Live status pill */}
          <span
            className="text-[11px] font-bold tracking-widest px-3 py-1 rounded-full uppercase transition-all duration-300"
            style={loginOtpEnabled
              ? { background: 'rgba(52,211,153,0.12)', color: '#34D399' }
              : { background: 'rgba(248,113,113,0.12)', color: '#F87171' }}
          >
            {loginOtpEnabled ? '● Active' : '● Bypassed'}
          </span>
        </div>

        {/* Control panel body */}
        <div
          className="rounded-xl p-4 space-y-4"
          style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}
        >
          <div className="space-y-0.5">
            <p className="text-sm text-ink">{t('adminSettings.otpToggleLabel')}</p>
            <p className="text-xs text-ink-muted">{t('adminSettings.otpToggleHint')}</p>
          </div>

          {/* ON / OFF segmented control */}
          {isPending ? (
            <Loader2 size={18} className="animate-spin text-ink-muted" />
          ) : (
            <div className="flex items-center gap-3">
            <div className="flex items-center gap-1 w-fit rounded-lg p-1" style={{ background: 'rgba(255,255,255,0.05)' }}>
              <button
                onClick={() => update.mutate({ loginOtpEnabled: true })}
                disabled={update.isPending || loginOtpEnabled}
                className="px-5 py-1.5 text-xs font-bold rounded-md transition-all duration-200 cursor-pointer disabled:cursor-default"
                style={loginOtpEnabled
                  ? { background: '#34D399', color: '#0B0E16', boxShadow: '0 0 10px rgba(52,211,153,0.45)' }
                  : { color: '#98A2B8' }}
              >
                ON
              </button>
              <button
                onClick={() => update.mutate({ loginOtpEnabled: false })}
                disabled={update.isPending || !loginOtpEnabled}
                className="px-5 py-1.5 text-xs font-bold rounded-md transition-all duration-200 cursor-pointer disabled:cursor-default"
                style={!loginOtpEnabled
                  ? { background: '#F87171', color: '#0B0E16', boxShadow: '0 0 10px rgba(248,113,113,0.45)' }
                  : { color: '#98A2B8' }}
              >
                OFF
              </button>
            </div>
            {update.isPending && <Loader2 size={16} className="animate-spin text-ink-muted" />}
            </div>
          )}
        </div>

        {/* Security warning when OTP is off */}
        {!loginOtpEnabled && !isPending && (
          <div
            className="flex items-start gap-2.5 rounded-xl p-3"
            style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)' }}
          >
            <AlertCircle size={14} className="shrink-0 mt-0.5" style={{ color: '#F87171' }} />
            <p className="text-xs" style={{ color: 'rgba(248,113,113,0.9)' }}>
              All member logins currently bypass email verification. Enable OTP to protect account access.
            </p>
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
