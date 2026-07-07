import { User, Users, UserCheck } from 'lucide-react'
import { teamStats } from '../../data/mockData'

interface NodeProps {
  name: string
  id: string
  color: string
  size?: 'lg' | 'sm'
}

function TreeNode({ name, id, color, size = 'sm' }: NodeProps) {
  const dim = size === 'lg' ? 'w-12 h-12' : 'w-10 h-10'
  return (
    <div className="flex flex-col items-center gap-1">
      <div
        className={`${dim} rounded-full flex items-center justify-center text-white shadow-md`}
        style={{ backgroundColor: color }}
      >
        <User size={size === 'lg' ? 22 : 18} />
      </div>
      <div className="text-center">
        <p className="text-xs font-semibold text-gray-700">{name}</p>
        <p className="text-[10px] text-gray-400">{id}</p>
      </div>
    </div>
  )
}

const teamIcons: Record<string, React.ReactNode> = {
  'users-left': <Users size={18} className="text-blue-600" />,
  'users-right': <Users size={18} className="text-blue-600" />,
  'users-total': <Users size={18} className="text-blue-600" />,
  'user-check': <UserCheck size={18} className="text-green-600" />,
}

export default function NetworkTree() {
  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
      <h2 className="text-sm font-semibold text-gray-700 mb-4">My Network Overview</h2>

      {/* Tree */}
      <div className="flex flex-col items-center gap-2 mb-5">
        {/* Root */}
        <TreeNode name="YOU" id="ID: AGV123456" color="#1E3A8A" size="lg" />

        {/* Connector lines */}
        <div className="flex items-start gap-16 relative">
          {/* Left connector */}
          <div className="absolute left-1/2 top-0 -translate-x-1/2 w-px h-3 bg-gray-300" />
          <div className="absolute top-3 left-[calc(50%-4rem)] right-[calc(50%-4rem)] h-px bg-gray-300" />
        </div>

        {/* L1 row */}
        <div className="flex gap-20 relative">
          {/* Vertical lines from top bar to L1 */}
          <div className="flex flex-col items-center">
            <div className="w-px h-4 bg-gray-300 mb-1" />
            <div className="text-xs font-bold text-green-600 mb-1">LEFT</div>
            <div className="w-px h-2 bg-gray-300" style={{ borderLeft: '1px dashed #9CA3AF' }} />
            <TreeNode name="P1" id="ID: AGV123457" color="#16A34A" />
          </div>
          <div className="flex flex-col items-center">
            <div className="w-px h-4 bg-gray-300 mb-1" />
            <div className="text-xs font-bold text-orange-500 mb-1">RIGHT</div>
            <div className="w-px h-2 bg-gray-300" />
            <TreeNode name="P1" id="ID: AGV123458" color="#EA580C" />
          </div>
        </div>

        {/* L2 connectors + nodes */}
        <div className="flex gap-4">
          {/* Left sub-tree */}
          <div className="flex gap-3 flex-col items-center">
            <div className="w-px h-3 bg-gray-300" />
            <div className="flex gap-8 relative">
              <div className="absolute top-0 left-4 right-4 h-px bg-gray-300" />
              <div className="flex flex-col items-center">
                <div className="w-px h-3 bg-gray-300" />
                <TreeNode name="P2" id="ID: AGV123459" color="#16A34A" />
              </div>
              <div className="flex flex-col items-center">
                <div className="w-px h-3 bg-gray-300" />
                <TreeNode name="P3" id="ID: AGV123460" color="#16A34A" />
              </div>
            </div>
          </div>

          <div className="w-8" />

          {/* Right sub-tree */}
          <div className="flex gap-3 flex-col items-center">
            <div className="w-px h-3 bg-gray-300" />
            <div className="flex gap-8 relative">
              <div className="absolute top-0 left-4 right-4 h-px bg-gray-300" />
              <div className="flex flex-col items-center">
                <div className="w-px h-3 bg-gray-300" />
                <TreeNode name="P2" id="ID: AGV123461" color="#EA580C" />
              </div>
              <div className="flex flex-col items-center">
                <div className="w-px h-3 bg-gray-300" />
                <TreeNode name="P3" id="ID: AGV123462" color="#EA580C" />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Team Stats */}
      <div className="grid grid-cols-4 gap-2 border-t border-gray-100 pt-4">
        {teamStats.map((stat) => (
          <div key={stat.label} className="flex flex-col items-center gap-1 text-center">
            <div className="flex items-center gap-1">
              {teamIcons[stat.icon]}
              <span className="text-lg font-bold text-gray-800">{stat.value}</span>
            </div>
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">{stat.label}</p>
            <p className="text-[10px] text-gray-400">{stat.sub}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
