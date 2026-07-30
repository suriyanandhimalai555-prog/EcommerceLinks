import 'dotenv/config'
import { Redis } from 'ioredis'

async function main() {
  const r = new Redis(process.env.REDIS_URL!)
  const len = await r.xlen('avg.ledger.commands')
  console.log('avg.ledger.commands stream length:', len)
  const recent = await r.xrevrange('avg.ledger.commands', '+', '-', 'COUNT', '5')
  console.log('Recent entries:')
  for (const [id, fields] of recent) {
    const data = fields[1] ?? ''
    console.log(' ', id, '→', data.slice(0, 120))
  }
  const groups = await r.xinfo('GROUPS', 'avg.ledger.commands')
  console.log('Consumer groups:', JSON.stringify(groups, null, 2))
  await r.quit()
}
main().catch(console.error)
