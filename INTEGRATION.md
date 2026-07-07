# INTEGRATION.md — Connect the frontend to the backend

**Audience:** a junior engineer or a smaller model. Follow the steps **in order**. Do not skip, reorder, or improvise. Every code block is complete — copy it exactly. When a step says "replace", the old text must match exactly what is in the file; if it doesn't, stop and re-read the file first.

**Strategy (already decided — do not revisit):** the frontend's mock layer (`frontend/src/mocks/handlers.ts` + `frontend/src/types/api.ts`) is the API contract. We make the **backend** speak that contract by adding ONE new route file and swapping it in, instead of editing 15 frontend pages. Fastify crashes on duplicate routes, so we unregister the old route modules and register the new one.

---

## Step 0 — Start the backend stack (nothing works without this)

From `backend/`, in separate terminals:

```bash
docker compose up -d
npm install
npm run migrate
npm run topics
npm run seed          # prints: Root member created: AGV100001
npm run worker:outbox
npm run worker:fanout
npm run worker:counter
npm run worker:qualification
npm run worker:ledger
npm run worker:rank
```

Keep all six workers running. (worker:cutoff / worker:payout / worker:reconciler are not needed for integration testing; `npm run seed` already opened a cutoff window.)

Do **not** start `npm run dev` yet — we edit the server first.

---

## Step 1 — Fix the port mismatch with a frontend `.env`

Create the file `frontend/.env` with exactly this content:

```
VITE_API_URL=http://localhost:3000
VITE_USE_MOCKS=false
```

Why: the backend listens on **3000** by default; the old root `.env.example` wrongly said 4000, and mocks must be off or MSW intercepts every request. (If the Vite dev server is already running, restart it after creating this file — Vite only reads `.env` at startup.)

---

## Step 2 — Create the compatibility route file (the big one)

Create a **new file** `backend/src/api/frontend.ts` with exactly this content:

```typescript
/**
 * frontend.ts — serves the exact API contract defined by
 * frontend/src/mocks/handlers.ts and frontend/src/types/api.ts.
 * Replaces orderRoutes, networkRoutes, walletRoutes, reportRoutes.
 * Keep the webhook here (orders.ts is no longer registered).
 */
import { randomUUID } from 'crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pool } from '../lib/db.js'
import { redis } from '../lib/redis.js'
import { toPaise, fromPaise, pct } from '../lib/money.js'
import { confirmOrder } from './orders.js'
import { QUALIFIED_THRESHOLDS } from '../domain/ranks.js'
import { CFG } from '../config.js'

// Display names the frontend expects (index 1..12)
const RANK_NAMES: Record<number, string> = {
  1: 'Starter Achiever',       2: 'International Achiever',
  3: 'Bike Achiever',          4: 'Car Achiever',
  5: 'Gold Achiever',          6: '10L Gold Achiever',
  7: '30L Gold Achiever',      8: 'Villa Achiever',
  9: 'Crorepati Gold Achiever',10: 'Dubai Villa Achiever',
  11: 'Global Luxury Achiever',12: 'Royal Achiever',
}

const PRODUCT_BADGES: Record<number, string[]> = {
  1: ['ENTRY LEVEL'], 2: ['POPULAR'], 3: ['BEST VALUE'],
}

type Auth = { sub: string }

// ---------- shared helpers ----------

export async function buildMe(memberId: string) {
  const { rows } = await pool().query<{
    member_code: string; name: string; phone: string; email: string | null
    kyc_status: string; bank_status: string; is_active: boolean; created_at: string
    sponsor_code: string | null
  }>(
    `SELECT m.member_code, m.name, m.phone, m.email, m.kyc_status, m.bank_status,
            m.is_active, m.created_at, s.member_code AS sponsor_code
     FROM members m LEFT JOIN members s ON s.id = m.sponsor_id
     WHERE m.id = $1`,
    [memberId]
  )
  if (!rows[0]) return null
  const m = rows[0]
  const { rows: rk } = await pool().query<{ max: string | null }>(
    'SELECT MAX(rank_level) AS max FROM rank_achievements WHERE member_id = $1',
    [memberId]
  )
  const level = rk[0]?.max ? parseInt(rk[0].max) : 0
  return {
    memberCode: m.member_code,
    name: m.name,
    phone: m.phone,
    email: m.email ?? undefined,
    sponsorCode: m.sponsor_code ?? '',
    joinedAt: m.created_at,
    isActive: m.is_active,
    kycStatus: m.kyc_status,
    bankStatus: m.bank_status,
    currentRankLevel: level,
    currentRankName: level > 0 ? RANK_NAMES[level] : 'Member',
  }
}

function mapRefType(referenceType: string): 'pair' | 'payout' | 'sweep' | 'manual' {
  if (referenceType === 'pair') return 'pair'
  if (referenceType === 'payout_item') return 'payout'
  if (referenceType === 'sweep') return 'sweep'
  return 'manual'
}

function describe(refType: string, referenceId: string | null): string {
  if (refType === 'pair') return `Pair Match Bonus #${referenceId ?? ''}`
  if (refType === 'payout') return 'Payout to bank'
  if (refType === 'sweep') return 'Weekly cap sweep'
  return 'Transaction'
}

