import { GitMerge, CheckCircle, Gift, ArrowRight, Coins } from 'lucide-react'
import { pairMatchData } from '../../data/mockData'

const iconMap: Record<string, React.ReactNode> = {
  pair: <GitMerge size={18} className="text-purple-500" />,
  check: <CheckCircle size={18} className="text-green-500" />,
  gift: <Gift size={18} className="text-orange-400" />,
  forward: <ArrowRight size={18} className="text-blue-500" />,
  bonus: <Coins size={18} className="text-yellow-500" />,
}

export default function PairMatchSummary() {
  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 flex flex-col">
      <h2 className="text-sm font-semibold text-gray-700 mb-4">Pair Match Summary</h2>

      <div className="flex-1 space-y-3">
        {pairMatchData.map((item) => (
          <div key={item.label} className="flex items-center justify-between py-1.5 border-b border-gray-50 last:border-0">
            <div className="flex items-center gap-2.5">
              {iconMap[item.icon]}
              <span className="text-sm text-gray-600">{item.label}</span>
            </div>
            <span className={`text-sm font-bold ${item.isAmount ? 'text-gray-800' : 'text-gray-800'}`}>
              {item.value}
            </span>
          </div>
        ))}
      </div>

      <button className="mt-5 w-full bg-[#1E3A8A] text-white text-sm font-medium py-2.5 rounded-lg hover:bg-blue-800 transition-colors flex items-center justify-center gap-2">
        <GitMerge size={16} />
        View Pair Match Details
      </button>
    </div>
  )
}
