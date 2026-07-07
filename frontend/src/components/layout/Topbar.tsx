import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Menu, Bell, ChevronDown, Globe } from 'lucide-react'
import { mockMe } from '../../mocks/data'

function initials(name: string) {
  return name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2)
}

interface Props {
  onMenuClick: () => void
  breadcrumb?: string
  unreadCount?: number
}

export default function Topbar({ onMenuClick, breadcrumb, unreadCount = 3 }: Props) {
  const { i18n } = useTranslation()
  const [langOpen, setLangOpen] = useState(false)

  const switchLang = (lang: string) => {
    i18n.changeLanguage(lang)
    localStorage.setItem('avg_lang', lang)
    setLangOpen(false)
  }

  const me = mockMe

  return (
    <header className="h-16 bg-white border-b border-surface-line flex items-center px-4 lg:px-6 gap-3 sticky top-0 z-20">
      <button
        onClick={onMenuClick}
        className="p-2 rounded-lg text-ink-muted hover:bg-gray-100 lg:hidden cursor-pointer"
        aria-label="Open menu"
      >
        <Menu size={20} />
      </button>

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
          onClick={() => setLangOpen(!langOpen)}
          className="flex items-center gap-1.5 text-sm text-ink-muted border border-surface-line rounded-lg px-3 py-1.5 hover:bg-gray-50 transition-colors cursor-pointer"
        >
          <Globe size={14} />
          <span className="hidden sm:inline font-medium">{i18n.language === 'ta' ? 'தமிழ்' : 'English'}</span>
          <ChevronDown size={12} />
        </button>
        {langOpen && (
          <div className="absolute right-0 top-full mt-1 bg-white rounded-xl shadow-lg border border-surface-line overflow-hidden z-50 min-w-[120px] animate-fade-in">
            {[{ code: 'en', label: 'English' }, { code: 'ta', label: 'தமிழ்' }].map((l) => (
              <button
                key={l.code}
                onClick={() => switchLang(l.code)}
                className={`w-full text-left px-4 py-2.5 text-sm transition-colors cursor-pointer ${
                  i18n.language === l.code ? 'bg-primary-50 text-primary font-semibold' : 'hover:bg-gray-50 text-ink'
                }`}
              >
                {l.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Notifications bell */}
      <button className="relative p-2 rounded-lg text-ink-muted hover:bg-gray-100 transition-colors cursor-pointer" aria-label="Notifications">
        <Bell size={18} />
        {unreadCount > 0 && (
          <span className="absolute top-1 right-1 bg-danger text-white text-[9px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {/* Avatar */}
      <div className="flex items-center gap-2.5 pl-2 border-l border-surface-line">
        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-primary to-violet flex items-center justify-center text-white font-bold text-xs flex-shrink-0">
          {initials(me.name)}
        </div>
        <div className="hidden sm:block text-left">
          <div className="text-sm font-semibold text-ink leading-tight">{me.name}</div>
          <div className="text-[10px] text-ink-muted">{me.memberCode}</div>
        </div>
        <ChevronDown size={13} className="text-ink-muted hidden sm:block" />
      </div>
    </header>
  )
}
