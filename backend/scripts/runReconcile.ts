/**
 * runReconcile.ts — one-shot reconciler run for manual verification.
 * Usage: npx tsx scripts/runReconcile.ts
 */
import 'dotenv/config'
import { reconcile } from '../src/workers/reconciler.js'
import { pool } from '../src/lib/db.js'

const alerts = await reconcile()
console.log(`\nTotal alerts: ${alerts.length}`)
if (alerts.length === 0) {
  console.log('✓ No drift detected — counters, pairs, accruals and wallets are all consistent.')
}
await pool().end()
