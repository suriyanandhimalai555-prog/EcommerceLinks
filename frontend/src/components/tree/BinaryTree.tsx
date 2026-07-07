import { useState } from 'react'
import { ZoomIn, ZoomOut, Maximize2, ChevronLeft, UserPlus, Copy } from 'lucide-react'
import type { TreeNode } from '../../types/api'
import { computeLayout, type LayoutNode } from './useTreeLayout'

const NODE_W = 150
const NODE_H = 64

function initials(name: string) {
  return name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2)
}

interface NodeCardProps {
  ln: LayoutNode
  onClick: (code: string) => void
  referralBase?: string
}

function NodeCard({ ln, onClick }: NodeCardProps) {
  const { node, x, y } = ln
  const isVacant = node.name === 'Vacant'

  const handleCopyReferral = (e: React.MouseEvent) => {
    e.stopPropagation()
    const leg = node.position === 'L' ? 'L' : 'R'
    navigator.clipboard.writeText(`${window.location.origin}/register?leg=${leg}`)
  }

  if (isVacant) {
    return (
      <g
        transform={`translate(${x}, ${y})`}
        onClick={handleCopyReferral}
        className="cursor-pointer"
      >
        <rect
          width={NODE_W} height={NODE_H}
          rx={8} ry={8}
          fill="white"
          stroke="#E5E7EB"
          strokeWidth={1.5}
          strokeDasharray="6 3"
        />
        <g transform={`translate(${NODE_W / 2}, ${NODE_H / 2})`}>
          <circle r={14} fill="#EEF2FF" />
          <UserPlus x={-7} y={-7} width={14} height={14} color="#2447D8" />
        </g>
        <text x={NODE_W / 2} y={NODE_H - 12} textAnchor="middle" fontSize={10} fill="#9CA3AF">
          Tap to refer
        </text>
      </g>
    )
  }

  const avatarColor = node.position === 'L' ? '#2447D8' : '#7C3AED'
  const avatarBg = node.position === 'L' ? '#EEF2FF' : '#F3EEFF'

  return (
    <g transform={`translate(${x}, ${y})`} onClick={() => onClick(node.memberCode)} className="cursor-pointer">
      <rect
        width={NODE_W} height={NODE_H} rx={8} ry={8}
        fill="white"
        stroke={node.isActive ? (node.position === 'L' ? '#2447D8' : '#7C3AED') : '#E5E7EB'}
        strokeWidth={node.isActive ? 1.5 : 1}
        filter="url(#nodeShadow)"
      />
      {/* Avatar */}
      <rect x={8} y={12} width={40} height={40} rx={8} fill={avatarBg} />
      <text x={28} y={37} textAnchor="middle" fontSize={12} fontWeight="600" fill={avatarColor}>
        {initials(node.name)}
      </text>
      {/* Active dot */}
      {node.isActive && (
        <circle cx={44} cy={14} r={5} fill="#16A34A" stroke="white" strokeWidth={1.5} />
      )}
      {/* Qualified ring */}
      {node.isQualified && (
        <circle cx={8 + 40 / 2} cy={12 + 40 / 2} r={22} fill="none" stroke="#F59E0B" strokeWidth={1.5} strokeDasharray="3 2" />
      )}
      {/* Name */}
      <text x={55} y={28} fontSize={11} fontWeight="600" fill="#111827" className="font-sans">
        {node.name.length > 12 ? node.name.slice(0, 12) + '…' : node.name}
      </text>
      <text x={55} y={43} fontSize={9} fill="#6B7280">
        {node.memberCode}
      </text>
      {/* Position badge */}
      {node.position && (
        <rect x={NODE_W - 26} y={6} width={20} height={14} rx={4} fill={node.position === 'L' ? '#EEF2FF' : '#F3EEFF'} />
      )}
      {node.position && (
        <text x={NODE_W - 16} y={17} textAnchor="middle" fontSize={9} fontWeight="700" fill={node.position === 'L' ? '#2447D8' : '#7C3AED'}>
          {node.position}
        </text>
      )}
    </g>
  )
}

interface Props {
  root: TreeNode
  depth?: number
  onNodeClick?: (code: string) => void
  compact?: boolean
}

const ZOOM_LEVELS = [0.6, 0.8, 1.0]