async function ledgerItems(memberId: string, cursor: string | null, limit: number) {
  const cursorClause = cursor ? 'AND le.id < $3' : ''
  const params: (string | number)[] = [memberId, limit]
  if (cursor) params.push(parseInt(cursor))
  const { rows } = await pool().query<{
    id: string; direction: string; amount: string; created_at: string
    reference_type: string; reference_id: string | null
  }>(
    `SELECT le.id, le.direction, le.amount, le.created_at, lt.reference_type, lt.reference_id
     FROM ledger_entries le
     JOIN ledger_txns lt ON lt.txn_id = le.txn_id
     JOIN accounts a ON a.id = le.account_id
     WHERE a.owner_id = $1 AND a.kind = 'wallet' ${cursorClause}
     ORDER BY le.id DESC LIMIT $2`,
    params
  )
  const items = rows.map((r) => {
    const refType = mapRefType(r.reference_type)
    return {
      at: r.created_at,
      description: describe(refType, r.reference_id),
      direction: r.direction === 'C' ? 'credit' : 'debit',
      amountPaise: Number(toPaise(r.amount)),
      refType,
    }
  })
  return {
    items,
    nextCursor: rows.length === limit ? String(rows[rows.length - 1].id) : null,
    raw: rows,
  }
}

// ---------- tree helpers (same logic as the old network.ts) ----------

interface TreeRow {
  id: string; member_code: string; name: string; position: string | null
  is_active: boolean; is_qualified: boolean; parent_id: string | null
}

function buildTree(rows: TreeRow[], rootId: string, depthLeft: number): Record<string, unknown> | null {
  const node = rows.find((r) => r.id === rootId)
  if (!node) return null
  const result: Record<string, unknown> = {
    memberCode: node.member_code, name: node.name, position: node.position,
    isActive: node.is_active, isQualified: node.is_qualified, left: null, right: null,
  }
  if (depthLeft > 0) {
    for (const child of rows.filter((r) => r.parent_id === rootId)) {
      if (child.position === 'L') result.left = buildTree(rows, child.id, depthLeft - 1)
      if (child.position === 'R') result.right = buildTree(rows, child.id, depthLeft - 1)
    }
  }
  return result
}

// ---------- routes ----------

