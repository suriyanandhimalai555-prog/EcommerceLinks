import { randomUUID } from 'crypto'
import argon2 from 'argon2'
import type pg from 'pg'
import { pool, withTxn } from '../lib/db.js'
import { nextMemberCode } from '../lib/ids.js'
import { writeOutbox } from '../events/outbox.js'

export async function findPlacementSlot(
  sponsorId: bigint,
  leg: 'L' | 'R',
  c: pg.PoolClient
): Promise<{ parentId: bigint; position: 'L' | 'R' }> {
  let nodeId = sponsorId
  while (true) {
    const { rows } = await c.query<{ id: string }>(
      'SELECT id FROM members WHERE parent_id = $1 AND position = $2',
      [nodeId, leg]
    )
    if (rows.length === 0) return { parentId: nodeId, position: leg }
    nodeId = BigInt(rows[0].id)
  }
}

interface RegisterInput {
  sponsorCode: string
  preferredLeg: 'L' | 'R'
  name: string
  phone: string
  email?: string
  password: string
}

export async function registerMember(
  input: RegisterInput
): Promise<{ memberId: bigint; memberCode: string }> {
  const MAX_RETRIES = 5

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await withTxn(async (c) => {
        // Resolve sponsor
        const { rows: sRows } = await c.query<{
          id: string
          placement_path: string[]
          placement_sides: string[]
        }>(
          'SELECT id, placement_path, placement_sides FROM members WHERE member_code = $1',
          [input.sponsorCode]
        )
        if (sRows.length === 0) {
          const e = new Error('Sponsor not found') as Error & { statusCode: number }
          e.statusCode = 404
          throw e
        }
        const sponsor = sRows[0]
        const sponsorId = BigInt(sponsor.id)

        // Walk to placement slot
        const { parentId, position } = await findPlacementSlot(sponsorId, input.preferredLeg, c)

        // Read parent's path arrays
        const { rows: pRows } = await c.query<{
          id: string
          placement_path: string[]
          placement_sides: string[]
        }>(
          'SELECT id, placement_path, placement_sides FROM members WHERE id = $1',
          [parentId]
        )
        const parent = pRows[0]
        // path = parent.placement_path + parent.id; sides = parent.placement_sides + position
        const newPath = [...(parent.placement_path ?? []).map(String), String(parent.id)]
        const newSides = [...(parent.placement_sides ?? []), position]

        const passwordHash = await argon2.hash(input.password)

        // Insert with a temp unique member_code; update after getting id
        const tmpCode = 'TMP-' + randomUUID()
        const { rows: ins } = await c.query<{ id: string }>(
          `INSERT INTO members
             (member_code, name, phone, email, password_hash,
              sponsor_id, parent_id, position, placement_path, placement_sides)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           RETURNING id`,
          [
            tmpCode, input.name, input.phone, input.email ?? null, passwordHash,
            sponsorId, parentId, position, newPath, newSides,
          ]
        )
        const memberId = BigInt(ins[0].id)
        const memberCode = nextMemberCode(memberId)
        await c.query('UPDATE members SET member_code = $1 WHERE id = $2', [memberCode, memberId])

        // Counters row + accounts + wallet_balances
        await c.query('INSERT INTO member_counters (member_id) VALUES ($1)', [memberId])

        const { rows: wRows } = await c.query<{ id: string }>(
          `INSERT INTO accounts (owner_type, owner_id, kind) VALUES ('member',$1,'wallet') RETURNING id`,
          [memberId]
        )
        const { rows: dRows } = await c.query<{ id: string }>(
          `INSERT INTO accounts (owner_type, owner_id, kind) VALUES ('member',$1,'deferred_bonus') RETURNING id`,
          [memberId]
        )
        await c.query(
          'INSERT INTO wallet_balances (account_id, balance) VALUES ($1,0),($2,0)',
          [wRows[0].id, dRows[0].id]
        )

        await writeOutbox(c, {
          event_id:        randomUUID(),
          event_type:      'MemberRegistered',
          occurred_at:     new Date().toISOString(),
          schema_version:  1,
          member_id:       Number(memberId),
          sponsor_id:      Number(sponsorId),
          parent_id:       Number(parentId),
          position,
          placement_path:  newPath.map(Number),
          placement_sides: newSides,
        })

        return { memberId, memberCode }
      })
    } catch (err: unknown) {
      const pg = err as { code?: string; constraint?: string; statusCode?: number }
      if (pg.code === '23505' && pg.constraint === 'uq_placement_slot' && attempt < MAX_RETRIES - 1) {
        continue
      }
      throw err
    }
  }

  const e = new Error('Placement slot conflict — max retries exceeded') as Error & { statusCode: number }
  e.statusCode = 409
  throw e
}

// Shared helper: look up a member by phone for auth
export async function findMemberByPhone(phone: string) {
  const { rows } = await pool().query<{
    id: string; member_code: string; name: string; phone: string
    password_hash: string; is_active: boolean; kyc_status: string; bank_status: string
  }>(
    'SELECT id, member_code, name, phone, password_hash, is_active, kyc_status, bank_status FROM members WHERE phone = $1',
    [phone]
  )
  return rows[0] ?? null
}
