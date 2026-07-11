import { NavLink, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import {
  LayoutDashboard, User, Network, ShoppingBag, GitMerge, Wallet,
  Clock, Users, BarChart2, GitFork, Trophy, TicketCheck, Bell,
  Settings, LogOut, X,
} from 'lucide-react'
import { logout } from '../../lib/auth'

const navItems = [
  { key: 'dashboard', icon: LayoutDashboard, path: '/' },
  { key: 'profile', icon: User, path: '/profile' },
  { key: 'network', icon: Network, path: '/network' },
  { key: 'buyProduct', icon: ShoppingBag, path: '/buy' },
  { key: 'pairMatch', icon: GitMerge, path: '/pairs' },
  { key: 'wallet', icon: Wallet, path: '/wallet' },
  { key: 'payoutHistory', icon: Clock, path: '/payouts' },
  { key: 'directMembers', icon: Users, path: '/directs' },
  { key: 'incomeReport', icon: BarChart2, path: '/income' },
  { key: 'genealogy', icon: GitFork, path: '/genealogy' },
  { key: 'rankRewards', icon: Trophy, path: '/ranks' },
  { key: 'support', icon: TicketCheck, path: '/support' },
  { key: 'notifications', icon: Bell, path: '/notifications' },
  { key: 'settings', icon: Settings, path: '/settings' },
]

interface Props {
  open?: boolean
  onClose?: () => void
}

export default function Sidebar({ open = true, onClose }: Props) {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const queryClient = useQueryClient()

  const handleLogout = async () => {
    await logout()
    queryClient.clear()
    navigate('/login')
  }

  return (
    <>
      {/* Mobile overlay */}
      {onClose && open && (
        <div className="fixed inset-0 bg-black/40 z-30 lg:hidden" onClick={onClose} />
      )}

      <aside
        className={`
          fixed top-0 left-0 h-screen w-60 bg-surface-card border-r border-surface-line z-40 flex flex-col
          transition-transform duration-250 ease-out
          ${open ? 'translate-x-0' : '-translate-x-full'}
          lg:translate-x-0 lg:static lg:z-auto
        `}
      >
        {/* Logo */}
        <div className="px-5 py-4 border-b border-surface-line flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src="/AVGLOGO.jpeg" alt="AVG Logo" className="w-9 h-9 rounded-xl object-cover flex-shrink-0" />
            <div>
              <div className="text-sm font-bold text-ink leading-tight">AGILA VETRI</div>
              <div className="text-[10px] text-ink-muted tracking-widest font-medium">GROUPS</div>
            </div>
          </div>
          {onClose && (
            <button onClick={onClose} className="p-1 rounded-lg hover:bg-white/10 text-ink-muted lg:hidden cursor-pointer" aria-label="Close sidebar">
              <X size={16} />
            </button>
          )}
        </div>

        {/* Nav */}
        <nav className="flex-1 py-3 overflow-y-auto scrollbar-thin">
          {navItems.map((item) => {
            const Icon = item.icon
            return (
              <NavLink
                key={item.path}
                to={item.path}
                end={item.path === '/'}
                onClick={() => onClose?.()}
                className={({ isActive }) =>
                  `flex items-center gap-3 mx-2 px-3 py-2.5 rounded-xl text-sm transition-all duration-150 ${
                    isActive
                      ? 'bg-primary text-white font-semibold shadow-sm'
                      : 'text-ink-muted hover:bg-primary-50 hover:text-primary font-medium'
                  }`
                }
              >
                <Icon size={17} className="flex-shrink-0" />
                <span>{t(`nav.${item.key}`)}</span>
              </NavLink>
            )
          })}
        </nav>

        {/* Logout */}
        <div className="p-3 border-t border-surface-line">
          <button
            onClick={handleLogout}
            className="w-full flex items-center gap-3 mx-0 px-3 py-2.5 rounded-xl text-sm font-medium text-ink-muted hover:bg-danger/10 hover:text-danger transition-all duration-150 cursor-pointer"
          >
            <LogOut size={17} />
            <span>{t('nav.logout')}</span>
          </button>
        </div>
      </aside>
    </>
  )
}