export async function frontendRoutes(app: FastifyInstance) {
  const auth = { preHandler: [app.authenticate] }

  // ===== me =====
  app.get('/me', auth, async (req, reply) => {
    const me = await buildMe((req.user as Auth).sub)
    if (!me) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Member not found' } })
    return me
  })

  app.put('/me/kyc', auth, async (req, reply) => {
    const memberId = (req.user as Auth).sub
    await pool().query(`UPDATE members SET kyc_status = 'pending' WHERE id = $1 AND kyc_status <> 'verified'`, [memberId])
    const me = await buildMe(memberId)
    return reply.send(me)
  })

  app.put('/me/bank', auth, async (req, reply) => {
    const memberId = (req.user as Auth).sub
    await pool().query(`UPDATE members SET bank_status = 'pending' WHERE id = $1 AND bank_status <> 'verified'`, [memberId])
    const me = await buildMe(memberId)
    return reply.send(me)
  })

  // ===== products & orders =====
  app.get('/products', async () => {
    const { rows } = await pool().query<{ id: number; name: string; base_price: string }>(
      'SELECT id, name, base_price FROM products WHERE active = TRUE ORDER BY id'
    )
    return rows.map((p) => {
      const base = toPaise(p.base_price)
      const gst = pct(base, CFG.GST_PCT)
      return {
        id: Number(p.id),
        name: p.name,
        basePricePaise: Number(base),
        gstPaise: Number(gst),
        totalPaise: Number(base + gst),
        badges: PRODUCT_BADGES[Number(p.id)] ?? [],
      }
    })
  })

  const CreateOrderBody = z.object({ productId: z.number().int().positive() })
  app.post('/orders', auth, async (req, reply) => {
    const body = CreateOrderBody.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: { code: 'BAD_REQUEST', message: 'Invalid body' } })
    const memberId = (req.user as Auth).sub

    const { rows: pRows } = await pool().query<{ base_price: string }>(
      'SELECT base_price FROM products WHERE id = $1 AND active = TRUE', [body.data.productId]
    )
    if (!pRows[0]) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Product not found' } })

    const basePaise = toPaise(pRows[0].base_price)
    const gstPaise = pct(basePaise, CFG.GST_PCT)
    const totalPaise = basePaise + gstPaise
    const idempotencyKey = randomUUID()

    const { rows } = await pool().query<{ id: string }>(
      `INSERT INTO orders (member_id, product_id, base_amount, gst_amount, total_amount, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [memberId, body.data.productId, fromPaise(basePaise), fromPaise(gstPaise), fromPaise(totalPaise), idempotencyKey]
    )
    // Note: idempotencyKey deliberately NOT returned (see GAPS G-2)
    return reply.status(201).send({ orderId: rows[0].id, totalPaise: Number(totalPaise), status: 'created' })
  })

  app.get('/orders/:orderId', auth, async (req, reply) => {
    const { orderId } = req.params as { orderId: string }
    const memberId = (req.user as Auth).sub
    const { rows } = await pool().query<{ id: string; status: string; total_amount: string; name: string }>(
      `SELECT o.id, o.status, o.total_amount, p.name
       FROM orders o JOIN products p ON p.id = o.product_id
       WHERE o.id = $1 AND o.member_id = $2`,
      [orderId, memberId]
    )
    if (!rows[0]) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Order not found' } })
    return {
      orderId: rows[0].id,
      status: rows[0].status,
      productName: rows[0].name,
      totalPaise: Number(toPaise(rows[0].total_amount)),
    }
  })

  // Dev-only: pretend the payment gateway confirmed the order.
  app.post('/dev/simulate-payment', auth, async (req, reply) => {
    if (CFG.NODE_ENV === 'production') {
      return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Not available in production' } })
    }
    const body = z.object({ orderId: z.union([z.string(), z.number()]) }).safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: { code: 'BAD_REQUEST', message: 'orderId required' } })
    const orderId = String(body.data.orderId)
    const { rows } = await pool().query<{ idempotency_key: string }>(
      'SELECT idempotency_key FROM orders WHERE id = $1', [orderId]
    )
    if (!rows[0]) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Order not found' } })
    await confirmOrder(rows[0].idempotency_key, BigInt(orderId), `dev-sim-${orderId}`)
    return { success: true }
  })

  // Payment gateway webhook — preserved from orders.ts (orders.ts is no longer registered)
  const WebhookBody = z.object({
    gatewayEventId: z.string(),
    orderId: z.number().int().positive(),
    paymentRef: z.string(),
    status: z.enum(['success', 'failed']),
  })
  app.post('/webhooks/payment', async (req, reply) => {
    const body = WebhookBody.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: body.error.flatten() })
    if (body.data.status === 'failed') {
      await pool().query(`UPDATE orders SET status = 'paid' WHERE id = $1 AND status = 'created'`, [body.data.orderId])
      return { ok: true }
    }
    await confirmOrder(body.data.gatewayEventId, BigInt(body.data.orderId), body.data.paymentRef)
    return { ok: true }
  })

  // ===== network =====
  app.get('/network/tree', auth, async (req, reply) => {
    const user = req.user as Auth
    const query = req.query as { depth?: string; root?: string }
    const depth = Math.min(4, parseInt(query.depth ?? '3', 10) || 3)
    const rootParam = query.root === 'me' || !query.root ? user.sub : query.root

    let rootId = rootParam
    if (!rootParam.match(/^\d+$/)) {
      const { rows } = await pool().query<{ id: string }>(
        'SELECT id FROM members WHERE member_code = $1', [rootParam]
      )
      if (!rows[0]) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Root not found' } })
      rootId = rows[0].id
    }

    const cacheKey = `tree:${rootId}:${depth}`
    const cached = await redis().get(cacheKey).catch(() => null)
    if (cached) return JSON.parse(cached)

    let currentIds = [rootId]
    const allRows: TreeRow[] = []
    for (let d = 0; d <= depth && currentIds.length > 0; d++) {
      const { rows } = await pool().query<TreeRow>(
        `SELECT id, member_code, name, position, is_active, is_qualified, parent_id
         FROM members WHERE id = ANY($1::bigint[])`, [currentIds]
      )
      allRows.push(...rows)
      if (d < depth) {
        const { rows: children } = await pool().query<{ id: string }>(
          `SELECT id FROM members WHERE parent_id = ANY($1::bigint[])`, [currentIds]
        )
        currentIds = children.map((r) => r.id)
      } else {
        currentIds = []
      }
    }
    const tree = buildTree(allRows, rootId, depth)
    if (!tree) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Root not found' } })
    await redis().setex(cacheKey, 60, JSON.stringify(tree)).catch(() => null)
    return tree
  })

  app.get('/network/summary', auth, async (req) => {
    const memberId = (req.user as Auth).sub

    const { rows: meRows } = await pool().query<{ depth: string }>(
      'SELECT cardinality(placement_path) AS depth FROM members WHERE id = $1', [memberId]
    )
    const myDepth = parseInt(meRows[0]?.depth ?? '0')

    const { rows: agg } = await pool().query<{
      total: string; left_team: string; right_team: string; active: string; qualified: string
    }>(
      `SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE placement_sides[array_position(placement_path, $1::bigint)] = 'L') AS left_team,
              COUNT(*) FILTER (WHERE placement_sides[array_position(placement_path, $1::bigint)] = 'R') AS right_team,
              COUNT(*) FILTER (WHERE is_active) AS active,
              COUNT(*) FILTER (WHERE is_qualified) AS qualified
       FROM members WHERE placement_path @> ARRAY[$1::bigint]`,
      [memberId]
    )

    const { rows: dRows } = await pool().query<{ position: string; cnt: string }>(
      `SELECT position, COUNT(*) AS cnt FROM members WHERE parent_id = $1 GROUP BY position`, [memberId]
    )
    const directs = { left: 0, right: 0 }
    for (const r of dRows) {
      if (r.position === 'L') directs.left = parseInt(r.cnt)
      if (r.position === 'R') directs.right = parseInt(r.cnt)
    }

    const { rows: lvlRows } = await pool().query<{ level: string; members: string }>(
      `SELECT (cardinality(placement_path) - $2) AS level, COUNT(*) AS members
       FROM members WHERE placement_path @> ARRAY[$1::bigint]
       GROUP BY 1 ORDER BY 1 LIMIT 12`,
      [memberId, myDepth]
    )

    const a = agg[0]
    return {
      totalTeam: parseInt(a?.total ?? '0'),
      leftTeam: parseInt(a?.left_team ?? '0'),
      rightTeam: parseInt(a?.right_team ?? '0'),
      activeMembers: parseInt(a?.active ?? '0'),
      qualifiedMembers: parseInt(a?.qualified ?? '0'),
      directs,
      levelDistribution: lvlRows.map((r) => ({ level: parseInt(r.level), members: parseInt(r.members) })),
    }
  })

  // "Directs" = members you personally sponsored (sponsor tree).
  app.get('/network/directs', auth, async (req) => {
    const memberId = (req.user as Auth).sub
    const { rows } = await pool().query<{
      member_code: string; name: string; position: string | null
      is_active: boolean; is_qualified: boolean; created_at: string
    }>(
      `SELECT member_code, name, position, is_active, is_qualified, created_at
       FROM members WHERE sponsor_id = $1 ORDER BY created_at DESC LIMIT 200`,
      [memberId]
    )
    return {
      items: rows.map((r) => ({
        memberCode: r.member_code, name: r.name, leg: (r.position ?? 'L') as 'L' | 'R',
        isActive: r.is_active, isQualified: r.is_qualified, joinedAt: r.created_at,
      })),
      nextCursor: null,
    }
  })

  // ===== dashboard =====
  app.get('/dashboard', auth, async (req) => {
    const memberId = (req.user as Auth).sub

    const [counterRes, walletRes, deferredRes, totalRes, todayRes, seriesRes, rankRes] = await Promise.all([
      pool().query<{
        left_active: string; right_active: string; pairs_matched: string
        left_qualified: string; right_qualified: string
      }>('SELECT left_active, right_active, pairs_matched, left_qualified, right_qualified FROM member_counters WHERE member_id = $1', [memberId]),
      pool().query<{ balance: string }>(
        `SELECT wb.balance FROM wallet_balances wb JOIN accounts a ON a.id = wb.account_id
         WHERE a.owner_id = $1 AND a.kind = 'wallet'`, [memberId]),
      pool().query<{ balance: string }>(
        `SELECT wb.balance FROM wallet_balances wb JOIN accounts a ON a.id = wb.account_id
         WHERE a.owner_id = $1 AND a.kind = 'deferred_bonus'`, [memberId]),
      pool().query<{ total: string }>(
        `SELECT COALESCE(SUM(bonus_amount),0) AS total FROM pairs WHERE member_id = $1`, [memberId]),
      pool().query<{ total: string }>(
        `SELECT COALESCE(SUM(bonus_amount),0) AS total FROM pairs
         WHERE member_id = $1
           AND to_char(created_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD')
             = to_char(now() AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD')`, [memberId]),
      pool().query<{ d: string; total: string }>(
        `SELECT to_char(created_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS d,
                SUM(bonus_amount) AS total
         FROM pairs WHERE member_id = $1 AND created_at > now() - interval '30 days'
         GROUP BY 1 ORDER BY 1`, [memberId]),
      pool().query<{ max: string | null }>(
        'SELECT MAX(rank_level) AS max FROM rank_achievements WHERE member_id = $1', [memberId]),
    ])

    const c = counterRes.rows[0] ?? {
      left_active: '0', right_active: '0', pairs_matched: '0', left_qualified: '0', right_qualified: '0',
    }
    const leftActive = parseInt(c.left_active)
    const rightActive = parseInt(c.right_active)
    const pairsMatched = parseInt(c.pairs_matched)
    const leftQ = parseInt(c.left_qualified)
    const rightQ = parseInt(c.right_qualified)

    const currentRank = rankRes.rows[0]?.max ? parseInt(rankRes.rows[0].max!) : 0
    const nextLevel = currentRank < 12 ? currentRank + 1 : null
    const progress = nextLevel && nextLevel <= 4
      ? { leftQualified: leftQ, rightQualified: rightQ, requiredEachSide: QUALIFIED_THRESHOLDS[nextLevel] }
      : null

    const { items: recent } = await ledgerItems(memberId, null, 10)

    return {
      totalIncomePaise: Number(toPaise(totalRes.rows[0]?.total ?? '0')),
      pairMatchIncomePaise: Number(toPaise(totalRes.rows[0]?.total ?? '0')),
      walletBalancePaise: Number(toPaise(walletRes.rows[0]?.balance ?? '0')),
      deferredBalancePaise: Number(toPaise(deferredRes.rows[0]?.balance ?? '0')),
      counters: { leftActive, rightActive, leftQualified: leftQ, rightQualified: rightQ, pairsMatched },
      carryForward: {
        side: leftActive > rightActive ? 'L' : 'R',
        excess: Math.max(leftActive, rightActive) - pairsMatched,
      },
      todayPairBonusPaise: Number(toPaise(todayRes.rows[0]?.total ?? '0')),
      rank: {
        current: currentRank,
        currentName: currentRank > 0 ? RANK_NAMES[currentRank] : 'Member',
        next: nextLevel,
        progress,
      },
      incomeSeries: seriesRes.rows.map((r) => ({ date: r.d, pairPaise: Number(toPaise(r.total)) })),
      recentTransactions: recent.map((r) => ({
        type: r.refType === 'pair' ? 'pair_bonus' : r.refType === 'payout' ? 'payout' : r.refType === 'sweep' ? 'sweep' : 'purchase',
        amountPaise: r.amountPaise,
        direction: r.direction,
        at: r.at,
      })),
    }
  })

  // ===== pairs =====
  app.get('/pairs', auth, async (req) => {
    const memberId = (req.user as Auth).sub
    const query = req.query as { cursor?: string; limit?: string }
    const limit = Math.min(100, parseInt(query.limit ?? '20', 10) || 20)
    const cursorClause = query.cursor ? 'AND p.id < $3' : ''
    const params: (string | number)[] = [memberId, limit]
    if (query.cursor) params.push(parseInt(query.cursor))

    const { rows } = await pool().query<{
      id: string; sequence_no: string; bonus_amount: string; created_at: string
      left_code: string; right_code: string
    }>(
      `SELECT p.id, p.sequence_no, p.bonus_amount, p.created_at,
              ml.member_code AS left_code, mr.member_code AS right_code
       FROM pairs p
       JOIN members ml ON ml.id = p.left_member_id
       JOIN members mr ON mr.id = p.right_member_id
       WHERE p.member_id = $1 ${cursorClause}
       ORDER BY p.id DESC LIMIT $2`,
      params
    )
    return {
      items: rows.map((r) => ({
        sequenceNo: parseInt(r.sequence_no),
        leftMemberCode: r.left_code,
        rightMemberCode: r.right_code,
        bonusPaise: Number(toPaise(r.bonus_amount)),
        at: r.created_at,
      })),
      nextCursor: rows.length === limit ? String(rows[rows.length - 1].id) : null,
    }
  })

  // ===== wallet =====
  app.get('/wallet', auth, async (req) => {
    const memberId = (req.user as Auth).sub
    const bal = async (kind: string) => {
      const { rows } = await pool().query<{ balance: string }>(
        `SELECT wb.balance FROM wallet_balances wb JOIN accounts a ON a.id = wb.account_id
         WHERE a.owner_id = $1 AND a.kind = $2`, [memberId, kind]
      )
      return toPaise(rows[0]?.balance ?? '0')
    }

    const { rows: win } = await pool().query<{ id: string; window_start: string; window_end: string }>(
      `SELECT id, window_start, window_end FROM cutoffs WHERE status = 'open' LIMIT 1`
    )
    let earnedPaise = 0n
    let start = new Date().toISOString()
    let end = new Date().toISOString()
    if (win[0]) {
      start = new Date(win[0].window_start).toISOString()
      end = new Date(win[0].window_end).toISOString()
      const { rows: ce } = await pool().query<{ earned: string }>(
        'SELECT earned FROM cutoff_earnings WHERE member_id = $1 AND cutoff_id = $2',
        [memberId, win[0].id]
      )
      earnedPaise = toPaise(ce[0]?.earned ?? '0')
    }

    return {
      balancePaise: Number(await bal('wallet')),
      deferredPaise: Number(await bal('deferred_bonus')),
      currentWindow: {
        start, end,
        earnedPaise: Number(earnedPaise),
        capPaise: CFG.CUTOFF_CAP_PAISE,
      },
    }
  })

  app.get('/wallet/ledger', auth, async (req) => {
    const memberId = (req.user as Auth).sub
    const query = req.query as { cursor?: string; limit?: string }
    const limit = Math.min(100, parseInt(query.limit ?? '20', 10) || 20)
    const { items, nextCursor } = await ledgerItems(memberId, query.cursor ?? null, limit)
    return { items, nextCursor }
  })

  // ===== withdrawals =====
  app.post('/withdrawals', auth, async (req, reply) => {
    const memberId = (req.user as Auth).sub
    const body = z.object({ amountPaise: z.number().int().positive() }).safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: { code: 'BAD_REQUEST', message: 'amountPaise required' } })

    const amountPaise = BigInt(body.data.amountPaise)
    if (amountPaise < BigInt(CFG.MIN_PAYOUT_PAISE)) {
      return reply.status(422).send({ error: { code: 'MIN_AMOUNT', message: `Minimum withdrawal is ₹${CFG.MIN_PAYOUT_PAISE / 100}` } })
    }
    const { rows } = await pool().query<{ balance: string }>(
      `SELECT wb.balance FROM wallet_balances wb JOIN accounts a ON a.id = wb.account_id
       WHERE a.owner_id = $1 AND a.kind = 'wallet'`, [memberId]
    )
    if (!rows[0] || toPaise(rows[0].balance) < amountPaise) {
      return reply.status(422).send({ error: { code: 'INSUFFICIENT_BALANCE', message: 'Insufficient balance' } })
    }
    const { rows: ins } = await pool().query<{ id: string }>(
      'INSERT INTO withdrawals (member_id, amount) VALUES ($1,$2) RETURNING id',
      [memberId, fromPaise(amountPaise)]
    )
    return reply.status(201).send({ id: ins[0].id })
  })

  app.get('/withdrawals', auth, async (req) => {
    const memberId = (req.user as Auth).sub
    const statusMap: Record<string, string> = {
      requested: 'pending', approved: 'processing', paid: 'done', rejected: 'failed',
    }
    const { rows } = await pool().query<{ id: string; amount: string; status: string; requested_at: string }>(
      'SELECT id, amount, status, requested_at FROM withdrawals WHERE member_id = $1 ORDER BY id DESC LIMIT 50',
      [memberId]
    )
    return {
      items: rows.map((r) => ({
        id: r.id,
        amountPaise: Number(toPaise(r.amount)),
        status: statusMap[r.status] ?? 'pending',
        requestedAt: r.requested_at,
      })),
    }
  })

  // ===== payouts =====
  app.get('/payouts', auth, async (req) => {
    const memberId = (req.user as Auth).sub
    const { rows } = await pool().query<{
      scheduled_for: string; gross: string; tds: string; net: string; status: string; bank_ref: string | null
    }>(
      `SELECT pb.scheduled_for, pi.gross, pi.tds, pi.net, pi.status, pi.bank_ref
       FROM payout_items pi JOIN payout_batches pb ON pb.id = pi.batch_id
       WHERE pi.member_id = $1 ORDER BY pi.id DESC LIMIT 50`,
      [memberId]
    )
    return {
      items: rows.map((r) => ({
        date: new Date(r.scheduled_for).toISOString(),
        grossPaise: Number(toPaise(r.gross)),
        tdsPaise: Number(toPaise(r.tds)),
        netPaise: Number(toPaise(r.net)),
        status: r.status,           // pending | sent | settled | failed — matches the frontend union
        bankRef: r.bank_ref,
      })),
    }
  })

  // ===== ranks =====
  app.get('/ranks/progress', auth, async (req) => {
    const memberId = (req.user as Auth).sub
    const [counterRes, achRes, legRes] = await Promise.all([
      pool().query<{ left_qualified: string; right_qualified: string }>(
        'SELECT left_qualified, right_qualified FROM member_counters WHERE member_id = $1', [memberId]),
      pool().query<{ rank_level: string; achieved_at: string; verification_status: string }>(
        'SELECT rank_level, achieved_at, verification_status FROM rank_achievements WHERE member_id = $1', [memberId]),
      pool().query<{ rank_level: string; left_count: string; right_count: string }>(
        'SELECT rank_level, left_count, right_count FROM leg_rank_counters WHERE member_id = $1', [memberId]),
    ])

    const leftQ = parseInt(counterRes.rows[0]?.left_qualified ?? '0')
    const rightQ = parseInt(counterRes.rows[0]?.right_qualified ?? '0')
    const achieved = new Map(achRes.rows.map((r) => [parseInt(r.rank_level), r]))
    const legMap: Record<number, { left: number; right: number }> = {}
    for (const r of legRes.rows) {
      legMap[parseInt(r.rank_level)] = { left: parseInt(r.left_count), right: parseInt(r.right_count) }
    }

    const levels = []
    for (let level = 1; level <= 12; level++) {
      const ach = achieved.get(level)
      const requirement = level <= 4
        ? {
            kind: 'qualified' as const,
            requiredEachSide: QUALIFIED_THRESHOLDS[level],
            leftQualified: leftQ,
            rightQualified: rightQ,
          }
        : {
            kind: 'achiever' as const,
            requiredRank: level - 1,
            leftAchievers: legMap[level - 1]?.left ?? 0,
            rightAchievers: legMap[level - 1]?.right ?? 0,
          }
      levels.push({
        level,
        name: RANK_NAMES[level],
        achieved: !!ach,
        achievedAt: ach ? ach.achieved_at : null,
        verificationStatus: ach ? ach.verification_status : null,
        requirement,
      })
    }
    return { levels }
  })
}
```

---

## Step 3 — Swap the route modules in `server.ts`

Open `backend/src/api/server.ts`.

**3a.** Replace these four import lines:
```typescript
import { orderRoutes } from './orders.js'
import { networkRoutes } from './network.js'
import { walletRoutes } from './wallet.js'
import { reportRoutes } from './reports.js'
```
with this single line:
```typescript
import { frontendRoutes } from './frontend.js'
```

**3b.** Replace these four registration lines:
```typescript
await app.register(orderRoutes)
await app.register(networkRoutes)
await app.register(walletRoutes)
await app.register(reportRoutes)
```
with this single line:
```typescript
await app.register(frontendRoutes)
```

Do NOT delete `orders.ts` (its `confirmOrder` export is still imported by `frontend.ts`, `simulate.ts`, and tests). Do NOT touch the `authRoutes` or `adminRoutes` lines.

---

## Step 4 — Make login return the `member` object

Open `backend/src/api/auth.ts`.

**4a.** Add this import next to the other imports at the top:
```typescript
import { buildMe } from './frontend.js'
```

**4b.** In the `/login` handler, replace:
```typescript
    return { accessToken, refreshToken, memberCode: member.member_code }
