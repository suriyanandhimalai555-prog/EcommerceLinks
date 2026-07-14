import { Routes, Route, NavLink, Navigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Badge } from '../components/ui/Badge'
import { VerifiedRow } from '../components/ui/VerifiedRow'
import { formatDate, formatINR, orDash } from '../lib/format'
import api from '../lib/api'
import type { Me, Dashboard } from '../types/api'
import { PersonalTab } from './profile/PersonalTab'
import { KycTab } from './profile/KycTab'
import { BankTab } from './profile/BankTab'
import { PasswordTab } from './profile/PasswordTab'

function initials(name: string) {
  return name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2)
}

const tabs = [
  { path: '/profile', label: 'Personal', end: true },
  { path: '/profile/kyc', label: 'KYC', end: false },
  { path: '/profile/bank', label: 'Bank', end: false },
  { path: '/profile/password', label: 'Password', end: false },
]

export default function Profile() {
  const { data: me } = useQuery<Me>({
    queryKey: ['me'],
    queryFn: () => api.get('/me').then((r) => r.data),
  })
  const { data: dash } = useQuery<Dashboard>({
    queryKey: ['dashboard'],
    queryFn: () => api.get('/dashboard').then((r) => r.data),
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
              <p className="text-sm text-ink-muted">
                ID: <span className="font-mono font-semibold text-ink">{me?.memberCode ?? '—'}</span>
              </p>
              <p className="text-sm text-ink-muted">
                Joined: {me?.joinedAt ? formatDate(me.joinedAt) : '—'}
              </p>
              <p className="text-sm text-ink-muted">
                Rank: <span className="font-semibold text-primary">{me?.currentRankName ?? '—'}</span>
              </p>
            </div>
          </div>

          {/* Routed tab pill subnav — same pattern as AdminConsole */}
          <div className="flex gap-1 bg-white/5 p-1 rounded-lg overflow-x-auto scrollbar-hide max-w-2xl">
            {tabs.map((s) => (
              <NavLink
                key={s.path}
                to={s.path}
                end={s.end}
                className={({ isActive }) =>
                  `flex-1 min-w-fit px-3 sm:px-4 py-2 text-sm font-medium rounded-md transition-all duration-200 cursor-pointer whitespace-nowrap text-center ${
                    isActive ? 'bg-white/10 text-ink shadow-sm' : 'text-ink-muted hover:text-ink'
                  }`
                }
              >
                {s.label}
              </NavLink>
            ))}
          </div>

          {/* Nested routes — each tab is a real URL */}
          <Routes>
            <Route index element={<PersonalTab />} />
            <Route path="kyc" element={<KycTab />} />
            <Route path="bank" element={<BankTab />} />
            <Route path="password" element={<PasswordTab />} />
            <Route path="*" element={<Navigate to="/profile" replace />} />
          </Routes>
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
                {
                  label: 'Total Income',
                  value: orDash(dash?.totalIncomePaise, formatINR),
                  color: 'text-success',
                },
                {
                  label: 'Pair Match Income',
                  value: orDash(dash?.pairMatchIncomePaise, formatINR),
                  color: 'text-primary',
                },
                {
                  label: 'Wallet Balance',
                  value: orDash(dash?.walletBalancePaise, formatINR),
                  color: 'text-violet',
                },
                {
                  label: 'Total Team',
                  value: dash
                    ? String(dash.counters.leftActive + dash.counters.rightActive)
                    : '—',
                  color: 'text-ink',
                },
              ].map((s) => (
                <div
                  key={s.label}
                  className="flex justify-between text-sm py-1.5 border-b border-surface-line last:border-0"
                >
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
