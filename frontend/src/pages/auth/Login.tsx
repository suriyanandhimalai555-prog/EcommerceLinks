import { useState } from 'react'
import { useNavigate, Link, useSearchParams } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Eye, EyeOff, Loader2, AlertCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { isAxiosError } from 'axios'
import api from '../../lib/api'
import { apiErrorMessage } from '../../lib/apiError'
import { tokenStore } from '../../lib/auth'
import { homeFor } from '../../lib/roles'
import { FormField } from '../../components/ui/FormField'
import { OtpStep } from '../../components/auth/OtpStep'
import type { SessionPayload } from '../../components/auth/OtpStep'

const schema = z.object({
  email: z.string().email('Enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
})
type FormData = z.infer<typeof schema>

export default function Login() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [searchParams] = useSearchParams()
  const [showPw, setShowPw] = useState(false)
  const [otpEmail, setOtpEmail] = useState<string | null>(null)
  const sessionExpired = searchParams.get('reason') === 'session_expired'

  const { register, handleSubmit, formState: { errors, isSubmitting }, setError } = useForm<FormData>({
    resolver: zodResolver(schema),
  })

  /** Shared: store tokens and navigate to home after a successful session. */
  const handleSession = (session: SessionPayload) => {
    tokenStore.setAccess(session.accessToken)
    tokenStore.setRefresh(session.refreshToken)
    tokenStore.setMe(session.member)
    queryClient.clear()
    navigate(homeFor(session.member?.role), { replace: true })
  }

  const onSubmit = async (data: FormData) => {
    try {
      const res = await api.post('/auth/login', data)
      if (res.data.otpRequired) {
        // OTP is enabled — switch to the verify step.
        setOtpEmail(data.email)
        return
      }
      // OTP is off — session issued directly.
      handleSession(res.data as SessionPayload)
    } catch (err) {
      const status = isAxiosError(err) ? err.response?.status : undefined
      setError('root', {
        message: status === 401
          ? t('auth.invalidCredentials')
          : apiErrorMessage(err, t, t('errors.generic')),
      })
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#0E1526] via-surface-page to-[#131B33] flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <img src="/AVGLOGO.jpeg" alt="AVG Logo" className="w-16 h-16 rounded-2xl object-cover mx-auto mb-4 shadow-glow" />
          <h1 className="text-2xl font-bold text-ink">Agila Vetri Groups</h1>
          <p className="text-ink-muted text-sm mt-1">Member Portal</p>
        </div>

        <div className="avg-card p-8">
          {otpEmail ? (
            /* ── OTP step ── */
            <>
              <h2 className="text-xl font-bold text-ink mb-6">{t('auth.login')}</h2>
              <OtpStep
                email={otpEmail}
                onSuccess={handleSession}
                onBack={() => setOtpEmail(null)}
              />
            </>
          ) : (
            /* ── Password step ── */
            <>
              <h2 className="text-xl font-bold text-ink mb-6">{t('auth.login')}</h2>

              {sessionExpired && (
                <div className="flex items-center gap-2 bg-warning-50 text-warning text-sm p-3 rounded-lg mb-4 border border-warning/20">
                  <AlertCircle size={15} />
                  {t('auth.sessionExpired')}
                </div>
              )}

              {errors.root && (
                <div className="flex items-center gap-2 bg-danger/10 text-danger text-sm p-3 rounded-lg mb-4 border border-danger/20">
                  <AlertCircle size={15} />
                  {errors.root.message}
                </div>
              )}

              <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
                <FormField
                  label={t('auth.email')}
                  type="email"
                  placeholder="email@example.com"
                  {...register('email')}
                  error={errors.email?.message}
                />
                <FormField
                  label={t('auth.password')}
                  type={showPw ? 'text' : 'password'}
                  placeholder="••••••••"
                  {...register('password')}
                  error={errors.password?.message}
                  rightElement={
                    <button type="button" onClick={() => setShowPw(!showPw)} className="text-ink-muted hover:text-ink cursor-pointer" aria-label="Toggle password">
                      {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  }
                />

                <button type="submit" disabled={isSubmitting} className="avg-btn-primary w-full py-3 mt-2">
                  {isSubmitting ? <Loader2 size={16} className="animate-spin" /> : null}
                  {t('auth.login')}
                </button>
              </form>

              <p className="text-center text-sm text-ink-muted mt-6">
                New member?{' '}
                <Link to="/register" className="text-primary font-semibold hover:underline">
                  {t('auth.register')}
                </Link>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
