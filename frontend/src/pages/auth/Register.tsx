import { useState, useEffect } from 'react'
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
import { OtpStep } from '../../components/auth/OtpStep'
import type { SessionPayload } from '../../components/auth/OtpStep'

const schema = z.object({
  sponsorCode: z.string().min(3, 'Sponsor code required'),
  name: z.string().min(2, 'Full name required'),
  phone: z.string().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number'),
  email: z.string().email('Enter a valid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  confirmPassword: z.string(),
  // Delivery address — required at signup
  recipientName: z.string().min(1, 'Recipient name is required'),
  addrPhone: z.string().regex(/^\d{10}$/, 'Enter a valid 10-digit mobile number'),
  line1: z.string().min(1, 'Address line 1 is required'),
  line2: z.string().optional(),
  city: z.string().min(1, 'City is required'),
  state: z.string().min(1, 'State is required'),
  pincode: z.string().regex(/^\d{6}$/, 'Pincode must be exactly 6 digits'),
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
  // Login-OTP mode: after account creation, auto-login returned { otpRequired: true }.
  const [otpCreds, setOtpCreds] = useState<{ email: string; password: string } | null>(null)
  // Register-OTP mode: POST /auth/register itself returned { otpRequired: true }.
  // We hold the full form payload so OtpStep can re-send it at verify time.
  const [registerOtpPayload, setRegisterOtpPayload] = useState<{
    sponsorCode: string; name: string; phone: string
    email: string; password: string; leg?: 'L' | 'R'
    address: { recipientName: string; phone: string; line1: string; line2?: string; city: string; state: string; pincode: string }
  } | null>(null)
  const sponsorParam = searchParams.get('sponsor') || ''
  // Optional placement side from a leg-specific referral link (tapped vacant
  // slot). Only 'L'/'R' are honored; anything else falls back to auto-fill.
  const legRaw = searchParams.get('leg')
  const legParam: 'L' | 'R' | undefined = legRaw === 'L' || legRaw === 'R' ? legRaw : undefined

  const { register, handleSubmit, watch, setValue, formState: { errors, isSubmitting, dirtyFields }, setError } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      sponsorCode: sponsorParam,
    },
  })

  // Mirror account name/phone into the address recipient fields while the user
  // hasn't manually changed them — stops mirroring once the field is dirtied.
  const watchedName = watch('name')
  const watchedPhone = watch('phone')
  useEffect(() => {
    if (!dirtyFields.recipientName) setValue('recipientName', watchedName ?? '')
  }, [watchedName, dirtyFields.recipientName, setValue])
  useEffect(() => {
    if (!dirtyFields.addrPhone) setValue('addrPhone', watchedPhone ?? '')
  }, [watchedPhone, dirtyFields.addrPhone, setValue])

  /** Shared: store tokens and navigate after a successful login/OTP session. */
  const handleSession = (session: SessionPayload) => {
    tokenStore.setAccess(session.accessToken)
    tokenStore.setRefresh(session.refreshToken)
    tokenStore.setMe(session.member)
    queryClient.clear()
    navigate('/', { replace: true })
  }

  const onSubmit = async (data: FormData) => {
    const payload = {
      sponsorCode: data.sponsorCode,
      name: data.name,
      phone: data.phone,
      email: data.email,
      password: data.password,
      ...(legParam ? { leg: legParam } : {}),
      address: {
        recipientName: data.recipientName,
        phone: data.addrPhone,
        line1: data.line1,
        ...(data.line2 ? { line2: data.line2 } : {}),
        city: data.city,
        state: data.state,
        pincode: data.pincode,
      },
    }
    try {
      const regRes = await api.post('/auth/register', payload)

      if (regRes.data.otpRequired) {
        // Register-OTP is enabled — the account has NOT been created yet.
        // Show OtpStep in register mode: verify-otp will create the account.
        setRegisterOtpPayload(payload)
        return
      }

      // Account created immediately — auto-login.
      const loginRes = await api.post('/auth/login', { email: data.email, password: data.password })
      if (loginRes.data.otpRequired) {
        // Login-OTP is enabled — show OtpStep in login mode.
        setOtpCreds({ email: data.email, password: data.password })
        return
      }
      handleSession(loginRes.data as SessionPayload)
    } catch (err) {
      setError('root', { message: apiErrorMessage(err, t, t('auth.registrationFailed')) })
    }
  }

  // Registration is referral-only: without a sponsor link there is no form.
  if (!sponsorParam) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-[#0E1526] via-surface-page to-[#131B33] flex items-center justify-center p-4">
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

  // Register-OTP step — shown when POST /auth/register returned { otpRequired: true }.
  // The account hasn't been created yet; verifying the code creates it and auto-signs in.
  if (registerOtpPayload) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-[#0E1526] via-surface-page to-[#131B33] flex items-center justify-center p-4">
        <div className="w-full max-w-md">
          <div className="text-center mb-6">
            <img src="/AVGLOGO.jpeg" alt="AVG Logo" className="w-14 h-14 rounded-2xl object-cover mx-auto mb-3 shadow-glow" />
            <h1 className="text-2xl font-bold text-ink">Agila Vetri Groups</h1>
          </div>
          <div className="avg-card p-8">
            <h2 className="text-xl font-bold text-ink mb-6">{t('auth.verifyEmailTitle')}</h2>
            <OtpStep
              email={registerOtpPayload.email}
              verifyUrl="/auth/register/verify-otp"
              extraPayload={registerOtpPayload}
              onSuccess={handleSession}
              onResend={() => api.post('/auth/register', registerOtpPayload).then(() => {})}
              onBack={() => setRegisterOtpPayload(null)}
            />
          </div>
        </div>
      </div>
    )
  }

  // Login-OTP step — shown after successful registration + auto-login when login OTP is enabled.
  if (otpCreds) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-[#0E1526] via-surface-page to-[#131B33] flex items-center justify-center p-4">
        <div className="w-full max-w-md">
          <div className="text-center mb-6">
            <img src="/AVGLOGO.jpeg" alt="AVG Logo" className="w-14 h-14 rounded-2xl object-cover mx-auto mb-3 shadow-glow" />
            <h1 className="text-2xl font-bold text-ink">Agila Vetri Groups</h1>
          </div>
          <div className="avg-card p-8">
            <h2 className="text-xl font-bold text-ink mb-6">{t('auth.login')}</h2>
            <OtpStep
              email={otpCreds.email}
              onSuccess={handleSession}
              onResend={() => api.post('/auth/login', otpCreds).then(() => {})}
              onBack={() => setOtpCreds(null)}
            />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#0E1526] via-surface-page to-[#131B33] flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        <div className="text-center mb-6">
          <img src="/AVGLOGO.jpeg" alt="AVG Logo" className="w-14 h-14 rounded-2xl object-cover mx-auto mb-3 shadow-glow" />
          <h1 className="text-2xl font-bold text-ink">Agila Vetri Groups</h1>
        </div>

        <div className="avg-card p-8">
          <h2 className="text-xl font-bold text-ink mb-6">{t('auth.register')}</h2>

          {errors.root && (
            <div className="flex items-center gap-2 bg-danger/10 text-danger text-sm p-3 rounded-lg mb-4 border border-danger/20">
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

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <FormField label={t('auth.name')} placeholder="Full Name" {...register('name')} error={errors.name?.message} />
              <FormField label={t('auth.phone')} type="tel" placeholder="9XXXXXXXXX" maxLength={10} {...register('phone')} error={errors.phone?.message} />
            </div>

            <FormField label={t('auth.email')} type="email" placeholder="email@example.com" {...register('email')} error={errors.email?.message} />

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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

            {/* ── Delivery Address ── */}
            <div className="pt-1">
              <h3 className="text-sm font-semibold text-ink mb-3">{t('auth.deliveryAddressTitle')}</h3>
              <div className="space-y-3 rounded-xl border border-white/8 bg-white/[0.03] p-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <FormField
                    label={t('profile.address.recipientName')}
                    placeholder={t('profile.address.recipientNamePlaceholder')}
                    {...register('recipientName')}
                    error={errors.recipientName?.message}
                  />
                  <FormField
                    label={t('profile.address.phone')}
                    type="tel"
                    placeholder={t('profile.address.phonePlaceholder')}
                    maxLength={10}
                    {...register('addrPhone')}
                    error={errors.addrPhone?.message}
                  />
                </div>
                <FormField
                  label={t('profile.address.line1')}
                  placeholder={t('profile.address.line1Placeholder')}
                  {...register('line1')}
                  error={errors.line1?.message}
                />
                <FormField
                  label={t('profile.address.line2')}
                  placeholder={t('profile.address.line2Placeholder')}
                  {...register('line2')}
                  error={errors.line2?.message}
                />
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <FormField
                    label={t('profile.address.city')}
                    placeholder={t('profile.address.cityPlaceholder')}
                    {...register('city')}
                    error={errors.city?.message}
                  />
                  <FormField
                    label={t('profile.address.state')}
                    placeholder={t('profile.address.statePlaceholder')}
                    {...register('state')}
                    error={errors.state?.message}
                  />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <FormField
                    label={t('profile.address.pincode')}
                    placeholder="000000"
                    maxLength={6}
                    inputMode="numeric"
                    {...register('pincode')}
                    error={errors.pincode?.message}
                  />
                </div>
              </div>
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
