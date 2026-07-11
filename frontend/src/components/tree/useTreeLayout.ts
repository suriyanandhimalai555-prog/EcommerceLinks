import type { TreeNode } from '../../types/api'

const NODE_W = 150
const NODE_H = 64
const H_GAP = 16   // gap between adjacent nodes = COL_W - NODE_W
const V_GAP = 56   // vertical gap between levels
const COL_W = NODE_W + H_GAP  // 166

export interface LayoutNode {
  node: TreeNode
  x: number
  y: number
  depth: number
  /** memberCode of the node's tree parent — set on vacant slots so the
   *  "tap to refer" action can build that parent's referral link. */
  parentCode?: string
}

export interface LayoutConnector {
  x1: number; y1: number; x2: number; y2: number
}

export interface TreeLayout {
  nodes: LayoutNode[]
  connectors: LayoutConnector[]
  totalWidth: number
  totalHeight: number
}

function columns(depth: number) { return Math.pow(2, depth) }

// Returns the SVG x-center for a node occupying [colStart, colStart+spanCols)
// in a tree that has totalCols columns total.
function colCenter(colStart: number, spanCols: number, totalCols: number): number {
  return (colStart + spanCols / 2) * COL_W - (totalCols * COL_W) / 2
}

function layoutNode(
  node: TreeNode | null,
  depth: number,
  maxDepth: number,
  colStart: number,
  nodes: LayoutNode[],
  connectors: LayoutConnector[],
  totalCols: number,
  parentCode?: string,
): void {
  if (depth > maxDepth) return

  const spanCols = columns(maxDepth - depth)
  const cx = colCenter(colStart, spanCols, totalCols)
  const x = cx - NODE_W / 2
  const y = depth * (NODE_H + V_GAP)

  if (node) {
    nodes.push({ node, x, y, depth, parentCode })

    if (depth < maxDepth) {
      const leftSpan = columns(maxDepth - depth - 1)
      const rightColStart = colStart + leftSpan
      const childY = y + NODE_H + V_GAP

      const leftCx = colCenter(colStart, leftSpan, totalCols)
      const rightCx = colCenter(rightColStart, leftSpan, totalCols)

      connectors.push({ x1: cx, y1: y + NODE_H, x2: leftCx, y2: childY })
      connectors.push({ x1: cx, y1: y + NODE_H, x2: rightCx, y2: childY })

      layoutNode(node.left, depth + 1, maxDepth, colStart, nodes, connectors, totalCols, node.memberCode)
      layoutNode(node.right, depth + 1, maxDepth, rightColStart, nodes, connectors, totalCols, node.memberCode)
    }
  } else {
    nodes.push({
      node: {
        memberCode: `vacant-${depth}-${colStart}`,
        name: 'Vacant',
        position: null,
        isActive: false,
        isQualified: false,
        left: null,
        right: null,
      },
      x, y, depth, parentCode,
    })
  }
}

export function computeLayout(root: TreeNode, maxDepth: number): TreeLayout {
  const totalCols = columns(maxDepth)
  const nodes: LayoutNode[] = []
  const connectors: LayoutConnector[] = []

  layoutNode(root, 0, maxDepth, 0, nodes, connectors, totalCols)

  const totalWidth = totalCols * COL_W
  const totalHeight = (maxDepth + 1) * (NODE_H + V_GAP) - V_GAP

  return { nodes, connectors, totalWidth, totalHeight }
}
