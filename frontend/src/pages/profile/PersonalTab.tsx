import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Loader2, CheckCircle2 } from 'lucide-react'
import { FormField } from '../../components/ui/FormField'
import api from '../../lib/api'
import type { Me } from '../../types/api'

const personalSchema = z.object({
  name: z.string().trim().min(2, 'Name is required'),
})

export function PersonalTab() {
  const qc = useQueryClient()
  const [saved, setSaved] = useState(false)

  const { data: me } = useQuery<Me>({
    queryKey: ['me'],
    queryFn: () => api.get('/me').then((r) => r.data),
  })

  // Reactive prefill — RHF `values` re-hydrates the form when `me` loads.
  const form = useForm({
    resolver: zodResolver(personalSchema),
    values: { name: me?.name ?? '' },
  })

  const mutation = useMutation({
    mutationFn: (d: z.infer<typeof personalSchema>) => api.put('/me/profile', d),
    onSuccess: () => {
      setSaved(true)
      qc.invalidateQueries({ queryKey: ['me'] })
    },
  })

  return (
    <div className="avg-card p-5 space-y-4">
      <form onSubmit={form.handleSubmit((d) => { setSaved(false); mutation.mutate(d) })} className="space-y-4">
        <FormField
          label="Full Name"
          placeholder="Your full name"
          {...form.register('name')}
          error={form.formState.errors.name?.message}
        />

        {/* Read-only fields — changes via support ticket */}
        <FormField
          label="Email"
          type="email"
          defaultValue={me?.email}
          readOnly
          hint="To change your email, please raise a support ticket."
        />
        <FormField
          label="Phone"
          defaultValue={me?.phone}
          readOnly
          hint="To change your phone number, please raise a support ticket."
        />
        <FormField label="Sponsor Code" defaultValue={me?.sponsorCode} readOnly />

        <div className="flex items-center gap-3">
          <button type="submit" disabled={mutation.isPending} className="avg-btn-primary">
            {mutation.isPending ? <Loader2 size={14} className="animate-spin" /> : null}
            Save Changes
          </button>
          {saved && !mutation.isPending && (
            <span className="flex items-center gap-1.5 text-sm text-success">
              <CheckCircle2 size={15} /> Saved
            </span>
          )}
        </div>
      </form>
    </div>
  )
}
