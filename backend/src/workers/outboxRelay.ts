import { pool } from '../lib/db.js'
import { publishToStream } from '../lib/streams.js'

interface OutboxRow {
  id: string
  event_id: string
  topic: string
  partition_key: string
  payload: unknown
}

export async function run() {
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
          for (const row of rows) {
            await publishToStream(row.topic, JSON.stringify(row.payload))
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

const _argv1 = process.argv[1] ?? ''
if (_argv1.endsWith('outboxRelay.ts') || _argv1.endsWith('outboxRelay.js')) {
  run().catch((err) => {
    console.error('[outbox-relay] fatal', err)
    process.exit(1)
  })
}
