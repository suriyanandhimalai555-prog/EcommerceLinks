import { randomUUID } from 'crypto'
import { withTxn } from '../lib/db.js'
import { createConsumer } from '../lib/kafka.js'
import { writeOutbox } from '../events/outbox.js'
import { TOPICS } from '../events/topics.js'
import { QUALIFIED_THRESHOLDS } from '../domain/ranks.js'
import type { AvgEvent } from '../events/types.js'

const GROUP = 'avg-rank'

export async function evaluateRanks(memberId: bigint): Promise<number[]> {
  return withTxn(async (c) => {
    // Lock counters + rank state
    const { rows: cRows } = await c.query<{
      left_qualified: string; right_qualified: string
    }>(
      'SELECT left_qualified, right_qualified FROM member_counters WHERE member_id=$1 FOR UPDATE',
      [memberId]
    )
    if (!cRows[0]) return []

    const leftQ  = parseInt(cRows[0].left_qualified)
    const rightQ = parseInt(cRows[0].right_qualified)

    const { rows: achievedRows } = await c.query<{ rank_level: string }>(
      'SELECT rank_level FROM rank_achievements WHERE member_id=$1',
      [memberId]
    )
    const achieved = new Set(achievedRows.map((r) => parseInt(r.rank_level)))

    const { rows: legRows } = await c.query<{
      rank_level: string; left_count: string; right_count: string
    }>(
      'SELECT rank_level, left_count, right_count FROM leg_rank_counters WHERE member_id=$1',
      [memberId]
    )
    const legMap: Record<number, { left: number; right: number }> = {}
    for (const r of legRows) {
      legMap[parseInt(r.rank_level)] = { left: parseInt(r.left_count), right: parseInt(r.right_count) }
    }

    const newlyAchieved: number[] = []

    for (let level = 1; level <= 12; level++) {
      if (achieved.has(level)) continue

      let qualifies = false
      if (level <= 4) {
        const threshold = QUALIFIED_THRESHOLDS[level]
        qualifies = leftQ >= threshold && rightQ >= threshold
      } else {
        const leg = legMap[level - 1] ?? { left: 0, right: 0 }
        qualifies = leg.left >= 1 && leg.right >= 1
      }

      if (!qualifies) break // ranks are awarded in order; once one fails, higher ones can't pass

      const { rows: ins } = await c.query<{ id: string }>(
        `INSERT INTO rank_achievements (member_id, rank_level)
         VALUES ($1,$2)
         ON CONFLICT (member_id, rank_level) DO NOTHING
         RETURNING id`,
        [memberId, level]
      )
      if (ins[0]) {
        newlyAchieved.push(level)
        achieved.add(level)
        await writeOutbox(c, {
          event_id:       randomUUID(),
          event_type:     'RankAchieved',
          occurred_at:    new Date().toISOString(),
          schema_version: 1,
          member_id:      Number(memberId),
          rank_level:     level,
        })
      }
    }

    return newlyAchieved
  })
}

async function run() {
  const consumer = createConsumer(GROUP)
  await consumer.connect()
  await consumer.subscribe({ topic: TOPICS.ranks.name, fromBeginning: false })
  console.log('[rank] started')

  await consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return
      const e = JSON.parse(message.value.toString()) as AvgEvent
      if (e.event_type !== 'RankEvalRequested') return

      const already = await withTxn(async (c) => {
        const { rows } = await c.query(
          'SELECT 1 FROM processed_events WHERE consumer_group=$1 AND event_id=$2',
          [GROUP, e.event_id]
        )
        return rows.length > 0
      })
      if (already) return

      await evaluateRanks(BigInt(e.member_id))

      await withTxn(async (c) => {
        await c.query(
          'INSERT INTO processed_events (consumer_group, event_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [GROUP, e.event_id]
        )
      })
    },
  })
}

run().catch((err) => {
  console.error('[rank] fatal', err)
  process.exit(1)
})
