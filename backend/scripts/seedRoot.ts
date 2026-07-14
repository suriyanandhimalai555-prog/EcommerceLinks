import argon2 from 'argon2'
import { pool, withTxn } from '../src/lib/db.js'
import { nextMemberCode } from '../src/lib/ids.js'
import { ensureCutoffExists } from '../src/workers/cutoff.js'
import 'dotenv/config'

export const ROOT_SEED_EMAIL =
  process.env.ROOT_SEED_EMAIL ?? 'agilanvasudevangbk7@gmail.com'

export async function seedRoot(): Promise<void> {
  const rootPassword = process.env.ROOT_SEED_PASSWORD
  if (!rootPassword) {
    throw new Error(
      '[seedRoot] ROOT_SEED_PASSWORD env var is required — refusing to seed with a ' +
      'hardcoded credential. Set it in .env (e.g. ROOT_SEED_PASSWORD=YourSecurePass) ' +
      'and rotate any previously-seeded credentials.'
    )
  }

  await withTxn(async (c) => {
    // Check if root already exists
    // Management accounts also sit at parent_id NULL — only a non-management
    // row counts as the tree root here.
    const { rows: existing } = await c.query(
      `SELECT id FROM members WHERE parent_id IS NULL AND role <> 'management' LIMIT 1`
    )
    if (existing.length > 0) {
      console.log('Root member already exists:', nextMemberCode(BigInt(existing[0].id)))
      return
    }

    const passwordHash = await argon2.hash(rootPassword)

    // Insert root — no parent_id, no position, empty path arrays; role='admin'
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO members
         (member_code, name, phone, email, password_hash,
          sponsor_id, parent_id, position,
          placement_path, placement_sides,
          is_active, activated_at, role)
       VALUES ('TMP-ROOT','Root Admin','9999999999',$2,$1,
               NULL,NULL,NULL,'{}','{}',TRUE,now(),'admin')
       RETURNING id`,
      [passwordHash, ROOT_SEED_EMAIL]
    )
    const rootId   = BigInt(rows[0].id)
    const rootCode = nextMemberCode(rootId)

    // Verified KYC so the dev root can exercise the purchase flow without a
    // manual review pass (the /orders route gates on kyc_status).
    await c.query(
      `UPDATE members SET member_code=$1, kyc_status='verified' WHERE id=$2`,
      [rootCode, rootId]
    )
    await c.query('INSERT INTO member_counters (member_id) VALUES ($1)', [rootId])

    const { rows: wRows } = await c.query<{ id: string }>(
      `INSERT INTO accounts (owner_type, owner_id, kind) VALUES ('member',$1,'wallet') RETURNING id`,
      [rootId]
    )
    const { rows: dRows } = await c.query<{ id: string }>(
      `INSERT INTO accounts (owner_type, owner_id, kind) VALUES ('member',$1,'deferred_bonus') RETURNING id`,
      [rootId]
    )
    await c.query(
      'INSERT INTO wallet_balances (account_id, balance) VALUES ($1,0),($2,0)',
      [wRows[0].id, dRows[0].id]
    )

    console.log(`Root member created: ${rootCode} (${ROOT_SEED_EMAIL})`)
  })

  await ensureCutoffExists()
  console.log('Cutoff window ensured.')
}

const _argv1 = process.argv[1] ?? ''
if (_argv1.endsWith('seedRoot.ts') || _argv1.endsWith('seedRoot.js')) {
  seedRoot()
    .then(() => pool().end())
    .catch((err) => {
      console.error('seedRoot failed:', err)
      process.exit(1)
    })
}
