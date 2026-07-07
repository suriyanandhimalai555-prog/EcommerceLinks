import { ShoppingBag, GitFork, Users, BarChart2, Clock, HelpCircle, Copy, Trophy, ChevronRight } from 'lucide-react'
import { quickLinks } from '../../data/mockData'
import { useNavigate } from 'react-router-dom'

const quickLinkIcons: Record<string, React.ReactNode> = {
  'shopping-bag': <ShoppingBag size={15} />,
  'git-fork': <GitFork size={15} />,
  users: <Users size={15} />,
  'bar-chart': <BarChart2 size={15} />,
  clock: <Clock size={15} />,
  'help-circle': <HelpCircle size={15} />,
}

export default function RightPanel() {
  const navigate = useNavigate()

  return (
    <div className="w-48 flex-shrink-0 flex flex-col gap-4">
      {/* Quick Links */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
        <h3 className="text-sm font-semibold text-gray-700 mb-3">Quick Links</h3>
        <div className="space-y-1">
          {quickLinks.map((link) => (
            <button
              key={link.label}
              onClick={() => navigate(link.path)}
              className="w-full flex items-center gap-2 text-xs text-gray-600 hover:text-blue-700 hover:bg-blue-50 rounded-md px-2 py-1.5 transition-colors text-left"
            >
              <span className="text-gray-400">{quickLinkIcons[link.icon]}</span>
              <span className="flex-1">{link.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Refer & Earn */}
      <div className="bg-[#1E3A8A] rounded-xl p-4 text-white relative overflow-hidden">
        <div className="absolute -right-4 -bottom-4 w-20 h-20 bg-blue-700 rounded-full opacity-30" />
        <div className="absolute -right-1 -top-4 w-14 h-14 bg-blue-500 rounded-full opacity-20" />
        <p className="text-sm font-bold mb-1 relative z-10">Refer & Earn More</p>
        <p className="text-[10px] text-blue-200 mb-3 relative z-10">Share your referral link and earn unlimited income</p>
        <button className="relative z-10 bg-white text-[#1E3A8A] text-xs font-semibold py-1.5 px-3 rounded-md flex items-center gap-1.5 hover:bg-blue-50 transition-colors w-full justify-center">
          <Copy size={12} />
          Copy Referral Link
        </button>
      </div>

      {/* Rank & Status */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
        <h3 className="text-sm font-semibold text-gray-700 mb-3">Rank & Status</h3>
        <div className="flex items-center gap-2 mb-3">
          <div className="w-10 h-10 bg-gray-100 rounded-full flex items-center justify-center">
            <Trophy size={18} className="text-gray-400" />
          </div>
          <div>
            <p className="text-[10px] text-gray-400">Current Rank</p>
            <p className="text-sm font-bold text-gray-700">Silver Executive</p>
          </div>
        </div>
        <div className="space-y-1.5 text-xs mb-3">
          <div className="flex justify-between">
            <span className="text-gray-500">Total PV</span>
            <span className="font-semibold text-gray-700">1,28,000</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Total BV</span>
            <span className="font-semibold text-gray-700">2,10,000</span>
          </div>
        </div>
        <button className="w-full bg-[#1E3A8A] text-white text-xs font-semibold py-2 rounded-lg hover:bg-blue-800 transition-colors flex items-center justify-center gap-1">
          View Rank Benefits
          <ChevronRight size={12} />
        </button>
      </div>
    </div>
  )
}