export function BinaryTree({ root, depth = 2, onNodeClick, compact = false }: Props) {
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 640
  const [zoom, setZoom] = useState(compact ? (isMobile ? 0.6 : 0.8) : 1.0)
  const [rootCode, setRootCode] = useState(root.memberCode)
  const [breadcrumb, setBreadcrumb] = useState<string[]>([])

  const findNode = (node: TreeNode | null, code: string): TreeNode | null => {
    if (!node) return null
    if (node.memberCode === code) return node
    return findNode(node.left, code) || findNode(node.right, code)
  }

  const currentRoot = findNode(root, rootCode) || root

  const handleNodeClick = (code: string) => {
    if (code === currentRoot.memberCode || code.startsWith('vacant-')) return
    setBreadcrumb((b) => [...b, currentRoot.memberCode])
    setRootCode(code)
    onNodeClick?.(code)
  }

  const handleBack = () => {
    const prev = breadcrumb[breadcrumb.length - 1]
    setBreadcrumb((b) => b.slice(0, -1))
    setRootCode(prev || root.memberCode)
  }

  const handleBackToMe = () => {
    setBreadcrumb([])
    setRootCode(root.memberCode)
  }

  const layout = computeLayout(currentRoot, depth)
  const svgW = layout.totalWidth
  const svgH = layout.totalHeight

  const zoomIdx = ZOOM_LEVELS.indexOf(zoom)

  return (
    <div className="relative w-full min-w-0">
      {/* Controls */}
      <div className="flex items-center gap-2 mb-3">
        {breadcrumb.length > 0 && (
          <button onClick={handleBack} className="flex items-center gap-1 text-xs text-primary font-medium hover:underline cursor-pointer">
            <ChevronLeft size={12} /> Back
          </button>
        )}
        {breadcrumb.length > 0 && (
          <button onClick={handleBackToMe} className="text-xs text-ink-muted hover:underline cursor-pointer">
            Back to Me
          </button>
        )}
        <div className="flex-1" />
        <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-0.5">
          <button
            onClick={() => setZoom(ZOOM_LEVELS[Math.max(0, zoomIdx - 1)])}
            disabled={zoomIdx === 0}
            className="p-1.5 rounded-md hover:bg-white disabled:opacity-40 transition-colors cursor-pointer"
            aria-label="Zoom out"
          >
            <ZoomOut size={13} />
          </button>
          <span className="text-xs font-medium text-ink-muted px-1">{(zoom * 100).toFixed(0)}%</span>
          <button
            onClick={() => setZoom(ZOOM_LEVELS[Math.min(ZOOM_LEVELS.length - 1, zoomIdx + 1)])}
            disabled={zoomIdx === ZOOM_LEVELS.length - 1}
            className="p-1.5 rounded-md hover:bg-white disabled:opacity-40 transition-colors cursor-pointer"
            aria-label="Zoom in"
          >
            <ZoomIn size={13} />
          </button>
          <button
            onClick={() => setZoom(1.0)}
            className="p-1.5 rounded-md hover:bg-white transition-colors cursor-pointer"
            aria-label="Reset zoom"
          >
            <Maximize2 size={13} />
          </button>
        </div>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 mb-3 text-[10px] text-ink-muted">
        <div className="flex items-center gap-1"><div className="w-2 h-2 rounded-full bg-success" /> Active</div>
        <div className="flex items-center gap-1"><div className="w-3 h-3 rounded-full border border-warning border-dashed" /> Qualified</div>
        <div className="flex items-center gap-1 cursor-pointer"><Copy size={10} className="text-primary" /> Vacant = copy referral</div>
      </div>

      {/* Tree */}
      <div className="overflow-x-auto rounded-xl bg-surface-page p-4 max-w-full">
        <div
          style={{
            width: svgW * zoom,
            height: svgH * zoom,
            transition: 'all 0.2s ease',
            margin: '0 auto',
          }}
        >
          <svg
            width={svgW}
            height={svgH}
            style={{ transform: `scale(${zoom})`, transformOrigin: 'top center' }}
            viewBox={`${-svgW / 2} 0 ${svgW} ${svgH}`}
          >
            <defs>
              <filter id="nodeShadow" x="-20%" y="-20%" width="140%" height="140%">
                <feDropShadow dx="0" dy="1" stdDeviation="2" floodOpacity="0.08" />
              </filter>
            </defs>

            {/* Connectors */}
            {layout.connectors.map((c, i) => {
              const my = (c.y1 + c.y2) / 2
              return (
                <path
                  key={i}
                  d={`M${c.x1},${c.y1} C${c.x1},${my} ${c.x2},${my} ${c.x2},${c.y2}`}
                  className="tree-svg-connector"
                />
              )
            })}

            {/* Nodes */}
            {layout.nodes.map((ln) => (
              <NodeCard
                key={ln.node.memberCode}
                ln={ln}
                onClick={handleNodeClick}
              />
            ))}
          </svg>
        </div>
      </div>
    </div>
  )
}
