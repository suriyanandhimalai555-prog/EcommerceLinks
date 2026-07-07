import { useState } from 'react'
import { useNavigate, Link, useSearchParams } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Eye, EyeOff, Loader2, AlertCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import api from '../../lib/api'
import { tokenStore } from '../../lib/auth'
import { FormField } from '../../components/ui/FormField'

const schema = z.object({
  sponsorCode: z.string().min(3, 'Sponsor code required'),
  preferredLeg: z.enum(['L', 'R'] as const).refine((v) => v === 'L' || v === 'R', 'Select a leg'),
  name: z.string().min(2, 'Full name required'),
  phone: z.string().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number'),
  email: z.string().email().optional().or(z.literal('')),
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
  const [searchParams] = useSearchParams()
  const [showPw, setShowPw] = useState(false)

  const { register, handleSubmit, formState: { errors, isSubmitting }, setError, watch } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      sponsorCode: searchParams.get('sponsor') || '',
      preferredLeg: searchParams.get('leg') === 'R' ? 'R' : 'L',
    },
  })

  const leg = watch('preferredLeg')

  const onSubmit = async (data: FormData) => {
    try {
      await api.post('/auth/register', {
        sponsorCode: data.sponsorCode,
        preferredLeg: data.preferredLeg,
        name: data.name,
        phone: data.phone,
        email: data.email || undefined,
        password: data.password,
      })
      const loginRes = await api.post('/auth/login', { phone: data.phone, password: data.password })
      tokenStore.setAccess(loginRes.data.accessToken)
      tokenStore.setRefresh(loginRes.data.refreshToken)
      tokenStore.setMe(loginRes.data.member)
      navigate('/', { replace: true })
    } catch {
      setError('root', { message: 'Registration failed. Please try again.' })
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary-50 via-white to-violet-50 flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        <div className="text-center mb-6">
          <div className="w-14 h-14 bg-gradient-to-br from-primary to-violet rounded-2xl flex items-center justify-center mx-auto mb-3 shadow-glow">
            <span className="text-white font-bold text-xl">AV</span>
          </div>
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
            <div className="grid grid-cols-2 gap-4">
              <FormField label={t('auth.sponsorCode')} placeholder="AGV100001" {...register('sponsorCode')} error={errors.sponsorCode?.message} />
              <div className="space-y-1.5">
                <p className="text-sm font-medium text-ink">{t('auth.preferredLeg')}<span className="text-danger ml-0.5">*</span></p>
                <div className="flex gap-3">
                  {(['L', 'R'] as const).map((l) => (
                    <label key={l} className={`flex-1 flex items-center justify-center gap-2 border rounded-lg px-3 py-2.5 cursor-pointer transition-all ${leg === l ? 'border-primary bg-primary-50 text-primary' : 'border-surface-line hover:border-gray-300'}`}>
                      <input type="radio" value={l} {...register('preferredLeg')} className="sr-only" />
                      <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${l === 'L' ? 'bg-primary-50 text-primary' : 'bg-violet-50 text-violet'}`}>{l}</div>
                      <span className="text-sm font-medium">{l === 'L' ? t('auth.leftLeg') : t('auth.rightLeg')}</span>
                    </label>
                  ))}
                </div>
                {errors.preferredLeg && <p className="text-xs text-danger">{errors.preferredLeg.message}</p>}
              </div>
            </div>

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
