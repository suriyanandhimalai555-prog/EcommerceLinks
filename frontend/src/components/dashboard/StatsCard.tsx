import { Wallet, Network, Users, CreditCard } from 'lucide-react'

interface StatsCardProps {
  label: string
  value: string
  sub: string
  color: string
  bg?: string
  icon: string
}

const iconMap: Record<string, React.ReactNode> = {
  wallet: <Wallet size={28} className="text-white" />,
  network: <Network size={28} className="text-white" />,
  users: <Users size={28} className="text-white" />,
  'credit-card': <CreditCard size={28} className="text-white" />,
}

export default function StatsCard({ label, value, sub, color, icon }: StatsCardProps) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 p-4 flex items-center justify-between flex-1 min-w-0 shadow-sm">
      <div>
        <p className="text-xs font-semibold text-gray-400 tracking-wider uppercase mb-1">{label}</p>
        <p className="text-2xl font-bold text-gray-800 mb-1">{value}</p>
        <p className="text-xs text-gray-400">{sub}</p>
      </div>
      <div
        className="w-14 h-14 rounded-full flex items-center justify-center flex-shrink-0"
        style={{ backgroundColor: color }}
      >
        {iconMap[icon]}
      </div>
    </div>
  )
}
