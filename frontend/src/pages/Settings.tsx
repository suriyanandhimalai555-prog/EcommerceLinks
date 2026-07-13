import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Globe, Bell, LogOut, Shield, Zap } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { logout } from '../lib/auth'
import api from '../lib/api'
import { isStaff } from '../lib/roles'
import type { Me } from '../types/api'

export default function Settings() {
  const { i18n } = useTranslation()
  const navigate = useNavigate()
  const [emailNotif, setEmailNotif] = useState(true)
  const [smsNotif, setSmsNotif] = useState(false)
  const [pairNotif, setPairNotif] = useState(true)

  const queryClient = useQueryClient()

  const { data: me } = useQuery<Me>({
    queryKey: ['me'],
    queryFn: () => api.get('/me').then(r => r.data),
  })

  const handleLogoutAll = async () => {
    await logout()
    queryClient.clear()
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
          <span className="text-[10px] text-ink-muted bg-white/5 px-2 py-0.5 rounded">Local preferences</span>
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
                className={`relative w-11 h-6 rounded-full transition-colors duration-200 cursor-pointer ${item.value ? 'bg-primary' : 'bg-white/10'}`}
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
            className="flex items-center gap-2 border border-danger/30 bg-danger/10 text-danger rounded-lg px-4 py-2.5 text-sm font-semibold hover:bg-danger/20 transition-colors cursor-pointer"
          >
            <LogOut size={15} /> Logout from all devices
          </button>
        </div>
      </div>

      {/* Admin controls now live in the Admin Console */}
      {isStaff(me) && (
        <div className="avg-card p-5 border-l-4 border-warning">
          <div className="flex items-center gap-2 mb-3">
            <Zap size={16} className="text-warning" />
            <h2 className="text-sm font-semibold text-ink">Admin Controls</h2>
          </div>
          <p className="text-sm text-ink-muted mb-3">
            Member management, rank verification, payouts, pipeline health and the audit trail
            live in the Admin Console.
          </p>
          <button onClick={() => navigate('/admin')} className="avg-btn-primary">
            <Zap size={15} /> Open Admin Console
          </button>
        </div>
      )}
    </div>
  )
}
