import { GitMerge, Zap, ShoppingBag, ArrowUpCircle } from 'lucide-react'
import { recentTransactions } from '../../data/mockData'

const iconMap: Record<string, React.ReactNode> = {
  'pair-match': <GitMerge size={18} />,
  direct: <Zap size={18} />,
  product: <ShoppingBag size={18} />,
  withdrawal: <ArrowUpCircle size={18} />,
}

export default function RecentTransactions() {
  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-gray-700">Recent Transactions</h2>
        <button className="text-xs text-blue-600 hover:underline font-medium">View All</button>
      </div>

      <div className="space-y-3">
        {recentTransactions.map((tx) => (
          <div key={tx.id} className="flex items-center gap-3">
            <div
              className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0"
              style={{ backgroundColor: tx.bg, color: tx.color }}
            >
              {iconMap[tx.icon]}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-700 truncate">{tx.name}</p>
              <p className="text-xs text-gray-400">{tx.date}</p>
            </div>
            <div className="text-right flex-shrink-0">
              <p className={`text-sm font-bold ${tx.positive ? 'text-green-600' : 'text-red-500'}`}>
                {tx.amount}
              </p>
              <p className={`text-xs ${tx.positive ? 'text-green-500' : 'text-red-400'}`}>
                {tx.type}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