```
with:
```typescript
    const me = await buildMe(String(member.id))
    return { accessToken, refreshToken, memberCode: member.member_code, member: me }
```

(The frontend's Login/Register pages read `res.data.member` into the token store; without this they crash on `undefined`.)

Now start the API: `cd backend && npm run dev`. It must print `AVG API listening on port 3000` with no route-collision errors. If Fastify throws "route already declared", you missed part of Step 3.

---

## Step 5 — Frontend: point the always-mock components at the real API

These four files never fetch anything. Make each minimal edit exactly as written.

**5a. `frontend/src/components/layout/Topbar.tsx`**

Replace:
```typescript
import { mockMe } from '../../mocks/data'
```
with:
```typescript
import { useQuery } from '@tanstack/react-query'
import api from '../../lib/api'
import type { Me } from '../../types/api'
```
Replace:
```typescript
  const me = mockMe
```
with:
```typescript
  const { data: me = { name: 'Member', memberCode: '' } as Me } = useQuery<Me>({
    queryKey: ['me'],
    queryFn: () => api.get('/me').then((r) => r.data),
  })
```

**5b. `frontend/src/pages/Profile.tsx`**

Keep the existing imports (it already imports `api` and react-query hooks — add `useQuery` to the react-query import if it is not already there, and add `import type { Me, Dashboard } from '../types/api'`). Then replace:
```typescript
  const me = mockMe
  const dash = mockDashboard
