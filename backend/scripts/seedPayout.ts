import argon2 from 'argon2'
import { pool, withTxn } from '../src/lib/db.js'
import 'dotenv/config'

const PAYOUT_EMAIL = 'payout@avg.com'
const PAYOUT_CODE = 'AVGPAY01'

/**
 * Reserved ID for the payout account. One below the management reserved ID
 * (99999999) so it never collides with the auto-incrementing IDENTITY sequence
 * used by regular members.
 */
export const PAYOUT_RESERVED_ID = 99999998n;

/**
 * Seeds the payout master account — an off-tree dedicated account for
 * withdrawal-marking staff (role='payout'). It has no earnings of its own
 * so it can never approve its own withdrawal (separation of duties).
 *
 * Structurally mirrors seedManagement.ts:
 *   - Off-tree (parent_id NULL, empty placement path/sides)
 *   - OVERRIDING SYSTEM VALUE for a reserved high ID
 *   - member_counters + accounts + wallet_balances rows so every
 *     member-shaped query stays well-defined for this account
 *
 * Does NOT demote the tree root (that is management-specific).
 * Idempotent: safe to re-run if the account already exists.
 */
export async function seedPayout(): Promise<void> {
  const password = process.env.PAYOUT_SEED_PASSWORD
  if (!password) {
    throw new Error(
      '[seedPayout] PAYOUT_SEED_PASSWORD env var is required — refusing to seed ' +
      'with a hardcoded credential. Set it in .env and rotate any shared credentials.'
    )
  }

  await withTxn(async (c) => {
    const { rows: existing } = await c.query(
      `SELECT id FROM members WHERE role = 'payout' LIMIT 1`
    )
    if (existing.length === 0) {
      const passwordHash = await argon2.hash(password)
      await c.query(
        `INSERT INTO members
           (id, member_code, name, phone, email, password_hash,
            sponsor_id, parent_id, position,
            placement_path, placement_sides,
            is_active, activated_at, role)
         OVERRIDING SYSTEM VALUE
         VALUES ($1,$2,'AVG Payout','9999999997',$3,$4,
                 NULL,NULL,NULL,'{}','{}',TRUE,now(),'payout')`,
        [PAYOUT_RESERVED_ID, PAYOUT_CODE, PAYOUT_EMAIL, passwordHash]
      )
      // Counters + wallet rows keep every member-shaped query well-defined for
      // this account, even though it never participates in the tree.
      await c.query('INSERT INTO member_counters (member_id) VALUES ($1)', [PAYOUT_RESERVED_ID])
      const { rows: wRows } = await c.query<{ id: string }>(
        `INSERT INTO accounts (owner_type, owner_id, kind) VALUES ('member',$1,'wallet') RETURNING id`,
        [PAYOUT_RESERVED_ID]
      )
      const { rows: dRows } = await c.query<{ id: string }>(
        `INSERT INTO accounts (owner_type, owner_id, kind) VALUES ('member',$1,'deferred_bonus') RETURNING id`,
        [PAYOUT_RESERVED_ID]
      )
      await c.query(
        'INSERT INTO wallet_balances (account_id, balance) VALUES ($1,0),($2,0)',
        [wRows[0].id, dRows[0].id]
      )
      console.log(`Payout account created: ${PAYOUT_CODE} (${PAYOUT_EMAIL}) [reserved id=${PAYOUT_RESERVED_ID}]`)
    } else {
      console.log('Payout account already exists.')
    }
  })
}

const _argv1 = process.argv[1] ?? ''
if (_argv1.endsWith('seedPayout.ts') || _argv1.endsWith('seedPayout.js')) {
  seedPayout()
    .then(() => pool().end())
    .catch((err) => {
      console.error('seedPayout failed:', err)
      process.exit(1)
    })
}
