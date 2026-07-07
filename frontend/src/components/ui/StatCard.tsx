import { type ReactNode } from 'react'
import { TrendingUp } from 'lucide-react'

interface Props {
  label: ReactNode
  value: string
  sub?: ReactNode
  icon: ReactNode
  tint: 'primary' | 'success' | 'warning' | 'violet'
  trend?: number
  className?: string
}

const tintMap = {
  primary: { bg: 'bg-primary-50', icon: 'bg-primary', text: 'text-primary' },
  success: { bg: 'bg-success-50', icon: 'bg-success', text: 'text-success' },
  warning: { bg: 'bg-warning-50', icon: 'bg-warning', text: 'text-warning' },
  violet: { bg: 'bg-violet-50', icon: 'bg-violet', text: 'text-violet' },
}

export function StatCard({ label, value, sub, icon, tint, trend, className = '' }: Props) {
  const colors = tintMap[tint]
  return (
    <div className={`avg-card p-3 sm:p-5 flex items-center justify-between group hover:shadow-md transition-shadow duration-200 animate-fade-in ${className}`}>
      <div className="flex-1 min-w-0">
        <p className="text-[10px] sm:text-xs font-semibold text-ink-muted uppercase tracking-wider mb-1 truncate">{label}</p>
        <p className="text-lg sm:text-2xl font-bold text-ink leading-tight mb-1 truncate">{value}</p>
        {sub && <p className="text-[10px] sm:text-xs text-ink-muted truncate">{sub}</p>}
        {trend !== undefined && (
          <div className={`flex items-center gap-1 mt-1 text-xs font-medium ${trend >= 0 ? 'text-success' : 'text-danger'}`}>
            <TrendingUp size={11} className={trend < 0 ? 'rotate-180' : ''} />
            <span>{trend >= 0 ? '+' : ''}{trend}% this week</span>
          </div>
        )}
      </div>
      <div className={`w-9 h-9 sm:w-12 sm:h-12 rounded-xl ${colors.icon} flex items-center justify-center flex-shrink-0 ml-2 sm:ml-4 group-hover:scale-105 transition-transform duration-200`}>
        <div className="text-white [&>svg]:w-4 [&>svg]:h-4 sm:[&>svg]:w-5 sm:[&>svg]:h-5">{icon}</div>
      </div>
    </div>
  )
}
