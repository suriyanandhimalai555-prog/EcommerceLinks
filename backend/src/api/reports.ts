import type { FastifyInstance } from 'fastify'
import { pool } from '../lib/db.js'
import { toPaise } from '../lib/money.js'
import { RANKS, QUALIFIED_THRESHOLDS } from '../domain/ranks.js'

export async function reportRoutes(app: FastifyInstance) {
  app.get('/dashboard', {
    preHandler: [app.authenticate],
  }, async (req) => {
    const user = req.user as { sub: string }
    const memberId = user.sub

    const [counterRes, walletRes, deferredRes, pairsRes, rankRes] = await Promise.all([
      pool().query<{
        left_active: string; right_active: string; pairs_matched: string
        left_qualified: string; right_qualified: string
      }>(
        'SELECT left_active, right_active, pairs_matched, left_qualified, right_qualified FROM member_counters WHERE member_id = $1',
        [memberId]
      ),
      pool().query<{ balance: string }>(
        `SELECT wb.balance FROM wallet_balances wb JOIN accounts a ON a.id = wb.account_id
         WHERE a.owner_id = $1 AND a.kind = 'wallet'`,
        [memberId]
      ),
      pool().query<{ balance: string }>(
        `SELECT wb.balance FROM wallet_balances wb JOIN accounts a ON a.id = wb.account_id
         WHERE a.owner_id = $1 AND a.kind = 'deferred_bonus'`,
        [memberId]
      ),
      pool().query<{ total_bonus: string }>(
        `SELECT COALESCE(SUM(bonus_amount),0) AS total_bonus FROM pairs WHERE member_id = $1`,
        [memberId]
      ),
      pool().query<{ rank_level: string }>(
        'SELECT rank_level FROM rank_achievements WHERE member_id = $1 ORDER BY rank_level DESC LIMIT 1',
        [memberId]
      ),
    ])

    const counters = counterRes.rows[0] ?? { left_active: '0', right_active: '0', pairs_matched: '0', left_qualified: '0', right_qualified: '0' }
    const walletPaise   = toPaise(walletRes.rows[0]?.balance ?? '0')
    const deferredPaise = toPaise(deferredRes.rows[0]?.balance ?? '0')
    const totalIncomePaise = toPaise(pairsRes.rows[0]?.total_bonus ?? '0')
    const currentRank  = rankRes.rows[0] ? parseInt(rankRes.rows[0].rank_level) : 0
    const nextLevel    = currentRank < 12 ? currentRank + 1 : null

    const leftQ  = parseInt(counters.left_qualified)
    const rightQ = parseInt(counters.right_qualified)

    let rankProgress: Record<string, unknown> | null = null
    if (nextLevel && nextLevel <= 4) {
      const threshold = QUALIFIED_THRESHOLDS[nextLevel]
      rankProgress = { leftQualified: leftQ, rightQualified: rightQ, requiredEachSide: threshold }
    }

    const carryForward = (() => {
      const leftA  = parseInt(counters.left_active)
      const rightA = parseInt(counters.right_active)
      const matched = parseInt(counters.pairs_matched)
      const excess  = Math.max(leftA, rightA) - matched
      const side    = leftA > rightA ? 'L' : 'R'
      return { side, excess }
    })()

    return {
      totalIncomePaise:     Number(totalIncomePaise),
      pairMatchIncomePaise: Number(totalIncomePaise),
      walletBalancePaise:   Number(walletPaise),
      deferredBalancePaise: Number(deferredPaise),
      counters: {
        leftActive:    parseInt(counters.left_active),
        rightActive:   parseInt(counters.right_active),
        pairsMatched:  parseInt(counters.pairs_matched),
        leftQualified: leftQ,
        rightQualified: rightQ,
      },
      carryForward,
      rank: {
        currentLevel:    currentRank,
        currentName:     currentRank > 0 ? RANKS[currentRank - 1].name : null,
        next:            nextLevel,
        progress:        rankProgress,
      },
    }
  })

  app.get('/pairs', {
    preHandler: [app.authenticate],
  }, async (req) => {
    const user = req.user as { sub: string }
    const query = req.query as { cursor?: string; limit?: string }
    const limit = Math.min(100, parseInt(query.limit ?? '20', 10))
    const params: (string | number)[] = [user.sub, limit]
    const cursorClause = query.cursor ? 'AND p.id < $3' : ''
    if (query.cursor) params.push(parseInt(query.cursor))

    const { rows } = await pool().query(
      `SELECT p.id, p.sequence_no, p.bonus_amount, p.created_at,
              ml.member_code AS left_code, ml.name AS left_name,
              mr.member_code AS right_code, mr.name AS right_name
       FROM pairs p
       JOIN members ml ON ml.id = p.left_member_id
       JOIN members mr ON mr.id = p.right_member_id
       WHERE p.member_id = $1 ${cursorClause}
       ORDER BY p.id DESC LIMIT $2`,
      params
    )
    return {
      pairs: rows.map((r) => ({
        id:          r.id,
        sequenceNo:  r.sequence_no,
        bonusPaise:  Number(toPaise(r.bonus_amount)),
        leftMember:  { code: r.left_code,  name: r.left_name  },
        rightMember: { code: r.right_code, name: r.right_name },
        at:          r.created_at,
      })),
      nextCursor: rows.length === limit ? String(rows[rows.length - 1].id) : null,
    }
  })

  app.get('/ranks/progress', {
    preHandler: [app.authenticate],
  }, async (req) => {
    const user = req.user as { sub: string }
    const [counterRes, rankRes, legRes] = await Promise.all([
      pool().query<{ left_qualified: string; right_qualified: string }>(
        'SELECT left_qualified, right_qualified FROM member_counters WHERE member_id = $1',
        [user.sub]
      ),
      pool().query<{ rank_level: string }>(
        'SELECT rank_level FROM rank_achievements WHERE member_id = $1',
        [user.sub]
      ),
      pool().query<{ rank_level: string; left_count: string; right_count: string }>(
        'SELECT rank_level, left_count, right_count FROM leg_rank_counters WHERE member_id = $1',
        [user.sub]
      ),
    ])

    const achieved = new Set(rankRes.rows.map((r) => parseInt(r.rank_level)))
    const leftQ  = parseInt(counterRes.rows[0]?.left_qualified ?? '0')
    const rightQ = parseInt(counterRes.rows[0]?.right_qualified ?? '0')
    const legMap: Record<number, { left: number; right: number }> = {}
    for (const r of legRes.rows) {
      legMap[parseInt(r.rank_level)] = { left: parseInt(r.left_count), right: parseInt(r.right_count) }
    }

    return RANKS.map((rank) => {
      let met = false
      if (rank.level <= 4) {
        const threshold = QUALIFIED_THRESHOLDS[rank.level]
        met = leftQ >= threshold && rightQ >= threshold
      } else {
        const leg = legMap[rank.level - 1] ?? { left: 0, right: 0 }
        met = leg.left >= 1 && leg.right >= 1
      }
      return {
        level:    rank.level,
        name:     rank.name,
        reward:   rank.reward,
        achieved: achieved.has(rank.level),
        met,
        progress: rank.level <= 4
          ? { leftQualified: leftQ, rightQualified: rightQ, required: QUALIFIED_THRESHOLDS[rank.level] }
          : { leftAchievers: legMap[rank.level - 1]?.left ?? 0, rightAchievers: legMap[rank.level - 1]?.right ?? 0 },
      }
    })
  })
}
