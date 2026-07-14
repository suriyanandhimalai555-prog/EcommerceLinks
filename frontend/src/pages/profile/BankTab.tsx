import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Loader2, CheckCircle2 } from 'lucide-react'
import { FormField } from '../../components/ui/FormField'
import api from '../../lib/api'
import type { Me } from '../../types/api'

const bankSchema = z.object({
  accountName: z.string().min(2, 'Name required'),
  accountNumber: z.string().min(9, 'Valid account number required'),
  ifsc: z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Invalid IFSC format'),
})

export function BankTab() {
  const qc = useQueryClient()
  const [bankSuccess, setBankSuccess] = useState(false)

  const { data: me } = useQuery<Me>({
    queryKey: ['me'],
    queryFn: () => api.get('/me').then((r) => r.data),
  })

  // Reactive prefill: RHF `values` re-fills the form whenever `me` loads/changes.
  const bankForm = useForm({
    resolver: zodResolver(bankSchema),
    values: {
      accountName: me?.bankAccountName ?? '',
      accountNumber: me?.bankAccountNumber ?? '',
      ifsc: me?.bankIfsc ?? '',
    },
  })

  const bankMutation = useMutation({
    mutationFn: (d: z.infer<typeof bankSchema>) => api.put('/me/bank', d),
    onSuccess: () => {
      setBankSuccess(true)
      qc.invalidateQueries({ queryKey: ['me'] })
    },
  })

  return (
    <div className="avg-card p-5">
      {bankSuccess ? (
        <div className="flex items-center gap-2 text-success">
          <CheckCircle2 size={16} /> Bank details submitted. Pending admin review.
        </div>
      ) : (
        <form
          onSubmit={bankForm.handleSubmit((d) => bankMutation.mutate(d))}
          className="space-y-4"
        >
          <FormField
            label="Account Holder Name"
            placeholder="Full name as per bank"
            {...bankForm.register('accountName')}
            error={bankForm.formState.errors.accountName?.message}
          />
          <FormField
            label="Account Number"
            placeholder="Enter account number"
            {...bankForm.register('accountNumber')}
            error={bankForm.formState.errors.accountNumber?.message}
          />
          <FormField
            label="IFSC Code"
            placeholder="SBIN0001234"
            {...bankForm.register('ifsc')}
            error={bankForm.formState.errors.ifsc?.message}
          />
          <button
            type="submit"
            disabled={bankMutation.isPending}
            className="avg-btn-primary"
          >
            {bankMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : null}
            Save Bank Details
          </button>
        </form>
      )}
    </div>
  )
}
