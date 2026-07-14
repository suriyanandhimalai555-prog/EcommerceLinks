import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Loader2, CheckCircle2, Eye, EyeOff, AlertCircle } from 'lucide-react'
import { isAxiosError } from 'axios'
import { FormField } from '../../components/ui/FormField'
import api from '../../lib/api'

const schema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required'),
    newPassword: z.string().min(8, 'Minimum 8 characters'),
    confirmPassword: z.string(),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  })

type FormData = z.infer<typeof schema>

export function PasswordTab() {
  const [showPw, setShowPw] = useState(false)
  const [saved, setSaved] = useState(false)

  const form = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
  })

  const mutation = useMutation({
    mutationFn: (d: FormData) =>
      api.put('/me/password', {
        currentPassword: d.currentPassword,
        newPassword: d.newPassword,
      }),
    onSuccess: () => {
      setSaved(true)
      form.reset()
    },
    onError: (err) => {
      if (isAxiosError(err)) {
        const status = err.response?.status
        const message =
          typeof err.response?.data?.error === 'string'
            ? err.response.data.error
            : 'Something went wrong. Please try again.'

        if (status === 401) {
          form.setError('currentPassword', { message: 'Current password is incorrect' })
        } else if (status === 400 && message.toLowerCase().includes('different')) {
          form.setError('newPassword', { message: 'New password must be different from the current one' })
        } else {
          form.setError('root', { message })
        }
      } else {
        form.setError('root', { message: 'Something went wrong. Please try again.' })
      }
    },
  })

  const eyeToggle = (
    <button
      type="button"
      onClick={() => setShowPw((v) => !v)}
      className="text-ink-muted hover:text-ink cursor-pointer"
      aria-label="Toggle password visibility"
    >
      {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
    </button>
  )

  const onSubmit = (d: FormData) => {
    setSaved(false)
    mutation.mutate(d)
  }

  return (
    <div className="avg-card p-5 space-y-4 max-w-lg">
      <div>
        <h3 className="text-sm font-semibold text-ink">Change Password</h3>
        <p className="text-xs text-ink-muted mt-0.5">
          Enter your current password and choose a new one.
        </p>
      </div>

      {form.formState.errors.root && (
        <div className="flex items-center gap-2 bg-danger/10 text-danger text-sm p-3 rounded-lg border border-danger/20">
          <AlertCircle size={15} className="shrink-0" />
          {form.formState.errors.root.message}
        </div>
      )}

      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <FormField
          label="Current Password"
          type={showPw ? 'text' : 'password'}
          placeholder="••••••••"
          {...form.register('currentPassword')}
          error={form.formState.errors.currentPassword?.message}
          rightElement={eyeToggle}
        />

        <FormField
          label="New Password"
          type={showPw ? 'text' : 'password'}
          placeholder="Min 8 characters"
          {...form.register('newPassword')}
          error={form.formState.errors.newPassword?.message}
          rightElement={eyeToggle}
        />

        <FormField
          label="Confirm New Password"
          type={showPw ? 'text' : 'password'}
          placeholder="Repeat new password"
          {...form.register('confirmPassword')}
          error={form.formState.errors.confirmPassword?.message}
          rightElement={eyeToggle}
        />

        <div className="flex items-center gap-3 pt-1">
          <button
            type="submit"
            disabled={mutation.isPending}
            className="avg-btn-primary"
          >
            {mutation.isPending ? (
              <Loader2 size={14} className="animate-spin" />
            ) : null}
            Update Password
          </button>

          {saved && !mutation.isPending && (
            <span className="flex items-center gap-1.5 text-sm text-success">
              <CheckCircle2 size={15} /> Password updated
            </span>
          )}
        </div>
      </form>
    </div>
  )
}
