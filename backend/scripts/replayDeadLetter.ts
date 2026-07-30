/**
 * replayDeadLetter.ts — one-shot DLQ recovery script.
 *
 * Replays a single dead_letter row back onto its Redis stream, then deletes
 * the row.  This is exactly what `POST /admin/dead-letters/:id/replay` does,
 * but runnable without a web server.
 *
 * Usage:
 *   npx tsx scripts/replayDeadLetter.ts <dead_letter_id>
 *
 * After running, start / keep running `npm run dev:workers` so the ledger
 * consumer picks up the re-delivered event.
 */
import 'dotenv/config'
import { pool, withTxn } from '../src/lib/db.js'
import { publishToStream } from '../src/lib/streams.js'
import { redis } from '../src/lib/redis.js'

const id = process.argv[2]
if (!id || isNaN(Number(id))) {
  console.error('Usage: npx tsx scripts/replayDeadLetter.ts <dead_letter_id>')
  process.exit(1)
}

async function run() {
  const { rows } = await pool().query<{
    id: string
    stream: string
    consumer_group: string
    entry_id: string
    payload: string
  }>(
    'SELECT id, stream, consumer_group, entry_id, payload FROM dead_letters WHERE id = $1',
    [id]
  )
  if (!rows[0]) {
    console.error(`dead_letter id=${id} not found — already replayed?`)
    process.exit(1)
  }
  const row = rows[0]
  console.log(`Re-publishing to stream: ${row.stream}`)
  console.log(`Payload preview: ${row.payload.slice(0, 120)}…`)

  // Publish first — if delete fails the row survives and can be retried.
  await publishToStream(row.stream, row.payload)
  console.log('  ✓ event published to Redis stream')

  // Delete from dead_letters
  await withTxn(async (c) => {
    const { rowCount } = await c.query('DELETE FROM dead_letters WHERE id = $1', [id])
    if (!rowCount || rowCount === 0) {
      console.warn('  ⚠ row was already deleted by a concurrent replay — no-op')
      return
    }
    console.log(`  ✓ dead_letter id=${id} deleted`)
  })

  console.log('\nDone. Run `npm run dev:workers` (or keep it running) so the')
  console.log('ledger consumer processes the re-delivered event.')
}

run()
  .then(() => pool().end())
  .then(() => redis().quit())
  .catch((err) => {
    console.error('replayDeadLetter failed:', err)
    process.exit(1)
  })
