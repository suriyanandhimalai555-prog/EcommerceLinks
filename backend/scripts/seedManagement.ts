import argon2 from 'argon2'
import { pool, withTxn } from '../src/lib/db.js'
import 'dotenv/config'

const MGMT_EMAIL = 'management@avg.com'
const MGMT_CODE = 'AVGMGMT1'

/**
 * Seeds the default management account — the off-tree master account that
 * holds admin control (role='management'), separate from the tree root.
 *
 * Order matters and is idempotent:
 *   1. create the management account if missing
 *   2. only then demote the tree root to role='member'
 * so there is never a state without a working admin login.
 */
export async function seedManagement(): Promise<void> {
  const password = process.env.MGMT_SEED_PASSWORD
  if (!password) {
    throw new Error(
      '[seedManagement] MGMT_SEED_PASSWORD env var is required — refusing to seed ' +
      'with a hardcoded credential. Set it in .env and rotate any shared credentials.'
    )
  }

  await withTxn(async (c) => {
    const { rows: existing } = await c.query(
      `SELECT id FROM members WHERE role = 'management' LIMIT 1`
    )
    if (existing.length === 0) {
      const passwordHash = await argon2.hash(password)
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO members
           (member_code, name, phone, email, password_hash,
            sponsor_id, parent_id, position,
            placement_path, placement_sides,
            is_active, activated_at, role)
         VALUES ($1,'AVG Management','9999999998',$2,$3,
                 NULL,NULL,NULL,'{}','{}',TRUE,now(),'management')
         RETURNING id`,
        [MGMT_CODE, MGMT_EMAIL, passwordHash]
      )
      const mgmtId = BigInt(rows[0].id)
      // Counters + wallet rows keep every member-shaped query well-defined for
      // this account, even though it never participates in the tree.
      await c.query('INSERT INTO member_counters (member_id) VALUES ($1)', [mgmtId])
      const { rows: wRows } = await c.query<{ id: string }>(
        `INSERT INTO accounts (owner_type, owner_id, kind) VALUES ('member',$1,'wallet') RETURNING id`,
        [mgmtId]
      )
      const { rows: dRows } = await c.query<{ id: string }>(
        `INSERT INTO accounts (owner_type, owner_id, kind) VALUES ('member',$1,'deferred_bonus') RETURNING id`,
        [mgmtId]
      )
      await c.query(
        'INSERT INTO wallet_balances (account_id, balance) VALUES ($1,0),($2,0)',
        [wRows[0].id, dRows[0].id]
      )
      console.log(`Management account created: ${MGMT_CODE} (${MGMT_EMAIL})`)
    } else {
      console.log('Management account already exists.')
    }

    // Separation of duties: the tree root is a business account, not an admin.
    const { rowCount } = await c.query(
      `UPDATE members SET role = 'member'
       WHERE parent_id IS NULL AND role = 'admin'`
    )
    if (rowCount && rowCount > 0) {
      console.log('Tree root demoted to role=member (admin control now lives on the management account).')
    }
  })
}

const _argv1 = process.argv[1] ?? ''
if (_argv1.endsWith('seedManagement.ts') || _argv1.endsWith('seedManagement.js')) {
  seedManagement()
    .then(() => pool().end())
    .catch((err) => {
      console.error('seedManagement failed:', err)
      process.exit(1)
    })
}
