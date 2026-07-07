import { pool } from '../src/lib/db.js'
import { registerMember } from '../src/services/placement.js'
import { confirmOrder } from '../src/api/orders.js'
import 'dotenv/config'

const N = parseInt(process.argv[2] ?? '10', 10)

interface Member {
  id: string
  memberCode: string
  name: string
}

async function simulate() {
  // Fetch root
  const { rows: rootRows } = await pool().query<{ id: string; member_code: string }>(
    `SELECT id, member_code FROM members WHERE parent_id IS NULL LIMIT 1`
  )
  if (!rootRows[0]) throw new Error('Run scripts/seedRoot.ts first')
  const root: Member = { id: rootRows[0].id, memberCode: rootRows[0].member_code, name: 'Root' }

  console.log(`Simulating ${N} members under root ${root.memberCode}`)

  const members: Member[] = [root]

  for (let i = 0; i < N; i++) {
    // Pick random sponsor from existing members
    const sponsor = members[Math.floor(Math.random() * members.length)]
    const leg: 'L' | 'R' = i % 2 === 0 ? 'L' : 'R'

    try {
      const { memberId, memberCode } = await registerMember({
        sponsorCode:  sponsor.memberCode,
        preferredLeg: leg,
        name:         `Sim Member ${i + 1}`,
        phone:        `98${String(i + 1).padStart(9, '0')}`,
        password:     'Sim@12345',
      })

      // Simulate first product payment (Starter ₹10,000)
      const { rows: orderRows } = await pool().query<{ id: string }>(
        `INSERT INTO orders (member_id, product_id, base_amount, gst_amount, total_amount, idempotency_key)
         VALUES ($1, 1, 10000, 1800, 11800, $2) RETURNING id`,
        [memberId, `sim-${memberCode}-${Date.now()}`]
      )

      await confirmOrder(`sim-gw-${orderRows[0].id}`, BigInt(orderRows[0].id), `sim-ref-${orderRows[0].id}`)

      members.push({ id: String(memberId), memberCode, name: `Sim Member ${i + 1}` })
      if ((i + 1) % 10 === 0) console.log(`  ${i + 1}/${N} registered + activated`)
    } catch (err: unknown) {
      const e = err as { message?: string }
      console.warn(`  [${i}] skipped: ${e.message}`)
    }
  }

  // Drain: wait 3s for workers to process outbox (in a real test, poll instead)
  console.log('Waiting 3s for worker pipeline...')
  await new Promise((r) => setTimeout(r, 3000))

  // Print top 5 members by pairs_matched
  const { rows: top } = await pool().query(
    `SELECT m.member_code, mc.left_active, mc.right_active, mc.pairs_matched,
            mc.left_qualified, mc.right_qualified,
            COALESCE(wb.balance, 0) AS wallet
     FROM member_counters mc
     JOIN members m ON m.id = mc.member_id
     LEFT JOIN accounts a ON a.owner_id = m.id AND a.kind='wallet'
     LEFT JOIN wallet_balances wb ON wb.account_id = a.id
     ORDER BY mc.pairs_matched DESC
     LIMIT 5`
  )
  console.log('\nTop 5 by pairs_matched:')
  for (const r of top) {
    console.log(`  ${r.member_code}: L=${r.left_active} R=${r.right_active} pairs=${r.pairs_matched} qualL=${r.left_qualified} qualR=${r.right_qualified} wallet=₹${r.wallet}`)
  }

  await pool().end()
}

simulate().catch((err) => {
  console.error('simulate failed:', err)
  process.exit(1)
})
