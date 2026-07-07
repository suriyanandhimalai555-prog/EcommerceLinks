import { pool } from '../lib/db.js'
import { getProducer } from '../lib/kafka.js'

interface OutboxRow {
  id: string
  event_id: string
  topic: string
  partition_key: string
  payload: unknown
}

async function relay() {
  const producer = await getProducer()
  console.log('[outbox-relay] started')

  while (true) {
    try {
      const client = await pool().connect()
      try {
        await client.query('BEGIN')
        const { rows } = await client.query<OutboxRow>(
          `SELECT id, event_id, topic, partition_key, payload
           FROM events_outbox
           WHERE published_at IS NULL
           ORDER BY id
           LIMIT 500
           FOR UPDATE SKIP LOCKED`
        )

        if (rows.length > 0) {
          // Group by topic for batching
          const byTopic = new Map<string, OutboxRow[]>()
          for (const row of rows) {
            const bucket = byTopic.get(row.topic) ?? []
            bucket.push(row)
            byTopic.set(row.topic, bucket)
          }

          for (const [topic, batch] of byTopic) {
            await producer.send({
              topic,
              messages: batch.map((r) => ({
                key:   r.partition_key,
                value: JSON.stringify(r.payload),
              })),
            })
          }

          const ids = rows.map((r) => r.id)
          await client.query(
            `UPDATE events_outbox SET published_at = now() WHERE id = ANY($1::bigint[])`,
            [ids]
          )
        }

        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        console.error('[outbox-relay] error', err)
      } finally {
        client.release()
      }
    } catch (err) {
      console.error('[outbox-relay] pool error', err)
    }

    await new Promise((r) => setTimeout(r, 100))
  }
}

relay().catch((err) => {
  console.error('[outbox-relay] fatal', err)
  process.exit(1)
})
