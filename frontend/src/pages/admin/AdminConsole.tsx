import { Routes, Route, NavLink, Navigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import api from '../../lib/api'
import { isManagement } from '../../lib/roles'
import type { Me } from '../../types/api'
import { OverviewTab } from './OverviewTab'
import { MembersTab } from './MembersTab'
import { ProductsTab } from './ProductsTab'
import { KycTab } from './KycTab'
import { BankTab } from './BankTab'
import { RanksTab } from './RanksTab'
import { PayoutsTab } from './PayoutsTab'
import { SystemTab } from './SystemTab'
import { AuditTab } from './AuditTab'
import { SettingsTab } from './SettingsTab'
import { OrdersTab } from './OrdersTab'
import { RecordPaymentTab } from './RecordPaymentTab'

const sections = [
  { path: '/admin', label: 'Overview', end: true },
  { path: '/admin/members', label: 'Members', end: false },
  { path: '/admin/orders', label: 'Orders', end: false },
  { path: '/admin/ranks', label: 'Ranks', end: false },
  { path: '/admin/payouts', label: 'Payouts', end: false },
  { path: '/admin/system', label: 'System', end: false },
  { path: '/admin/audit', label: 'Audit', end: false },
]

export default function AdminConsole() {
  const { t } = useTranslation()
  const { data: me } = useQuery<Me>({
    queryKey: ['me'],
    queryFn: () => api.get('/me').then((r) => r.data),
  })
  // Management navigates these pages from the sidebar; the pill subnav is for
  // appointed admins whose sidebar shows the member menu + one console entry.
  const showSubnav = !isManagement(me)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-ink">{t('nav.admin')}</h1>
        <p className="text-sm text-ink-muted">Management controls for members, ranks, payouts and the event pipeline</p>
      </div>

      {showSubnav && (
        <div className="flex gap-1 bg-white/5 p-1 rounded-lg overflow-x-auto scrollbar-hide max-w-2xl">
          {sections.map((s) => (
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
      )}

      <Routes>
        <Route index element={<OverviewTab />} />
        <Route path="members" element={<MembersTab />} />
        <Route path="orders" element={<OrdersTab />} />
        {/* Product CRUD, KYC approvals, and system settings are management-only (backend enforces regardless) */}
        {isManagement(me) && <Route path="products" element={<ProductsTab />} />}
        {isManagement(me) && <Route path="kyc" element={<KycTab />} />}
        {isManagement(me) && <Route path="bank" element={<BankTab />} />}
        {isManagement(me) && <Route path="settings" element={<SettingsTab />} />}
        {isManagement(me) && <Route path="record-payment" element={<RecordPaymentTab />} />}
        <Route path="ranks" element={<RanksTab />} />
        <Route path="payouts" element={<PayoutsTab />} />
        <Route path="system" element={<SystemTab />} />
        <Route path="audit" element={<AuditTab />} />
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Routes>
    </div>
  )
}
