import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Loader2, CheckCircle2 } from 'lucide-react'
import { Tabs, TabList, TabTrigger, TabContent } from '../components/ui/Tabs'
import { VerifiedRow } from '../components/ui/VerifiedRow'
import { FormField } from '../components/ui/FormField'
import { Badge } from '../components/ui/Badge'
import { formatDate, formatINR, orDash } from '../lib/format'
import api from '../lib/api'
import type { Me, Dashboard } from '../types/api'

function initials(name: string) {
  return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
}

const kycSchema = z.object({
  pan: z.string().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'Invalid PAN format (e.g. ABCDE1234F)'),
  aadhaarLast4: z.string().length(4, 'Enter last 4 digits of Aadhaar').regex(/^\d{4}$/, 'Digits only'),
})

const bankSchema = z.object({
  accountName: z.string().min(2, 'Name required'),
  accountNumber: z.string().min(9, 'Valid account number required'),
  ifsc: z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Invalid IFSC format'),
})

export default function Profile() {
  const { data: me } = useQuery<Me>({ queryKey: ['me'], queryFn: () => api.get('/me').then((r) => r.data) })
  const { data: dash } = useQuery<Dashboard>({ queryKey: ['dashboard'], queryFn: () => api.get('/dashboard').then((r) => r.data) })
  const [kycSuccess, setKycSuccess] = useState(false)
  const [bankSuccess, setBankSuccess] = useState(false)

  const kycForm = useForm({ resolver: zodResolver(kycSchema) })
  const bankForm = useForm({ resolver: zodResolver(bankSchema) })

  const kycMutation = useMutation({
    mutationFn: (d: any) => api.put('/me/kyc', d),
    onSuccess: () => setKycSuccess(true),
  })

  const bankMutation = useMutation({
    mutationFn: (d: any) => api.put('/me/bank', d),
    onSuccess: () => setBankSuccess(true),
  })

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-ink">My Profile</h1>
        <p className="text-sm text-ink-muted">Manage your account details and verification</p>
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Left: Profile card + tabs */}
        <div className="lg:col-span-2 space-y-4">
          {/* Avatar card */}
          <div className="avg-card p-4 sm:p-6 flex items-center gap-4 sm:gap-5">
            <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-2xl bg-gradient-to-br from-primary to-violet flex items-center justify-center text-white text-xl sm:text-2xl font-bold flex-shrink-0">
              {me?.name ? initials(me.name) : '?'}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <h2 className="text-lg sm:text-xl font-bold text-ink">{me?.name ?? '—'}</h2>
                {me?.isActive && <Badge variant="success">Active</Badge>}
              </div>
              <p className="text-sm text-ink-muted">ID: <span className="font-mono font-semibold text-ink">{me?.memberCode ?? '—'}</span></p>
              <p className="text-sm text-ink-muted">Joined: {me?.joinedAt ? formatDate(me.joinedAt) : '—'}</p>
              <p className="text-sm text-ink-muted">Rank: <span className="font-semibold text-primary">{me?.currentRankName ?? '—'}</span></p>
            </div>
          </div>

          {/* Tabs */}
          <Tabs defaultValue="personal">
            <TabList className="mb-4">
              <TabTrigger value="personal">Personal</TabTrigger>
              <TabTrigger value="kyc">KYC</TabTrigger>
              <TabTrigger value="bank">Bank</TabTrigger>
              <TabTrigger value="password">Password</TabTrigger>
            </TabList>

            <TabContent value="personal">
              <div key={me?.memberCode} className="avg-card p-5 space-y-4">
                <FormField label="Full Name" defaultValue={me?.name} />
                <FormField label="Email" type="email" defaultValue={me?.email} />
                <FormField label="Phone" defaultValue={me?.phone} readOnly
                  hint="To change your phone number, please raise a support ticket." />
                <FormField label="Sponsor Code" defaultValue={me?.sponsorCode} readOnly />
                <button className="avg-btn-primary">Save Changes</button>
              </div>
            </TabContent>

            <TabContent value="kyc">
              <div className="avg-card p-5">
                {kycSuccess ? (
                  <div className="flex items-center gap-2 text-success">
                    <CheckCircle2 size={16} /> KYC submitted. Pending admin review.
                  </div>
                ) : (
                  <form onSubmit={kycForm.handleSubmit((d) => kycMutation.mutate(d))} className="space-y-4">
                    <FormField label="PAN Number" placeholder="ABCDE1234F" {...kycForm.register('pan')} error={kycForm.formState.errors.pan?.message} />
                    <FormField
                      label="Aadhaar Last 4 Digits"
                      type="number"
                      maxLength={4}
                      placeholder="XXXX"
                      {...kycForm.register('aadhaarLast4')}
                      error={kycForm.formState.errors.aadhaarLast4?.message}
                    />
                    <div className="p-3 bg-warning-50 border border-warning/20 rounded-lg text-xs text-ink-muted">
                      📎 Document upload coming soon. Only text fields required now.
                    </div>
                    <button type="submit" disabled={kycMutation.isPending} className="avg-btn-primary">
                      {kycMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : null}
                      Submit KYC
                    </button>
                  </form>
                )}
              </div>
            </TabContent>

            <TabContent value="bank">
              <div className="avg-card p-5">
                {bankSuccess ? (
                  <div className="flex items-center gap-2 text-success">
                    <CheckCircle2 size={16} /> Bank details submitted. Pending admin review.
                  </div>
                ) : (
                  <form onSubmit={bankForm.handleSubmit((d) => bankMutation.mutate(d))} className="space-y-4">
                    <FormField label="Account Holder Name" placeholder="Full name as per bank" {...bankForm.register('accountName')} error={bankForm.formState.errors.accountName?.message} />
                    <FormField label="Account Number" placeholder="Enter account number" {...bankForm.register('accountNumber')} error={bankForm.formState.errors.accountNumber?.message} />
                    <FormField label="IFSC Code" placeholder="SBIN0001234" {...bankForm.register('ifsc')} error={bankForm.formState.errors.ifsc?.message} />
                    <button type="submit" disabled={bankMutation.isPending} className="avg-btn-primary">
                      {bankMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : null}
                      Save Bank Details
                    </button>
                  </form>
                )}
              </div>
            </TabContent>

            <TabContent value="password">
              <div className="avg-card p-5 space-y-4">
                <FormField label="Current Password" type="password" placeholder="••••••••" />
                <FormField label="New Password" type="password" placeholder="Min 8 characters" />
                <FormField label="Confirm New Password" type="password" placeholder="Repeat new password" />
                <button className="avg-btn-primary">Update Password</button>
              </div>
            </TabContent>
          </Tabs>
        </div>

        {/* Right rail */}
        <div className="space-y-4">
          {/* Verification */}
          <div className="avg-card p-5">
            <h3 className="text-sm font-semibold text-ink mb-3">Account Verification</h3>
            <VerifiedRow label="Email" status={me?.email ? 'verified' : 'pending'} />
            <VerifiedRow label="Mobile" status="verified" />
            <VerifiedRow label="KYC" status={(me?.kycStatus ?? 'pending') as any} />
            <VerifiedRow label="Bank" status={(me?.bankStatus ?? 'pending') as any} />
          </div>

          {/* Account summary */}
          <div className="avg-card p-5">
            <h3 className="text-sm font-semibold text-ink mb-3">Account Summary</h3>
            <div className="space-y-2">
              {[
                { label: 'Total Income', value: orDash(dash?.totalIncomePaise, formatINR), color: 'text-success' },
                { label: 'Pair Match Income', value: orDash(dash?.pairMatchIncomePaise, formatINR), color: 'text-primary' },
                { label: 'Wallet Balance', value: orDash(dash?.walletBalancePaise, formatINR), color: 'text-violet' },
                { label: 'Total Team', value: dash ? String(dash.counters.leftActive + dash.counters.rightActive) : '—', color: 'text-ink' },
              ].map(s => (
                <div key={s.label} className="flex justify-between text-sm py-1.5 border-b border-surface-line last:border-0">
                  <span className="text-ink-muted">{s.label}</span>
                  <span className={`font-semibold ${s.color}`}>{s.value}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
