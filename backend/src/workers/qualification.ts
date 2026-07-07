import { pool, withTxn } from '../lib/db.js'
import { createConsumer } from '../lib/kafka.js'
import { evaluateQualification } from '../services/qualification.js'
import { TOPICS } from '../events/topics.js'
import type { AvgEvent } from '../events/types.js'

const GROUP = 'avg-qualification'

async function run() {
  const consumer = createConsumer(GROUP)
  await consumer.connect()
  await consumer.subscribe({ topic: TOPICS.lifecycle.name, fromBeginning: false })
  console.log('[qualification] started')

  await consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return
      const e = JSON.parse(message.value.toString()) as AvgEvent
      if (e.event_type !== 'MemberActivated') return

      // Idempotency check
      const already = await withTxn(async (c) => {
        const { rows } = await c.query(
          'SELECT 1 FROM processed_events WHERE consumer_group=$1 AND event_id=$2',
          [GROUP, e.event_id]
        )
        return rows.length > 0
      })
      if (already) return

      const memberId = BigInt(e.member_id)

      // Look up sponsor chain (sponsor tree, NOT placement)
      const { rows: m } = await pool().query<{ sponsor_id: string | null }>(
        'SELECT sponsor_id FROM members WHERE id = $1',
        [memberId]
      )
      const sponsorId = m[0]?.sponsor_id ? BigInt(m[0].sponsor_id) : null

      let grandSponsorId: bigint | null = null
      if (sponsorId) {
        const { rows: s } = await pool().query<{ sponsor_id: string | null }>(
          'SELECT sponsor_id FROM members WHERE id = $1',
          [sponsorId]
        )
        grandSponsorId = s[0]?.sponsor_id ? BigInt(s[0].sponsor_id) : null
      }

      // Evaluate: X, sponsor(X), sponsor(sponsor(X))
      const candidates = [memberId, sponsorId, grandSponsorId].filter(Boolean) as bigint[]
      await withTxn(async (c) => {
        for (const candidate of candidates) {
          await evaluateQualification(candidate, c)
        }
        await c.query(
          'INSERT INTO processed_events (consumer_group, event_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [GROUP, e.event_id]
        )
      })
    },
  })
}

run().catch((err) => {
  console.error('[qualification] fatal', err)
  process.exit(1)
})
