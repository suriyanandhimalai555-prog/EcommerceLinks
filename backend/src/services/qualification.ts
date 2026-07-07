import { randomUUID } from 'crypto'
import type pg from 'pg'
import { writeOutbox } from '../events/outbox.js'

// Evaluates BR-5 for a single member, inside the caller's transaction.
// Returns true if the member just became qualified (transition only).
export async function evaluateQualification(
  memberId: bigint,
  c: pg.PoolClient
): Promise<boolean> {
  const { rows } = await c.query<{ id: string; child_id: string; grandchild_id: string }>(
    `UPDATE members m
        SET is_qualified = TRUE, qualified_at = now()
      WHERE m.id = $1
        AND m.is_active
        AND NOT m.is_qualified
        AND EXISTS (
          SELECT 1 FROM members r
          JOIN members g ON g.sponsor_id = r.id AND g.is_active
          WHERE r.sponsor_id = m.id AND r.is_active
          LIMIT 1
        )
      RETURNING
        m.id,
        (SELECT r.id FROM members r WHERE r.sponsor_id = m.id AND r.is_active LIMIT 1) AS child_id,
        (SELECT g.id FROM members r
          JOIN members g ON g.sponsor_id = r.id AND g.is_active
          WHERE r.sponsor_id = m.id AND r.is_active LIMIT 1) AS grandchild_id`,
    [memberId]
  )

  if (rows.length === 0) return false

  await writeOutbox(c, {
    event_id:          randomUUID(),
    event_type:        'MemberQualified',
    occurred_at:       new Date().toISOString(),
    schema_version:    1,
    member_id:         Number(memberId),
    via_child_id:      Number(rows[0].child_id),
    via_grandchild_id: Number(rows[0].grandchild_id),
  })
  return true
}
