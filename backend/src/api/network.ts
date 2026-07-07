import type { FastifyInstance } from 'fastify'
import { pool } from '../lib/db.js'
import { redis } from '../lib/redis.js'

interface TreeRow {
  id: string; member_code: string; name: string; position: string | null
  is_active: boolean; is_qualified: boolean; parent_id: string | null
}

function buildTree(
  rows: TreeRow[],
  rootId: string,
  depthLeft: number
): Record<string, unknown> | null {
  const node = rows.find((r) => r.id === rootId)
  if (!node) return null
  const result: Record<string, unknown> = {
    memberCode:  node.member_code,
    name:        node.name,
    position:    node.position,
    isActive:    node.is_active,
    isQualified: node.is_qualified,
    left:        null,
    right:       null,
  }
  if (depthLeft > 0) {
    const children = rows.filter((r) => r.parent_id === rootId)
    for (const child of children) {
      if (child.position === 'L') result.left  = buildTree(rows, child.id, depthLeft - 1)
      if (child.position === 'R') result.right = buildTree(rows, child.id, depthLeft - 1)
    }
  }
  return result
}

export async function networkRoutes(app: FastifyInstance) {
  app.get('/network/tree', {
    preHandler: [app.authenticate],
  }, async (req, reply) => {
    const user = req.user as { sub: string }
    const query = req.query as { depth?: string; root?: string }
    const depth = Math.min(4, parseInt(query.depth ?? '3', 10) || 3)
    const rootParam = query.root === 'me' || !query.root ? user.sub : query.root

    // Resolve rootParam: if it's a member_code, look up id
    let rootId = rootParam
    if (!rootParam.match(/^\d+$/)) {
      const { rows } = await pool().query<{ id: string }>(
        'SELECT id FROM members WHERE member_code = $1',
        [rootParam]
      )
      if (!rows[0]) return reply.status(404).send({ error: 'Root not found' })
      rootId = rows[0].id
    }

    const cacheKey = `tree:${rootId}:${depth}`
    const cached = await redis().get(cacheKey).catch(() => null)
    if (cached) return JSON.parse(cached)

    // BFS: fetch up to `depth` levels with batched parent_id IN queries
    let currentIds = [rootId]
    const allRows: TreeRow[] = []

    for (let d = 0; d <= depth && currentIds.length > 0; d++) {
      const { rows } = await pool().query<TreeRow>(
        `SELECT id, member_code, name, position, is_active, is_qualified, parent_id
         FROM members WHERE id = ANY($1::bigint[])`,
        [currentIds]
      )
      allRows.push(...rows)
      if (d < depth) {
        const { rows: children } = await pool().query<{ id: string }>(
          `SELECT id FROM members WHERE parent_id = ANY($1::bigint[])`,
          [currentIds]
        )
        currentIds = children.map((r) => r.id)
      } else {
        currentIds = []
      }
    }

    const tree = buildTree(allRows, rootId, depth)
    if (!tree) return reply.status(404).send({ error: 'Root not found' })

    await redis().setex(cacheKey, 60, JSON.stringify(tree)).catch(() => null)
    return tree
  })

  app.get('/network/summary', {
    preHandler: [app.authenticate],
  }, async (req) => {
    const user = req.user as { sub: string }
    const { rows } = await pool().query<{
      left_active: string; right_active: string; pairs_matched: string
      left_qualified: string; right_qualified: string
    }>(
      'SELECT left_active, right_active, pairs_matched, left_qualified, right_qualified FROM member_counters WHERE member_id = $1',
      [user.sub]
    )
    if (!rows[0]) return { leftActive: 0, rightActive: 0, pairsMatched: 0, leftQualified: 0, rightQualified: 0 }
    const c = rows[0]
    return {
      leftActive:    Number(c.left_active),
      rightActive:   Number(c.right_active),
      pairsMatched:  Number(c.pairs_matched),
      leftQualified: Number(c.left_qualified),
      rightQualified: Number(c.right_qualified),
    }
  })
}
