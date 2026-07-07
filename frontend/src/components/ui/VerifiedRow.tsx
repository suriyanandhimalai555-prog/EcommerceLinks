import { CheckCircle2, Clock, XCircle } from 'lucide-react'

interface Props {
  label: string
  status: 'verified' | 'pending' | 'rejected'
}

const statusConfig = {
  verified: { icon: CheckCircle2, text: 'Verified', cls: 'text-success' },
  pending: { icon: Clock, text: 'Pending', cls: 'text-warning' },
  rejected: { icon: XCircle, text: 'Rejected', cls: 'text-danger' },
}

export function VerifiedRow({ label, status }: Props) {
  const cfg = statusConfig[status]
  const Icon = cfg.icon
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-surface-line last:border-0">
      <span className="text-sm text-ink-muted">{label}</span>
      <div className={`flex items-center gap-1.5 ${cfg.cls}`}>
        <Icon size={14} />
        <span className="text-xs font-semibold">{cfg.text}</span>
      </div>
    </div>
  )
}
