import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Menu, Bell, ChevronDown, Globe, User, Settings, LogOut } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import api from '../../lib/api'
import { isManagement as isManagementRole } from '../../lib/roles'
import { useLogout } from '../../lib/useLogout'
import { useNotifications } from '../../lib/useNotifications'
import type { Me } from '../../types/api'

function initials(name: string) {
  return name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2)
}

interface Props {
  onMenuClick: () => void
  breadcrumb?: string
}

export default function Topbar({ onMenuClick, breadcrumb }: Props) {
  const { i18n } = useTranslation()
  const navigate = useNavigate()
  const [langOpen, setLangOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)

  const switchLang = (lang: string) => {
    i18n.changeLanguage(lang)
    localStorage.setItem('avg_lang', lang)
    setLangOpen(false)
  }

  const { data: me = { name: 'Member', memberCode: '' } as Me } = useQuery<Me>({
    queryKey: ['me'],
    queryFn: () => api.get('/me').then((r) => r.data),
  })
  const isManagement = isManagementRole(me)

  // Bell reflects the same derived feed the Notifications page shows.
  // Management is off-tree — it has no member notifications, so skip the queries.
  const { unread } = useNotifications(!isManagement)

  const handleLogout = useLogout()

  return (
    <header className="h-16 bg-surface-card border-b border-surface-line flex items-center px-4 lg:px-6 gap-3 sticky top-0 z-20">
      <button
        onClick={onMenuClick}
        className="p-2 rounded-lg text-ink-muted hover:bg-white/10 lg:hidden cursor-pointer"
        aria-label="Open menu"
      >
        <Menu size={20} />
      </button>

      {/* Mobile logo */}
      <div className="flex items-center gap-2 lg:hidden">
        <img src="/AVGLOGO.jpeg" alt="AVG" className="w-7 h-7 rounded-lg object-cover flex-shrink-0" />
        <div className="leading-tight">
          <div className="text-xs font-bold text-ink">AGILA VETRI</div>
          <div className="text-[9px] text-ink-muted tracking-widest">GROUPS</div>
        </div>
      </div>

      {/* Breadcrumb */}
      <div className="hidden lg:flex items-center gap-1.5 text-xs text-ink-muted flex-1">
        <span>Home</span>
        {breadcrumb && (
          <>
            <span>/</span>
            <span className="text-ink font-medium">{breadcrumb}</span>
          </>
        )}
      </div>
      <div className="flex-1 lg:hidden" />

      {/* Language switcher */}
      <div className="relative">
        <button
          onClick={() => { setLangOpen(!langOpen); setProfileOpen(false) }}
          className="flex items-center gap-1.5 text-sm text-ink-muted border border-surface-line rounded-lg px-3 py-1.5 hover:bg-white/5 transition-colors cursor-pointer"
        >
          <Globe size={14} />
          <span className="hidden sm:inline font-medium">{i18n.language === 'ta' ? 'தமிழ்' : 'English'}</span>
          <ChevronDown size={12} />
        </button>
        {langOpen && (
          <div className="absolute right-0 top-full mt-1 bg-surface-card rounded-xl shadow-lg border border-surface-line overflow-hidden z-50 min-w-[120px] animate-fade-in">
            {[{ code: 'en', label: 'English' }, { code: 'ta', label: 'தமிழ்' }].map((l) => (
              <button
                key={l.code}
                onClick={() => switchLang(l.code)}
                className={`w-full text-left px-4 py-2.5 text-sm transition-colors cursor-pointer ${
                  i18n.language === l.code ? 'bg-primary-50 text-primary font-semibold' : 'hover:bg-white/5 text-ink'
                }`}
              >
                {l.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Notifications bell — hidden for the off-tree management account */}
      {!isManagement && (
        <button
          onClick={() => navigate('/notifications')}
          className="relative p-2 rounded-lg text-ink-muted hover:bg-white/10 transition-colors cursor-pointer"
          aria-label="Notifications"
        >
          <Bell size={18} />
          {unread > 0 && (
            <span className="absolute top-1 right-1 bg-danger text-white text-[9px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </button>
      )}

      {/* Profile dropdown */}
      <div className="relative">
        <button
          onClick={() => { setProfileOpen(!profileOpen); setLangOpen(false) }}
          className="flex items-center gap-2.5 pl-2 border-l border-surface-line cursor-pointer"
        >
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-primary to-violet flex items-center justify-center text-white font-bold text-xs flex-shrink-0">
            {initials(me.name)}
          </div>
          <div className="hidden sm:block text-left">
            <div className="text-sm font-semibold text-ink leading-tight">{me.name}</div>
            <div className="text-[10px] text-ink-muted">{me.memberCode}</div>
          </div>
          <ChevronDown size={13} className={`text-ink-muted hidden sm:block transition-transform ${profileOpen ? 'rotate-180' : ''}`} />
        </button>
        {profileOpen && (
          <div className="absolute right-0 top-full mt-2 bg-surface-card rounded-xl shadow-lg border border-surface-line overflow-hidden z-50 min-w-[180px] animate-fade-in">
            {!isManagement && (
              <button
                onClick={() => { setProfileOpen(false); navigate('/profile') }}
                className="w-full flex items-center gap-2.5 text-left px-4 py-2.5 text-sm text-ink hover:bg-white/5 transition-colors cursor-pointer"
              >
                <User size={14} className="text-ink-muted" /> My Profile
              </button>
            )}
            <button
              onClick={() => { setProfileOpen(false); navigate('/settings') }}
              className="w-full flex items-center gap-2.5 text-left px-4 py-2.5 text-sm text-ink hover:bg-white/5 transition-colors cursor-pointer"
            >
              <Settings size={14} className="text-ink-muted" /> Settings
            </button>
            <div className="border-t border-surface-line" />
            <button
              onClick={handleLogout}
              className="w-full flex items-center gap-2.5 text-left px-4 py-2.5 text-sm text-danger hover:bg-danger/10 transition-colors cursor-pointer"
            >
              <LogOut size={14} /> Logout
            </button>
          </div>
        )}
      </div>
    </header>
  )
}