```
with:
```typescript
  const { data: meData } = useQuery<Me>({ queryKey: ['me'], queryFn: () => api.get('/me').then((r) => r.data) })
  const { data: dashData } = useQuery<Dashboard>({ queryKey: ['dashboard'], queryFn: () => api.get('/dashboard').then((r) => r.data) })
  const me = meData ?? mockMe
  const dash = dashData ?? mockDashboard
```
(Leave the `mockMe, mockDashboard` import in place — it is now only a loading fallback.)

**5c. `frontend/src/pages/DirectMembers.tsx`**

Add to imports (it already uses `useQuery` and `api`):
```typescript
import type { NetworkSummary } from '../types/api'
```
Replace:
```typescript
  const s = mockNetworkSummary
```
with:
```typescript
  const { data: summary } = useQuery<NetworkSummary>({
    queryKey: ['network-summary'],
    queryFn: () => api.get('/network/summary').then((r) => r.data),
  })
  const s = summary ?? mockNetworkSummary
```

**5d. `frontend/src/pages/Notifications.tsx`**

Replace:
```typescript
import { mockDashboard, mockRanks } from '../mocks/data'
```
with:
```typescript
import { useQuery } from '@tanstack/react-query'
import api from '../lib/api'
import type { Dashboard, RankLevel } from '../types/api'
```
Immediately inside the `Notifications()` function body (before the `useMemo`), add:
```typescript
  const { data: dash } = useQuery<Dashboard>({ queryKey: ['dashboard'], queryFn: () => api.get('/dashboard').then((r) => r.data) })
  const { data: rankData } = useQuery<{ levels: RankLevel[] }>({ queryKey: ['ranks'], queryFn: () => api.get('/ranks/progress').then((r) => r.data) })
  const txs = dash?.recentTransactions ?? []
  const ranks = rankData?.levels ?? []
