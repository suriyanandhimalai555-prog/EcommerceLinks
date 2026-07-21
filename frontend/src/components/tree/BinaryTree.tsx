import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { TransformWrapper, TransformComponent, type ReactZoomPanPinchRef } from 'react-zoom-pan-pinch'
import { ZoomIn, ZoomOut, Maximize2, Expand, Minimize2, ChevronLeft, UserPlus, Loader2, Link2, Check, Crown } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TreeNode } from '../../types/api'
import { computeLayout, type LayoutNode } from './useTreeLayout'

const NODE_W = 150
const NODE_H = 64
// Extra space above y=0 so the crown badge on the root node isn't clipped by the SVG viewBox.
const SVG_TOP_PAD = 16

function initials(name: string) {
  return name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2)
}

function referralUrl(memberCode: string) {
  return `${window.location.origin}/register?sponsor=${memberCode}`
}

interface NodeCardProps {
  ln: LayoutNode
  onClick: (code: string) => void
  /** True when the pointer travelled far enough that this "click" was a pan/pinch. */
  wasDragged: () => boolean
}

function NodeCard({ ln, onClick, wasDragged }: NodeCardProps) {
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
      if (wasDragged() || !parentCode) return
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
          fill="#10141F"
          stroke={copied ? '#34D399' : '#3D56B2'}
          strokeWidth={1.5}
          strokeDasharray="6 3"
        />
        <g transform={`translate(${NODE_W / 2}, ${NODE_H / 2})`}>
          <circle r={14} fill={copied ? '#0E3532' : '#19224A'} />
          {copied
            ? <Check x={-7} y={-7} width={14} height={14} color="#34D399" />
            : <UserPlus x={-7} y={-7} width={14} height={14} color="#4169E1" />}
        </g>
        <text x={NODE_W / 2} y={NODE_H - 12} textAnchor="middle" fontSize={10} fill={copied ? '#34D399' : '#77809A'}>
          {copied ? t('tree.copied') : t('tree.tapToRefer')}
        </text>
      </g>
    )
  }

  const avatarColor = node.position === 'L' ? '#4169E1' : '#38BDF8'
  const avatarBg = node.position === 'L' ? '#19224A' : '#0C2C42'
  // Traffic-light state: active = green, inactive (not yet purchased) = orange.
  const stateColor = node.isActive ? '#34D399' : '#F97316'
  const isQualified = node.isQualified

  return (
    <g transform={`translate(${x}, ${y})`} onClick={() => { if (!wasDragged()) onClick(node.memberCode) }} className="cursor-pointer">
      {/* Outer gold glow — rendered as a slightly larger blurred rect behind the card */}
      {isQualified && (
        <rect
          x={-4} y={-4} width={NODE_W + 8} height={NODE_H + 8}
          rx={11} ry={11}
          fill="none"
          stroke="#F5C542"
          strokeWidth={6}
          opacity={0.22}
          filter="url(#goldGlow)"
        />
      )}
      {/* Card background */}
      <rect
        width={NODE_W} height={NODE_H} rx={8} ry={8}
        fill={node.isActive ? '#122620' : '#1C1208'}
        stroke={isQualified ? 'url(#goldGradient)' : stateColor}
        strokeWidth={isQualified ? 2.25 : 1.5}
        filter={isQualified ? undefined : 'url(#nodeShadow)'}
      />
      {/* Avatar */}
      <rect x={8} y={12} width={40} height={40} rx={8} fill={avatarBg} />
      <text x={28} y={37} textAnchor="middle" fontSize={12} fontWeight="600" fill={avatarColor}>
        {initials(node.name)}
      </text>
      {/* Status dot — green when active (purchased), orange when inactive */}
      <circle cx={44} cy={14} r={5} fill={stateColor} stroke="#141927" strokeWidth={1.5} />
      {/* Crown badge for qualified members — top-left corner */}
      {isQualified && (
        <g transform="translate(-7, -7)">
          <circle r={9} fill="#F5C542" stroke="#141927" strokeWidth={1.5} />
          <Crown x={-5.5} y={-5.5} width={11} height={11} color="#5C3200" strokeWidth={2} />
        </g>
      )}
      {/* Name */}
      <text x={55} y={28} fontSize={11} fontWeight="600" fill="#F2F4FA" className="font-sans">
        {node.name.length > 12 ? node.name.slice(0, 12) + '…' : node.name}
      </text>
      <text x={55} y={43} fontSize={9} fill="#98A2B8">
        {node.memberCode}
      </text>
      {/* Position badge */}
      {node.position && (
        <rect x={NODE_W - 26} y={6} width={20} height={14} rx={4} fill={node.position === 'L' ? '#19224A' : '#0C2C42'} />
      )}
      {node.position && (
        <text x={NODE_W - 16} y={17} textAnchor="middle" fontSize={9} fontWeight="700" fill={node.position === 'L' ? '#4169E1' : '#38BDF8'}>
          {node.position}
        </text>
      )}
      {/* Copy referral link for this member */}
      <g
        transform={`translate(${NODE_W - 24}, ${NODE_H - 24})`}
        onClick={(e) => { e.stopPropagation(); if (!wasDragged()) copyReferral(node.memberCode) }}
        className="cursor-pointer"
      >
        <title>{copied ? t('tree.copied') : t('tree.copyLink')}</title>
        <rect width={18} height={18} rx={5} fill={copied ? '#0E3532' : '#232A40'} stroke={copied ? '#34D399' : '#272E44'} strokeWidth={1} />
        {copied
          ? <Check x={4} y={4} width={10} height={10} color="#34D399" />
          : <Link2 x={4} y={4} width={10} height={10} color="#98A2B8" />}
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
  /** When provided, zooming out past the fit scale loads one more level.
   *  Omitted by the compact Dashboard tree, which stays at a fixed depth. */
  requestDeeper?: () => void
}

