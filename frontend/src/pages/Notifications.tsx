import { GitMerge, Trophy, Bell } from 'lucide-react'
import { formatDateTime } from '../lib/format'
import { useNotifications } from '../lib/useNotifications'
import { EmptyState } from '../components/ui/EmptyState'

export default function Notifications() {
  const { notifications, unread } = useNotifications()

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-ink">Notifications</h1>
          <p className="text-sm text-ink-muted">{unread} unread notifications</p>
        </div>
      </div>

      <div className="avg-card divide-y divide-surface-line">
        {notifications.length === 0 ? (
          <EmptyState icon={Bell} title="No notifications" description="You're all caught up!" />
        ) : notifications.map(n => (
          <div key={n.id} className={`flex items-start gap-3 p-4 transition-colors hover:bg-white/5 ${!n.read ? 'bg-primary-50/40' : ''}`}>
            <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${n.type === 'wallet' ? 'bg-success-50 text-success' : 'bg-warning-50 text-warning'}`}>
              {n.type === 'wallet' ? <GitMerge size={15} /> : <Trophy size={15} />}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-sm font-semibold text-ink">{n.title}</p>
                {!n.read && <span className="w-2 h-2 rounded-full bg-primary flex-shrink-0" />}
              </div>
              <p className="text-xs text-ink-muted">{n.description}</p>
              <p className="text-[10px] text-ink-muted mt-0.5">{n.at ? formatDateTime(n.at) : ''}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
