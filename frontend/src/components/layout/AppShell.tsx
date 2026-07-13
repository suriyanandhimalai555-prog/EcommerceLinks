import { Suspense, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { SkeletonCard } from '../ui/Skeleton'
import Sidebar from './Sidebar'
import Topbar from './Topbar'

const breadcrumbMap: Record<string, string> = {
  '/': 'Dashboard',
  '/profile': 'My Profile',
  '/network': 'My Network',
  '/buy': 'Buy Product',
  '/pairs': 'Pair Match',
  '/wallet': 'Wallet',
  '/payouts': 'Payout History',
  '/directs': 'Direct Members',
  '/income': 'Income Report',
  '/ranks': 'Rank & Rewards',
  '/support': 'Support Ticket',
  '/notifications': 'Notifications',
  '/settings': 'Settings',
  '/admin': 'Admin Console',
  '/admin/members': 'Admin · Members',
  '/admin/kyc': 'Admin · KYC Approvals',
  '/admin/products': 'Admin · Products',
  '/admin/ranks': 'Admin · Rank Approvals',
  '/admin/payouts': 'Admin · Payouts',
  '/admin/system': 'Admin · System Health',
  '/admin/audit': 'Admin · Audit Log',
}

export default function AppShell() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const location = useLocation()
  const breadcrumb =
    breadcrumbMap[location.pathname] ??
    (/^\/buy\/\d+$/.test(location.pathname) ? 'Product Details' : undefined)

  return (
    <div className="flex h-screen overflow-hidden bg-surface-page">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden lg:ml-0">
        <Topbar onMenuClick={() => setSidebarOpen(true)} breadcrumb={breadcrumb} />
        <main className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin">
          <div className="w-full max-w-[1400px] mx-auto px-3 py-4 sm:px-4 lg:p-6 animate-fade-in">
            {/* Keeps the shell visible while a lazily-loaded page chunk downloads */}
            <Suspense fallback={<SkeletonCard lines={4} />}>
              <Outlet />
            </Suspense>
          </div>
        </main>
      </div>
    </div>
  )
}
