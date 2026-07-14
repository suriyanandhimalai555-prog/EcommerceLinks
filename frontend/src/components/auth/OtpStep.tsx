/**
 * OtpStep — reusable OTP entry step for the two-step login flow.
 *
 * Shown after the backend returns { otpRequired: true }.
 * Calls POST /auth/login/verify-otp with the user's email + the entered code.
 * On success it stores tokens and calls onSuccess({ accessToken, refreshToken, member }).
 * On "back", calls onBack() so the parent can re-show the password form.
 */

import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, AlertCircle, KeyRound } from 'lucide-react'
import { isAxiosError } from 'axios'
import api from '../../lib/api'
import { apiErrorMessage } from '../../lib/apiError'
import type { Me } from '../../types/api'

export interface SessionPayload {
  accessToken: string
  refreshToken: string
  memberCode: string
  member: Me
}

interface Props {
  email: string
  onSuccess: (session: SessionPayload) => void
  onBack: () => void
}

export function OtpStep({ email, onSuccess, onBack }: Props) {
  const { t } = useTranslation()
  const [otp, setOtp] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    // Only allow digits, max 6 chars.
    const val = e.target.value.replace(/\D/g, '').slice(0, 6)
    setOtp(val)
    setError(null)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (otp.length !== 6) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await api.post('/auth/login/verify-otp', { email, otp })
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

  return (
    <div className="space-y-5">
      {/* Notice */}
      <div className="flex items-start gap-2 bg-primary/5 border border-primary/20 rounded-xl p-4">
        <KeyRound size={15} className="text-primary shrink-0 mt-0.5" />
        <p className="text-sm text-ink-muted">{t('auth.otpSentNotice')}</p>
      </div>

      {error && (
        <div className="flex items-center gap-2 bg-danger/10 text-danger text-sm p-3 rounded-lg border border-danger/20">
          <AlertCircle size={15} className="shrink-0" />
          {error}
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
            onChange={handleChange}
            autoFocus
            className="w-full bg-surface-page border border-white/10 rounded-xl px-4 py-3 text-ink text-center text-2xl font-mono tracking-widest placeholder:text-ink-muted/40 focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30 transition"
          />
        </div>

        <button
          type="submit"
          disabled={submitting || otp.length !== 6}
          className="avg-btn-primary w-full py-3"
        >
          {submitting ? <Loader2 size={16} className="animate-spin inline mr-2" /> : null}
          {t('auth.otpVerifyBtn')}
        </button>
      </form>

      <button
        type="button"
        onClick={onBack}
        className="w-full text-sm text-ink-muted hover:text-ink transition text-center"
      >
        ← {t('auth.otpResend')}
      </button>
    </div>
  )
}
