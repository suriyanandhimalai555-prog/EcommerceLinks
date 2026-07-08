import { randomUUID } from 'crypto'
import { v5 as uuidv5 } from 'uuid'
import { pool, withTxn } from '../lib/db.js'
import { startConsumer, publishToStream } from '../lib/streams.js'
import { TOPICS } from '../events/topics.js'
import type {
  AvgEvent, MemberActivated, MemberQualified, RankAchieved, CounterIncrement,
} from '../events/types.js'

const GROUP = 'avg-fanout'
// Deterministic ID namespace for fan-out increments
const NS = '1b671a64-40d5-491e-99b0-da01ff1f3341'

function deterministicIncrementId(sourceEventId: string, ancestorId: bigint): string {
  return uuidv5(`${sourceEventId}:${ancestorId}`, NS)
}

export function fanOut(
  e: MemberActivated | MemberQualified | RankAchieved,
  placementPath: bigint[],
  placementSides: string[]
): CounterIncrement[] {
  const increments: CounterIncrement[] = []
  const sourceMemberId =
    e.event_type === 'RankAchieved' ? e.member_id : e.member_id

  for (let i = 0; i < placementPath.length; i++) {
    const ancestorId = placementPath[i]
    const side = placementSides[i] as 'L' | 'R'

    let counterType: 'active' | 'qualified' | 'rank_achiever'
    let rankLevel: number | undefined

    if (e.event_type === 'MemberActivated') {
      counterType = 'active'
    } else if (e.event_type === 'MemberQualified') {
      counterType = 'qualified'
    } else {
      // RankAchieved — only fan out levels 4..11; skip 1..3 and 12
      if (e.rank_level < 4 || e.rank_level > 11) continue
      counterType = 'rank_achiever'
      rankLevel = e.rank_level
    }

    const inc: CounterIncrement = {
      event_id:         deterministicIncrementId(e.event_id, ancestorId),
      event_type:       'CounterIncrement',
      occurred_at:      e.occurred_at,
      schema_version:   1,
      ancestor_id:      Number(ancestorId),
      side,
      counter_type:     counterType,
      source_member_id: sourceMemberId,
      source_event_id:  e.event_id,
    }
    if (rankLevel !== undefined) inc.rank_level = rankLevel
    increments.push(inc)
  }
  return increments
}

export async function run() {
  await startConsumer({
    stream: TOPICS.lifecycle.name,
    group:  GROUP,
    mode:   'message',
    onMessage: async (value) => {
      const e = JSON.parse(value) as AvgEvent

      if (
        e.event_type !== 'MemberActivated' &&
        e.event_type !== 'MemberQualified' &&
        e.event_type !== 'RankAchieved'
      ) return

      // Check idempotency
      const alreadyDone = await withTxn(async (c) => {
        const { rows } = await c.query(
          'SELECT 1 FROM processed_events WHERE consumer_group=$1 AND event_id=$2',
          [GROUP, e.event_id]
        )
        return rows.length > 0
      })
      if (alreadyDone) return

      // Read placement data from DB
      const { rows: mRows } = await pool().query<{
        placement_path: string[]; placement_sides: string[]
      }>(
        'SELECT placement_path, placement_sides FROM members WHERE id = $1',
        [e.member_id]
      )
      if (!mRows[0]) return

      const placementPath  = (mRows[0].placement_path  ?? []).map(BigInt)
      const placementSides = mRows[0].placement_sides  ?? []

      const increments = fanOut(
        e as MemberActivated | MemberQualified | RankAchieved,
        placementPath,
        placementSides
      )

      // Produce first, then record — at-least-once is safe; downstream dedupes via
      // deterministic uuidv5 increment ids (sourceEventId:ancestorId).
      if (increments.length > 0) {
        for (const inc of increments) {
          await publishToStream(TOPICS.increments.name, JSON.stringify(inc))
        }
      }

      await withTxn(async (c) => {
        await c.query(
          'INSERT INTO processed_events (consumer_group, event_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [GROUP, e.event_id]
        )
      })
    },
  })
}

const _argv1 = process.argv[1] ?? ''
if (_argv1.endsWith('fanout.ts') || _argv1.endsWith('fanout.js')) {
  run().catch((err) => {
    console.error('[fanout] fatal', err)
    process.exit(1)
  })
}
