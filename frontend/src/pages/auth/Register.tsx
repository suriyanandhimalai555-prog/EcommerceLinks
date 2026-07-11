import { useState } from 'react'
import { useNavigate, Link, useSearchParams } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Eye, EyeOff, Loader2, AlertCircle, Link2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import { apiErrorMessage } from '../../lib/apiError'
import { tokenStore } from '../../lib/auth'
import { FormField } from '../../components/ui/FormField'
import { EmptyState } from '../../components/ui/EmptyState'

const schema = z.object({
  sponsorCode: z.string().min(3, 'Sponsor code required'),
  name: z.string().min(2, 'Full name required'),
  phone: z.string().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number'),
  email: z.string().email('Enter a valid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  confirmPassword: z.string(),
  terms: z.literal(true, { error: 'You must accept the terms' }),
}).refine((d) => d.password === d.confirmPassword, {
  message: 'Passwords do not match',
  path: ['confirmPassword'],
})
type FormData = z.infer<typeof schema>

export default function Register() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [searchParams] = useSearchParams()
  const [showPw, setShowPw] = useState(false)
  const sponsorParam = searchParams.get('sponsor') || ''

  const { register, handleSubmit, formState: { errors, isSubmitting }, setError } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      sponsorCode: sponsorParam,
    },
  })

  const onSubmit = async (data: FormData) => {
    try {
      await api.post('/auth/register', {
        sponsorCode: data.sponsorCode,
        name: data.name,
        phone: data.phone,
        email: data.email,
        password: data.password,
      })
      const loginRes = await api.post('/auth/login', { email: data.email, password: data.password })
      tokenStore.setAccess(loginRes.data.accessToken)
      tokenStore.setRefresh(loginRes.data.refreshToken)
      tokenStore.setMe(loginRes.data.member)
      queryClient.clear()
      navigate('/', { replace: true })
    } catch (err) {
      setError('root', { message: apiErrorMessage(err, t, t('auth.registrationFailed')) })
    }
  }

  // Registration is referral-only: without a sponsor link there is no form.
  if (!sponsorParam) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-primary-50 via-white to-violet-50 flex items-center justify-center p-4">
        <div className="w-full max-w-lg">
          <div className="text-center mb-6">
            <img src="/AVGLOGO.jpeg" alt="AVG Logo" className="w-14 h-14 rounded-2xl object-cover mx-auto mb-3 shadow-glow" />
            <h1 className="text-2xl font-bold text-ink">Agila Vetri Groups</h1>
          </div>
          <div className="avg-card p-8">
            <EmptyState
              icon={Link2}
              title={t('auth.referralRequired')}
              description={t('auth.referralRequiredDesc')}
            />
            <p className="text-center text-sm text-ink-muted mt-6">
              Already a member?{' '}
              <Link to="/login" className="text-primary font-semibold hover:underline">{t('auth.login')}</Link>
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary-50 via-white to-violet-50 flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        <div className="text-center mb-6">
          <img src="/AVGLOGO.jpeg" alt="AVG Logo" className="w-14 h-14 rounded-2xl object-cover mx-auto mb-3 shadow-glow" />
          <h1 className="text-2xl font-bold text-ink">Agila Vetri Groups</h1>
        </div>

        <div className="avg-card p-8">
          <h2 className="text-xl font-bold text-ink mb-6">{t('auth.register')}</h2>

          {errors.root && (
            <div className="flex items-center gap-2 bg-red-50 text-danger text-sm p-3 rounded-lg mb-4 border border-danger/20">
              <AlertCircle size={15} /> {errors.root.message}
            </div>
          )}

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              label={t('auth.sponsorCode')}
              readOnly
              className="bg-surface-page text-ink-muted cursor-not-allowed"
              hint={t('auth.sponsorLocked')}
              {...register('sponsorCode')}
              error={errors.sponsorCode?.message}
            />

            <div className="grid grid-cols-2 gap-4">
              <FormField label={t('auth.name')} placeholder="Full Name" {...register('name')} error={errors.name?.message} />
              <FormField label={t('auth.phone')} type="tel" placeholder="9XXXXXXXXX" maxLength={10} {...register('phone')} error={errors.phone?.message} />
            </div>

            <FormField label={t('auth.email')} type="email" placeholder="email@example.com" {...register('email')} error={errors.email?.message} />

            <div className="grid grid-cols-2 gap-4">
              <FormField
                label={t('auth.password')} type={showPw ? 'text' : 'password'} placeholder="Min 8 chars"
                {...register('password')} error={errors.password?.message}
                rightElement={
                  <button type="button" onClick={() => setShowPw(!showPw)} className="text-ink-muted cursor-pointer" aria-label="Toggle password">
                    {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                }
              />
              <FormField
                label={t('auth.confirmPassword')} type={showPw ? 'text' : 'password'} placeholder="Repeat password"
                {...register('confirmPassword')} error={errors.confirmPassword?.message}
              />
            </div>

            <label className="flex items-start gap-3 cursor-pointer">
              <input type="checkbox" {...register('terms')} className="mt-0.5 accent-primary w-4 h-4" />
              <span className="text-sm text-ink-muted">{t('auth.termsAccept')}</span>
            </label>
            {errors.terms && <p className="text-xs text-danger -mt-2">{errors.terms.message}</p>}

            <button type="submit" disabled={isSubmitting} className="avg-btn-primary w-full py-3 mt-2">
              {isSubmitting ? <Loader2 size={16} className="animate-spin" /> : null}
              {t('auth.register')}
            </button>
          </form>

          <p className="text-center text-sm text-ink-muted mt-6">
            Already a member?{' '}
            <Link to="/login" className="text-primary font-semibold hover:underline">{t('auth.login')}</Link>
          </p>
        </div>
      </div>
    </div>
  )
}
