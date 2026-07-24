/**
 * ResetPasswordStep — code + new-password entry step for the forgot-password flow.
 *
 * Shown after POST /auth/forgot-password succeeds. Collects the 6-digit reset
 * code (emailed to the member) plus a new password + confirmation, then calls
 * POST /auth/reset-password. On success the backend signs the member in directly,
 * so it stores tokens via onSuccess({ accessToken, refreshToken, member }).
 * On "resend", calls onResend() which re-requests a code from /auth/forgot-password.
 * On "back", calls onBack() so the parent can re-show the email form.
 *
 * Mirrors OtpStep's countdown + resend-cooldown behaviour.
 */

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, AlertCircle, KeyRound, CheckCircle2, Clock, Eye, EyeOff } from 'lucide-react'
import { isAxiosError } from 'axios'
import api from '../../lib/api'
import { apiErrorMessage } from '../../lib/apiError'
import { FormField } from '../ui/FormField'
import type { SessionPayload } from './OtpStep'

interface Props {
  email: string
  onSuccess: (session: SessionPayload) => void
  /** Re-requests a reset code from /auth/forgot-password. */
  onResend: () => Promise<void>
  onBack: () => void
}

/** Format seconds as M:SS */
function mmss(s: number): string {
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${m}:${String(sec).padStart(2, '0')}`
}

const OTP_TTL = 600   // mirrors backend OTP_TTL_SECONDS
const RESEND_WAIT = 60 // 1 minute cooldown before resend is allowed

export function ResetPasswordStep({ email, onSuccess, onResend, onBack }: Props) {
  const { t } = useTranslation()
  const [otp, setOtp] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [resending, setResending] = useState(false)
  const [expiresIn, setExpiresIn] = useState(OTP_TTL)
  const [resendIn, setResendIn] = useState(RESEND_WAIT)
  const inputRef = useRef<HTMLInputElement>(null)

  // Tick both countdown timers every second.
  useEffect(() => {
    const id = setInterval(() => {
      setExpiresIn(n => Math.max(0, n - 1))
      setResendIn(n => Math.max(0, n - 1))
    }, 1000)
    return () => clearInterval(id)
  }, [])

  const handleOtpChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    // Only allow digits, max 6 chars.
    const val = e.target.value.replace(/\D/g, '').slice(0, 6)
    setOtp(val)
    setError(null)
    setInfo(null)
  }

  const codeExpired = expiresIn === 0

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (otp.length !== 6 || codeExpired) return
    if (password.length < 8) {
      setError(t('auth.passwordTooShort'))
      return
    }
    if (password !== confirm) {
      setError(t('auth.passwordsMismatch'))
      return
    }
    setSubmitting(true)
    setError(null)
    setInfo(null)
    try {
      const res = await api.post('/auth/reset-password', { email, otp, newPassword: password })
      onSuccess(res.data as SessionPayload)
    } catch (err) {
      const status = isAxiosError(err) ? err.response?.status : undefined
      if (status === 401) {
        const reason = isAxiosError(err) ? (err.response?.data?.error as string | undefined) : undefined
        if (reason?.toLowerCase().includes('expired')) {
          setError(t('auth.otpExpired'))
        } else {
          setError(t('auth.otpInvalid'))
        }
      } else if (status === 429) {
        setError(t('auth.otpLocked'))
      } else {
        setError(apiErrorMessage(err, t, t('errors.generic')))
      }
      setSubmitting(false)
      setOtp('')
      inputRef.current?.focus()
    }
  }

  const handleResend = async () => {
    if (resendIn > 0 || resending) return
    setResending(true)
    setError(null)
    setInfo(null)
    try {
      await onResend()
      // Reset both timers and clear the code input for the fresh code.
      setExpiresIn(OTP_TTL)
      setResendIn(RESEND_WAIT)
      setOtp('')
      setInfo(t('auth.otpResent'))
      inputRef.current?.focus()
    } catch (err) {
      const status = isAxiosError(err) ? err.response?.status : undefined
      if (status === 429) {
        setError(t('auth.otpResendLimit'))
      } else {
        setError(apiErrorMessage(err, t, t('errors.generic')))
      }
    } finally {
      setResending(false)
    }
  }

  return (
    <div className="space-y-5">
      {/* Notice */}
      <div className="flex items-start gap-2 bg-primary/5 border border-primary/20 rounded-xl p-4">
        <KeyRound size={15} className="text-primary shrink-0 mt-0.5" />
        <p className="text-sm text-ink-muted">{t('auth.resetSentNotice')}</p>
      </div>

      {/* Expiry countdown / expired notice */}
      {codeExpired ? (
        <div className="flex items-center gap-2 bg-danger/10 text-danger text-sm p-3 rounded-lg border border-danger/20">
          <AlertCircle size={15} className="shrink-0" />
          {t('auth.otpExpiredNotice')}
        </div>
      ) : (
        <div className="flex items-center gap-1.5 text-xs text-ink-muted">
          <Clock size={13} className="shrink-0" />
          {t('auth.otpExpiresIn', { time: mmss(expiresIn) })}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 bg-danger/10 text-danger text-sm p-3 rounded-lg border border-danger/20">
          <AlertCircle size={15} className="shrink-0" />
          {error}
        </div>
      )}

      {/* Info (resend success) */}
      {info && !error && (
        <div className="flex items-center gap-2 bg-success/10 text-success text-sm p-3 rounded-lg border border-success/20">
          <CheckCircle2 size={15} className="shrink-0" />
          {info}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-ink-muted uppercase tracking-wide">
            {t('auth.otpLabel')}
          </label>
          <input
            ref={inputRef}
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder={t('auth.otpPlaceholder')}
            value={otp}
            onChange={handleOtpChange}
            autoFocus
            disabled={codeExpired}
            className="w-full bg-surface-page border border-white/10 rounded-xl px-4 py-3 text-ink text-center text-2xl font-mono tracking-widest placeholder:text-ink-muted/40 focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30 transition disabled:opacity-40 disabled:cursor-not-allowed"
          />
        </div>

        <FormField
          label={t('auth.newPassword')}
          type={showPw ? 'text' : 'password'}
          placeholder="••••••••"
          value={password}
          onChange={(e) => { setPassword(e.target.value); setError(null) }}
          disabled={codeExpired}
          rightElement={
            <button type="button" onClick={() => setShowPw(!showPw)} className="text-ink-muted hover:text-ink cursor-pointer" aria-label="Toggle password">
              {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          }
        />
        <FormField
          label={t('auth.confirmPassword')}
          type={showPw ? 'text' : 'password'}
          placeholder="••••••••"
          value={confirm}
          onChange={(e) => { setConfirm(e.target.value); setError(null) }}
          disabled={codeExpired}
        />

        <button
          type="submit"
          disabled={submitting || otp.length !== 6 || codeExpired || password.length < 8 || confirm.length < 8}
          className="avg-btn-primary w-full py-3"
        >
          {submitting ? <Loader2 size={16} className="animate-spin inline mr-2" /> : null}
          {t('auth.resetBtn')}
        </button>
      </form>

      {/* Resend button — disabled for the first 60 seconds */}
      <button
        type="button"
        onClick={handleResend}
        disabled={resendIn > 0 || resending}
        className="w-full text-sm text-primary hover:text-primary/80 transition text-center disabled:text-ink-muted disabled:cursor-not-allowed"
      >
        {resending
          ? <><Loader2 size={13} className="animate-spin inline mr-1" />{t('auth.otpResend')}</>
          : resendIn > 0
            ? t('auth.otpResendIn', { time: mmss(resendIn) })
            : t('auth.otpResend')
        }
      </button>

      {/* Back link — returns to the email step, not the login page */}
      <button
        type="button"
        onClick={onBack}
        className="w-full text-sm text-ink-muted hover:text-ink transition text-center"
      >
        ← {t('auth.changeEmail')}
      </button>
    </div>
  )
}