export function BinaryTree({
  root,
  depth = 2,
  compact = false,
  onNodeClick,
  onBack,
  onBackToMe,
  canGoBack = false,
  isFetching = false,
  requestDeeper,
}: Props) {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const transformRef = useRef<ReactZoomPanPinchRef>(null)
  const [containerSize, setContainerSize] = useState<{ w: number; h: number } | null>(null)
  const [scalePct, setScalePct] = useState(100)
  const [isFullscreen, setIsFullscreen] = useState(false)

  // Distinguish pan/pinch from tap: any pointer that travels > 8px between
  // down and up marks the gesture as a drag, and NodeCard click handlers bail.
  const dragRef = useRef({ x: 0, y: 0, moved: false })

  // Progressive auto-depth: when the user zooms out past ~fit, load one more
  // level. requestedDepthRef ensures each level is requested only once (never
  // re-fired before the deeper data lands); the settle timer debounces the
  // continuous onTransform stream to fire once the gesture stops.
  const requestedDepthRef = useRef(depth)
  const settleTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => { requestedDepthRef.current = depth }, [depth, root.memberCode])
  useEffect(() => () => clearTimeout(settleTimer.current), [])

  // Delegate node clicks to the parent — no local re-rooting.
  // Vacant nodes are handled by NodeCard's own copy-referral handler.
  const handleNodeClick = (code: string) => {
    if (code === root.memberCode || code.startsWith('vacant-')) return
    onNodeClick?.(code)
  }

  const layout = computeLayout(root, depth)
  const svgW = layout.totalWidth
  const svgH = layout.totalHeight

  // Measure the canvas container (re-runs whenever fullscreen is toggled because
  // the container DOM element moves into/out of the portal, changing its size).
  useLayoutEffect(() => {
    const measure = () => {
      const el = containerRef.current
      if (el) setContainerSize({ w: el.clientWidth, h: el.clientHeight })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [isFullscreen])

  // Re-measure once the DOM settles after fullscreen toggle (rAF so the portal
  // or class change has been painted before we read clientWidth/clientHeight).
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const el = containerRef.current
      if (el) setContainerSize({ w: el.clientWidth, h: el.clientHeight })
    })
    return () => cancelAnimationFrame(raf)
  }, [isFullscreen])

  // Close fullscreen on Escape.
  useEffect(() => {
    if (!isFullscreen) return
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') setIsFullscreen(false) }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [isFullscreen])

  // Wheel-to-pan handler: plain scroll pans, Ctrl/Cmd+scroll zooms (handled by
  // TransformWrapper via activationKeys). Must be a non-passive listener so
  // preventDefault() can suppress native page-scroll.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) return  // TransformWrapper handles zoom
      e.preventDefault()
      const ts = transformRef.current?.state
      if (!ts) return
      transformRef.current?.setTransform(
        ts.positionX - e.deltaX,
        ts.positionY - e.deltaY,
        ts.scale,
        0,  // instant, no animation — pan should feel direct
      )
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [isFullscreen, containerSize])

  // Scale at which the whole tree fits the canvas — the reset target. Depth 6
  // on a phone needs ~0.03, so it is dynamic.
  const fitScale = containerSize
    ? Math.max(0.03, Math.min(containerSize.w / svgW, containerSize.h / (svgH + SVG_TOP_PAD), 1))
    : 1
  // Floor sits 30% below fit so the auto-depth trigger (fit * MARGIN) is always
  // physically reachable at every depth < 6.
  const minScale = Math.max(0.02, fitScale * 0.7)
  const MARGIN = 0.92

  // Canvas height: flex-1 in fullscreen (fills the overlay), fixed otherwise.
  const canvasHeight = isFullscreen
    ? undefined
    : compact ? 300 : 'min(60vh, 560px)'
  const canvasClass = isFullscreen
    ? 'relative overflow-hidden rounded-xl bg-surface-page flex-1 min-h-0'
    : 'relative overflow-hidden rounded-xl bg-surface-page'

  const treeContent = (
    <TransformWrapper
      // Remount (and re-center) only on a real root change or once the container
      // is first measured (initialScale is read only at mount). svgW/depth is NOT
      // in the key so loading a deeper level adds nodes inside the SAME transform.
      key={`${root.memberCode}:${containerSize?.w ?? 0}`}
      ref={transformRef}
      minScale={minScale}
      maxScale={1.5}
      initialScale={fitScale}
      centerOnInit
      limitToBounds={false}
      doubleClick={{ disabled: true }}
      smooth
      // Plain scroll pans (handled by our wheel listener below).
      // Ctrl/Cmd+scroll zooms via activationKeys; pinch also zooms.
      wheel={{ step: 0.08, activationKeys: ['Control', 'Meta'] }}
      pinch={{ step: 1.5 }}
      zoomAnimation={{ animationTime: 250 }}
      onTransform={(_, state) => {
        setScalePct(Math.round(state.scale * 100))
        // Progressive auto-depth: debounce to the end of the gesture, then
        // load one more level if the user zoomed out past ~fit.
        if (!requestDeeper) return
        clearTimeout(settleTimer.current)
        const scale = state.scale
        settleTimer.current = setTimeout(() => {
          if (isFetching || depth >= 6) return
          if (requestedDepthRef.current !== depth) return // a bump already in flight
          if (scale < fitScale * MARGIN) {
            requestedDepthRef.current = depth + 1
            requestDeeper()
          }
        }, 160)
      }}
    >
      {({ zoomIn, zoomOut, centerView }) => (
        <>
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
            <div className="flex items-center gap-1 bg-white/5 rounded-lg p-0.5">
              <button
                onClick={() => zoomOut(0.12, 250)}
                className="p-1.5 rounded-md hover:bg-white/10 transition-colors cursor-pointer"
                aria-label="Zoom out"
              >
                <ZoomOut size={13} />
              </button>
              <span className="text-xs font-medium text-ink-muted px-1">{scalePct}%</span>
              <button
                onClick={() => zoomIn(0.12, 250)}
                className="p-1.5 rounded-md hover:bg-white/10 transition-colors cursor-pointer"
                aria-label="Zoom in"
              >
                <ZoomIn size={13} />
              </button>
              <button
                onClick={() => centerView(fitScale, 200)}
                className="p-1.5 rounded-md hover:bg-white/10 transition-colors cursor-pointer"
                aria-label="Fit whole tree"
              >
                <Maximize2 size={13} />
              </button>
              {/* Expand / Close fullscreen — hidden on compact Dashboard tree */}
              {!compact && (
                <button
                  onClick={() => setIsFullscreen(f => !f)}
                  className="p-1.5 rounded-md hover:bg-white/10 transition-colors cursor-pointer"
                  aria-label={isFullscreen ? t('tree.exitFullscreen') : t('tree.expand')}
                  title={isFullscreen ? t('tree.exitFullscreen') : t('tree.expand')}
                >
                  {isFullscreen ? <Minimize2 size={13} /> : <Expand size={13} />}
                </button>
              )}
            </div>
          </div>

          {/* Legend */}
          <div className="flex items-center flex-wrap gap-x-4 gap-y-1 mb-3 text-[10px] text-ink-muted">
            <div className="flex items-center gap-1"><div className="w-2 h-2 rounded-full bg-success" /> Active</div>
            <div className="flex items-center gap-1"><div className="w-2 h-2 rounded-full" style={{ backgroundColor: '#F97316' }} /> Inactive</div>
            <div className="flex items-center gap-1"><div className="w-3 h-3 rounded-sm border border-dashed" style={{ borderColor: '#3D56B2' }} /> Empty</div>
            <div className="flex items-center gap-1">
              <div className="w-4 h-4 rounded-sm relative" style={{ border: '1.5px solid #E0A83E', boxShadow: '0 0 4px #F5C54266' }}>
                <Crown size={9} style={{ position: 'absolute', inset: 0, margin: 'auto', color: '#F5C542' }} />
              </div>
              Qualified
            </div>
          </div>

          {/* Tree canvas — scroll to pan, Ctrl/Cmd+scroll or pinch to zoom */}
          <div
            ref={containerRef}
            className={canvasClass}
            style={canvasHeight !== undefined ? { height: canvasHeight } : undefined}
          >
            {isFetching && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-surface-page/60 rounded-xl">
                <Loader2 size={22} className="animate-spin text-primary" />
              </div>
            )}
            {containerSize && (
              <TransformComponent
                wrapperStyle={{ width: '100%', height: '100%' }}
              >
                <div
                  onPointerDownCapture={(e) => {
                    dragRef.current = { x: e.clientX, y: e.clientY, moved: false }
                  }}
                  onPointerUpCapture={(e) => {
                    if (Math.hypot(e.clientX - dragRef.current.x, e.clientY - dragRef.current.y) > 8) {
                      dragRef.current.moved = true
                    }
                  }}
                >
                  <svg
                    width={svgW}
                    height={svgH + SVG_TOP_PAD}
                    viewBox={`${-svgW / 2} -${SVG_TOP_PAD} ${svgW} ${svgH + SVG_TOP_PAD}`}
                  >
                    <defs>
                      <filter id="nodeShadow" x="-20%" y="-20%" width="140%" height="140%">
                        <feDropShadow dx="0" dy="2" stdDeviation="3" floodOpacity="0.4" />
                      </filter>
                      {/* Gold gradient for qualified node border — left-to-right shimmer */}
                      <linearGradient id="goldGradient" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2={NODE_W} y2="0">
                        <stop offset="0%"   stopColor="#F7D774" />
                        <stop offset="45%"  stopColor="#E0A83E" />
                        <stop offset="100%" stopColor="#F7D774" />
                      </linearGradient>
                      {/* Gold outer-glow filter for qualified nodes */}
                      <filter id="goldGlow" x="-30%" y="-30%" width="160%" height="160%">
                        <feGaussianBlur in="SourceAlpha" stdDeviation="6" result="blur" />
                        <feFlood floodColor="#F5C542" floodOpacity="0.75" result="glowColor" />
                        <feComposite in="glowColor" in2="blur" operator="in" result="glow" />
                        <feMerge>
                          <feMergeNode in="glow" />
                          <feMergeNode in="SourceGraphic" />
                        </feMerge>
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
                        wasDragged={() => dragRef.current.moved}
                      />
                    ))}
                  </svg>
                </div>
              </TransformComponent>
            )}
          </div>
        </>
      )}
    </TransformWrapper>
  )

  // Fullscreen: render into a portal over the whole viewport (including sidebar).
  if (isFullscreen) {
    return createPortal(
      <div className="fixed inset-0 z-[70] bg-surface-page flex flex-col p-4">
        {/* Fullscreen title bar */}
        <div className="flex items-center justify-between mb-1">
          <span className="text-sm font-semibold text-ink">Binary Network Tree</span>
          <button
            onClick={() => setIsFullscreen(false)}
            className="flex items-center gap-1.5 text-xs text-ink-muted hover:text-ink transition-colors cursor-pointer"
            aria-label={t('tree.exitFullscreen')}
          >
            <Minimize2 size={14} />
            {t('tree.exitFullscreen')}
          </button>
        </div>
        {treeContent}
      </div>,
      document.body,
    )
  }

  return (
    <div className="relative w-full min-w-0">
      {treeContent}
    </div>
  )
}
