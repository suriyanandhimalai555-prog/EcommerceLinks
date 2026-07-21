import type { TreeNode } from '../../types/api'

const NODE_W = 150
const NODE_H = 64
const H_GAP = 24   // horizontal gap between adjacent leaf nodes
const V_GAP = 44   // vertical gap between levels
const COL_W = NODE_W + H_GAP  // 174

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

/**
 * Tidy (Reingold-Tilford-style) compact layout.
 *
 * Unlike the previous full-grid approach (which reserved 2^depth column slots,
 * spreading upper nodes very far apart), this algorithm:
 *   • allocates one column only per actual leaf (real or vacant placeholder)
 *   • centers each parent over its children
 *   • never recurses into vacant placeholder nodes (keeps the tree compact)
 *
 * Returns the horizontal center-x of the node placed (in raw cursor space,
 * before the centering shift is applied at the end of computeLayout).
 */
function layoutCompact(
  node: TreeNode | null,
  depth: number,
  maxDepth: number,
  parentCode: string | undefined,
  isRightSlot: boolean,
  nodes: LayoutNode[],
  connectors: LayoutConnector[],
  cursor: { val: number },
): number {
  const y = depth * (NODE_H + V_GAP)

  if (node === null) {
    // Vacant placeholder — single leaf, no recursion (keeps tree compact).
    const idx = cursor.val++
    const cx = idx * COL_W + COL_W / 2
    nodes.push({
      node: {
        memberCode: `vacant-${depth}-${idx}`,
        name: 'Vacant',
        position: isRightSlot ? 'R' : 'L',
        isActive: false,
        isQualified: false,
        left: null,
        right: null,
      },
      x: cx - NODE_W / 2,
      y,
      depth,
      parentCode,
    })
    return cx
  }

  // Real node at max depth — treat as a leaf.
  if (depth === maxDepth) {
    const idx = cursor.val++
    const cx = idx * COL_W + COL_W / 2
    nodes.push({ node, x: cx - NODE_W / 2, y, depth, parentCode })
    return cx
  }

  // Internal real node — lay out children first (post-order), then center parent.
  const childY = (depth + 1) * (NODE_H + V_GAP)
  const leftCx = layoutCompact(
    node.left, depth + 1, maxDepth, node.memberCode, false, nodes, connectors, cursor,
  )
  const rightCx = layoutCompact(
    node.right, depth + 1, maxDepth, node.memberCode, true, nodes, connectors, cursor,
  )

  const cx = (leftCx + rightCx) / 2
  nodes.push({ node, x: cx - NODE_W / 2, y, depth, parentCode })

  // Connectors: from bottom-center of this node to top-center of each child.
  connectors.push({ x1: cx, y1: y + NODE_H, x2: leftCx,  y2: childY })
  connectors.push({ x1: cx, y1: y + NODE_H, x2: rightCx, y2: childY })

  return cx
}

export function computeLayout(root: TreeNode, maxDepth: number): TreeLayout {
  const nodes: LayoutNode[] = []
  const connectors: LayoutConnector[] = []
  const cursor = { val: 0 }

  layoutCompact(root, 0, maxDepth, undefined, false, nodes, connectors, cursor)

  const leafCount = cursor.val
  const totalWidth = leafCount * COL_W
  const totalHeight = (maxDepth + 1) * (NODE_H + V_GAP) - V_GAP

  // Center the tree around x=0 so the SVG viewBox (which starts at -totalWidth/2)
  // shows the tree horizontally centered, matching what the existing BinaryTree
  // viewBox `${-svgW/2} 0 ${svgW} ${svgH}` expects.
  const shift = -totalWidth / 2
  for (const ln of nodes) ln.x += shift
  for (const c of connectors) { c.x1 += shift; c.x2 += shift }

  return { nodes, connectors, totalWidth, totalHeight }
}
