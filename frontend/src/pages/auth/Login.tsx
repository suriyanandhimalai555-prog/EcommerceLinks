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
  phone: z.string().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number'),
  password: z.string().min(1, 'Password is required'),
})
type FormData = z.infer<typeof schema>

export default function Login() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [showPw, setShowPw] = useState(false)
  const sessionExpired = searchParams.get('reason') === 'session_expired'

  const { register, handleSubmit, formState: { errors, isSubmitting }, setError } = useForm<FormData>({
    resolver: zodResolver(schema),
  })

  const onSubmit = async (data: FormData) => {
    try {
      const res = await api.post('/auth/login', data)
      tokenStore.setAccess(res.data.accessToken)
      tokenStore.setRefresh(res.data.refreshToken)
      tokenStore.setMe(res.data.member)
      navigate('/', { replace: true })
    } catch {
      setError('root', { message: 'Invalid phone number or password' })
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary-50 via-white to-violet-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-gradient-to-br from-primary to-violet rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-glow">
            <span className="text-white font-bold text-2xl">AV</span>
          </div>
          <h1 className="text-2xl font-bold text-ink">Agila Vetri Groups</h1>
          <p className="text-ink-muted text-sm mt-1">Member Portal</p>
        </div>

        <div className="avg-card p-8">
          <h2 className="text-xl font-bold text-ink mb-6">{t('auth.login')}</h2>

          {sessionExpired && (
            <div className="flex items-center gap-2 bg-warning-50 text-warning text-sm p-3 rounded-lg mb-4 border border-warning/20">
              <AlertCircle size={15} />
              {t('auth.sessionExpired')}
            </div>
          )}

          {errors.root && (
            <div className="flex items-center gap-2 bg-red-50 text-danger text-sm p-3 rounded-lg mb-4 border border-danger/20">
              <AlertCircle size={15} />
              {errors.root.message}
            </div>
          )}

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              label={t('auth.phone')}
              type="tel"
              placeholder="9XXXXXXXXX"
              maxLength={10}
              {...register('phone')}
              error={errors.phone?.message}
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
        </div>
      </div>
    </div>
  )
}
