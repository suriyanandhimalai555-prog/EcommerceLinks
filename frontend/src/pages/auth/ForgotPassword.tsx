import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Loader2, AlertCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import { apiErrorMessage } from '../../lib/apiError'
import { tokenStore } from '../../lib/auth'
import { homeFor } from '../../lib/roles'
import { FormField } from '../../components/ui/FormField'
import { ResetPasswordStep } from '../../components/auth/ResetPasswordStep'
import type { SessionPayload } from '../../components/auth/OtpStep'

const schema = z.object({
  email: z.string().email('Enter a valid email address'),
})
type FormData = z.infer<typeof schema>

export default function ForgotPassword() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [pendingEmail, setPendingEmail] = useState<string | null>(null)

  const { register, handleSubmit, formState: { errors, isSubmitting }, setError } = useForm<FormData>({
    resolver: zodResolver(schema),
  })

  /** Store tokens and navigate home after the reset auto-signs the member in. */
  const handleSession = (session: SessionPayload) => {
    tokenStore.setAccess(session.accessToken)
    tokenStore.setRefresh(session.refreshToken)
    tokenStore.setMe(session.member)
    queryClient.clear()
    navigate(homeFor(session.member?.role), { replace: true })
  }

  /** Request a reset code. Backend always returns { ok: true } (no enumeration). */
  const requestCode = (email: string) => api.post('/auth/forgot-password', { email }).then(() => {})

  const onSubmit = async (data: FormData) => {
    try {
      await requestCode(data.email)
      // Always advance to the code step — the response never reveals whether the
      // email exists, so the UI must not branch on it either.
      setPendingEmail(data.email)
    } catch (err) {
      setError('root', { message: apiErrorMessage(err, t, t('errors.generic')) })
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
          {pendingEmail ? (
            /* ── Code + new password step ── */
            <>
              <h2 className="text-xl font-bold text-ink mb-6">{t('auth.resetTitle')}</h2>
              <ResetPasswordStep
                email={pendingEmail}
                onSuccess={handleSession}
                onResend={() => requestCode(pendingEmail)}
                onBack={() => setPendingEmail(null)}
              />
            </>
          ) : (
            /* ── Email step ── */
            <>
              <h2 className="text-xl font-bold text-ink mb-2">{t('auth.resetTitle')}</h2>
              <p className="text-sm text-ink-muted mb-6">{t('auth.resetDescription')}</p>

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

                <button type="submit" disabled={isSubmitting} className="avg-btn-primary w-full py-3 mt-2">
                  {isSubmitting ? <Loader2 size={16} className="animate-spin inline mr-2" /> : null}
                  {t('auth.sendCode')}
                </button>
              </form>

              <p className="text-center text-sm text-ink-muted mt-6">
                <Link to="/login" className="text-primary font-semibold hover:underline">
                  ← {t('auth.backToLogin')}
                </Link>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
