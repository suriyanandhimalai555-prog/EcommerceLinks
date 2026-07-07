import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Globe, Bell, LogOut, Shield } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { tokenStore } from '../lib/auth'

export default function Settings() {
  const { i18n } = useTranslation()
  const navigate = useNavigate()
  const [emailNotif, setEmailNotif] = useState(true)
  const [smsNotif, setSmsNotif] = useState(false)
  const [pairNotif, setPairNotif] = useState(true)

  const handleLogoutAll = () => {
    tokenStore.clear()
    navigate('/login')
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-xl font-bold text-ink">Settings</h1>
        <p className="text-sm text-ink-muted">Manage your preferences</p>
      </div>

      {/* Language */}
      <div className="avg-card p-5">
        <div className="flex items-center gap-2 mb-4">
          <Globe size={16} className="text-primary" />
          <h2 className="text-sm font-semibold text-ink">Language</h2>
        </div>
        <div className="flex gap-3">
          {[{ code: 'en', label: 'English', flag: '🇬🇧' }, { code: 'ta', label: 'தமிழ்', flag: '🇮🇳' }].map(l => (
            <button
              key={l.code}
              onClick={() => { i18n.changeLanguage(l.code); localStorage.setItem('avg_lang', l.code) }}
              className={`flex items-center gap-2 border rounded-xl px-4 py-3 text-sm font-medium transition-all cursor-pointer ${
                i18n.language === l.code ? 'border-primary bg-primary-50 text-primary' : 'border-surface-line hover:border-primary/50'
              }`}
            >
              <span className="text-lg">{l.flag}</span> {l.label}
            </button>
          ))}
        </div>
      </div>

      {/* Notifications (local-only v1) */}
      <div className="avg-card p-5">
        <div className="flex items-center gap-2 mb-4">
          <Bell size={16} className="text-primary" />
          <h2 className="text-sm font-semibold text-ink">Notifications</h2>
          <span className="text-[10px] text-ink-muted bg-gray-100 px-2 py-0.5 rounded">Local preferences</span>
        </div>
        <div className="space-y-4">
          {[
            { label: 'Email notifications', value: emailNotif, set: setEmailNotif },
            { label: 'SMS notifications', value: smsNotif, set: setSmsNotif },
            { label: 'Pair match alerts', value: pairNotif, set: setPairNotif },
          ].map(item => (
            <div key={item.label} className="flex items-center justify-between">
              <span className="text-sm text-ink">{item.label}</span>
              <button
                onClick={() => item.set(!item.value)}
                className={`relative w-11 h-6 rounded-full transition-colors duration-200 cursor-pointer ${item.value ? 'bg-primary' : 'bg-gray-200'}`}
                role="switch"
                aria-checked={item.value}
              >
                <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${item.value ? 'translate-x-5' : 'translate-x-0'}`} />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Security */}
      <div className="avg-card p-5">
        <div className="flex items-center gap-2 mb-4">
          <Shield size={16} className="text-primary" />
          <h2 className="text-sm font-semibold text-ink">Security</h2>
        </div>
        <div className="space-y-3">
          <p className="text-sm text-ink-muted">Signing out from all devices will invalidate all active sessions.</p>
          <button
            onClick={handleLogoutAll}
            className="flex items-center gap-2 border border-danger/30 bg-red-50 text-danger rounded-lg px-4 py-2.5 text-sm font-semibold hover:bg-red-100 transition-colors cursor-pointer"
          >
            <LogOut size={15} /> Logout from all devices
          </button>
        </div>
      </div>
    </div>
  )
}
