import { Menu, Bell, ChevronDown } from 'lucide-react'

export default function Header() {
  return (
    <header className="bg-white border-b border-gray-200 h-14 flex items-center px-6 gap-4 sticky top-0 z-10">
      <button className="text-gray-500 hover:text-gray-700">
        <Menu size={20} />
      </button>

      <div className="flex-1" />

      {/* Language */}
      <button className="flex items-center gap-2 text-sm text-gray-600 border border-gray-200 rounded-md px-3 py-1.5 hover:bg-gray-50">
        <span className="text-base">🇮🇳</span>
        <span>English</span>
        <ChevronDown size={14} />
      </button>

      {/* Notifications */}
      <button className="relative text-gray-500 hover:text-gray-700 p-1.5">
        <Bell size={20} />
        <span className="absolute -top-0.5 -right-0.5 bg-red-500 text-white text-[9px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
          3
        </span>
      </button>

      {/* User */}
      <button className="flex items-center gap-2.5 hover:bg-gray-50 rounded-lg px-2 py-1">
        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-400 to-blue-600 flex items-center justify-center text-white font-bold text-sm flex-shrink-0">
          KK
        </div>
        <div className="text-left">
          <div className="text-sm font-semibold text-gray-800 leading-tight">Karthik Kumar</div>
          <div className="text-xs text-gray-400">ID: AGV123456</div>
        </div>
        <ChevronDown size={14} className="text-gray-400" />
      </button>
    </header>
  )
}
