import { useRef, useState } from 'react'
import { ZoomIn, ZoomOut, Maximize2, ChevronLeft, UserPlus, Loader2, Link2, Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TreeNode } from '../../types/api'
import { computeLayout, type LayoutNode } from './useTreeLayout'

const NODE_W = 150
const NODE_H = 64

function initials(name: string) {
  return name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2)
}

function referralUrl(memberCode: string) {
  return `${window.location.origin}/register?sponsor=${memberCode}`
}

interface NodeCardProps {
  ln: LayoutNode
  onClick: (code: string) => void
}

function NodeCard({ ln, onClick }: NodeCardProps) {
  const { t } = useTranslation()
  const { node, x, y, parentCode } = ln
  const isVacant = node.name === 'Vacant'
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const copyReferral = (code: string) => {
    navigator.clipboard.writeText(referralUrl(code))
    setCopied(true)
    clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopied(false), 1500)
  }

  if (isVacant) {
    // Tapping a vacant slot copies the referral link of the member ABOVE it,
    // so the new recruit registers directly into this slot.
    const handleVacantClick = (e: React.MouseEvent) => {
      e.stopPropagation()
      if (!parentCode) return
      copyReferral(parentCode)
    }
    return (
      <g
        transform={`translate(${x}, ${y})`}
        onClick={handleVacantClick}
        className="cursor-pointer"
      >
        <rect
          width={NODE_W} height={NODE_H}
          rx={8} ry={8}
          fill="white"
          stroke={copied ? '#16A34A' : '#E5E7EB'}
          strokeWidth={1.5}
          strokeDasharray="6 3"
        />
        <g transform={`translate(${NODE_W / 2}, ${NODE_H / 2})`}>
          <circle r={14} fill={copied ? '#F0FDF4' : '#EEF2FF'} />
          {copied
            ? <Check x={-7} y={-7} width={14} height={14} color="#16A34A" />
            : <UserPlus x={-7} y={-7} width={14} height={14} color="#2447D8" />}
        </g>
        <text x={NODE_W / 2} y={NODE_H - 12} textAnchor="middle" fontSize={10} fill={copied ? '#16A34A' : '#9CA3AF'}>
          {copied ? t('tree.copied') : t('tree.tapToRefer')}
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
      {/* Copy referral link for this member */}
      <g
        transform={`translate(${NODE_W - 24}, ${NODE_H - 24})`}
        onClick={(e) => { e.stopPropagation(); copyReferral(node.memberCode) }}
        className="cursor-pointer"
      >
        <title>{copied ? t('tree.copied') : t('tree.copyLink')}</title>
        <rect width={18} height={18} rx={5} fill={copied ? '#F0FDF4' : '#F9FAFB'} stroke={copied ? '#16A34A' : '#E5E7EB'} strokeWidth={1} />
        {copied
          ? <Check x={4} y={4} width={10} height={10} color="#16A34A" />
          : <Link2 x={4} y={4} width={10} height={10} color="#6B7280" />}
      </g>
    </g>
  )
}

interface Props {
  root: TreeNode
  depth?: number
  compact?: boolean
  /** Called when a real (non-vacant) node is clicked — triggers a server drill-down. */
  onNodeClick?: (code: string) => void
  onBack?: () => void
  onBackToMe?: () => void
  canGoBack?: boolean
  /** True while a drill-down refetch is in flight — shows a dimmed overlay. */
  isFetching?: boolean
}

const ZOOM_LEVELS = [0.6, 0.8, 1.0]

export function BinaryTree({
  root,
  depth = 2,
  compact = false,
  onNodeClick,
  onBack,
  onBackToMe,
  canGoBack = false,
  isFetching = false,
}: Props) {
  const { t } = useTranslation()
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 640
  const [zoom, setZoom] = useState(compact ? (isMobile ? 0.6 : 0.8) : 1.0)

  // Delegate node clicks to the parent — no local re-rooting.
  // Vacant nodes are handled by NodeCard's own copy-referral handler.
  const handleNodeClick = (code: string) => {
    if (code === root.memberCode || code.startsWith('vacant-')) return
    onNodeClick?.(code)
  }

  const layout = computeLayout(root, depth)
  const svgW = layout.totalWidth
  const svgH = layout.totalHeight

  const zoomIdx = ZOOM_LEVELS.indexOf(zoom)

  return (
    <div className="relative w-full min-w-0">
      {/* Controls */}
      <div className="flex items-center gap-2 mb-3">
        {canGoBack && (
          <button
            onClick={onBack}
            className="flex items-center gap-1 text-xs text-primary font-medium hover:underline cursor-pointer"
          >
            <ChevronLeft size={12} /> {t('tree.back')}
          </button>
        )}
        {canGoBack && (
          <button
            onClick={onBackToMe}
            className="text-xs text-ink-muted hover:underline cursor-pointer"
          >
            {t('tree.backToMe')}
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
      </div>

      {/* Tree (with fetching overlay) */}
      <div className="relative overflow-x-auto rounded-xl bg-surface-page p-4 max-w-full">
        {isFetching && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/60 rounded-xl">
            <Loader2 size={22} className="animate-spin text-primary" />
          </div>
        )}
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