```
Then inside the `useMemo`: replace `mockDashboard.recentTransactions` with `txs`, replace `mockRanks` with `ranks`, and change the `useMemo` dependency array from `[]` to `[txs, ranks]`.

**5e. `frontend/src/pages/IncomeReport.tsx`**

Replace:
```typescript
import { mockDashboard, mockLedger } from '../mocks/data'
```
with:
```typescript
import { useQuery } from '@tanstack/react-query'
import api from '../lib/api'
import type { Dashboard, LedgerRes } from '../types/api'
```
Immediately inside the `IncomeReport()` function body (before the first `useMemo`), add:
```typescript
  const { data: dash } = useQuery<Dashboard>({ queryKey: ['dashboard'], queryFn: () => api.get('/dashboard').then((r) => r.data) })
  const { data: ledger } = useQuery<LedgerRes>({ queryKey: ['ledger-report'], queryFn: () => api.get('/wallet/ledger?limit=100').then((r) => r.data) })
```
Then: replace `mockDashboard.incomeSeries` with `(dash?.incomeSeries ?? [])`, change that `useMemo`'s dependency array from `[preset]` to `[preset, dash]`, and in `exportCSV` replace `mockLedger.map` with `(ledger?.items ?? []).map`.

---

## Step 6 — Run and verify, in this exact order

1. Backend stack from Step 0 is up (docker + 6 workers + `npm run dev` on port 3000).
2. `cd frontend && npm run dev` → open http://localhost:5173. In browser DevTools → Network tab, confirm requests go to `localhost:3000` and there is **no** `[MSW]` banner in the console.
3. **Login as root:** phone `9999999999`, password `Root@1234`. You must land on the Dashboard (all zeros is correct for a fresh root).
4. **Register a member:** log out is not implemented — open an incognito window → `/register` → sponsor code `AGV100001`, leg L, any name, a fresh 10-digit phone starting 6–9, password 8+ chars. You must land on the Dashboard.
5. **Buy + activate:** go to Buy Product → choose Starter → the page creates the order and calls `/dev/simulate-payment` → status should reach "confirmed".
6. **Watch the pipeline:** within ~2 seconds the worker terminals print activity (outbox-relay → fanout → counter-pair → qualification). Refresh the **root's** dashboard: `leftActive` should now be 1.
7. **Bulk check:** `cd backend && npm run simulate 30`, wait ~10s, then refresh the root dashboard — counters, pairs, wallet balance (₹1,000 × pairs), Pair Match page, Income Report chart, and Network tree should all show real data.
8. **Withdrawal check:** on a member with wallet balance, Wallet page → withdraw ≥ ₹500 → appears in the list as `pending`.

### If something fails

| Symptom | Cause | Fix |
|---|---|---|
| Requests hit `localhost:4000` / connection refused | `.env` missing or Vite not restarted | Step 1, restart `npm run dev` |
| `[MSW]` in console, everything "works" with fake data | `VITE_USE_MOCKS` still true | Step 1 |
| Login 200 but app crashes reading `member` | Step 4b not applied | Step 4 |
| Fastify: "route already declared" | Old route modules still registered | Step 3 |
| CORS error in browser | You changed `origin: true` in server.ts | Revert; it must reflect origin in dev |
| Dashboard stays at zero after purchase | Workers not running, or no open cutoff | Step 0; re-run `npm run seed` |
| `No open cutoff window` in ledger worker logs | Seed skipped | `npm run seed` |
| 500 on register with an already-used phone | Known bug GAPS G-10 | Use a fresh phone number |

**Done means:** all 8 checks in Step 6 pass. Do not mark this task complete on compile success alone.

---

## Out of scope here (do afterwards, tracked in GAPS.md)

Securing the webhook (G-2), admin role checks (G-3), withdrawal/ledger reconciliation (G-4), removing the remaining `placeholderData` mock fallbacks (G-11), and route guarding (G-13). This document only makes the two halves talk.
