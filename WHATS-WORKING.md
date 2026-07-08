# WHATS-WORKING.md — Real system state as of 2026-07-08

Quick orientation for any engineer or model picking up this codebase.
→ Architecture deep-dive: **PROJECT.md**
→ Every known bug with file paths and fix scopes: **GAPS.md**
→ Deployment runbook and connection strings: **STATUS.md**
→ Conventions and rules: **CLAUDE.md**

---

## How it works (architecture in brief)

```
Browser (Vite :5173)
  └─ Fastify API (:3000)  ← JWT auth, all endpoints in api/frontend.ts + auth.ts + admin.ts
       ├─ Railway Postgres  ← members, wallets, pairs, ledger, placements, etc. (raw pg, no ORM)
       └─ Railway Redis 7   ← event transport only (Redis Streams); no data lives here
            └─ avg-workers (one Node process, workers/all.ts)
                 ├─ outboxRelay  → polls events_outbox → XADD to stream
                 ├─ fanout       → lifecycle events → CounterIncrements up the placement tree
                 ├─ counterPair  → increments → pair matching → credits
                 ├─ qualification → activation → 3-gen gate → MemberQualified
                 ├─ ledger       → PairMatched + DeferredSweep → double-entry ledger txns
                 ├─ rank         → member_counters → rank evaluation
                 ├─ cutoff       → weekly window open/close (timer)
                 ├─ payout       → Saturday wallet sweep to bank (timer)
                 └─ reconciler   → nightly counter/wallet drift check (timer)
```

**Event flow:** API/worker calls `writeOutbox(c, event)` *inside the same DB transaction* →
`outboxRelay` polls and `XADD`s rows to Redis Streams → consumer-group workers read via
`XREADGROUP`, call their handler, `XACK` after the handler's DB txn commits (at-least-once).
Workers dedup via `processed_events(consumer_group, event_id)` — safe because increment IDs
are deterministic `uuidv5(sourceEventId:ancestorId)`.

**Two trees (critical distinction):**
- `sponsor_id` — who referred you. Used **only** for the 3-generation qualification gate.
- `parent_id` + `position` (L/R) — binary placement tree. Used for **all** counters, pairs, ranks.
Using the wrong tree gives wrong numbers, not errors.

**Money conventions:**
- Backend logic: integer `bigint` **paise** (`lib/money.ts`: `toPaise`, `fromPaise`, `pct` floor, `pctRoundUp` half-up)
- DB columns: `NUMERIC(14,2)` rupees
- API JSON: integer paise, field names end in `…Paise`
- Never do arithmetic on `Number` rupees.

---

## What's working ✅

### Infrastructure & transport
- **Redis Streams transport** live (`backend/src/lib/streams.ts`): `publishToStream` (XADD),
  `startConsumer` (XREADGROUP + XAUTOCLAIM crash recovery + XACK).
- **Kafka fully removed** — `lib/kafka.ts` deleted, `kafkajs` uninstalled, 0 Kafka refs in codebase.
- **Railway Postgres** connected and migrated: 9 migrations applied, root member seeded
  (`9999999999` / `Root@1234`), open cutoff window exists.
- **Railway Redis** connected: PING/SET/GET verified.
- **No Docker** required for local dev — Railway hosts both services; or run Redis 7 natively.

### Backend
- **Build clean** — `tsc` exits 0 with no errors.
- **14 tests pass** — `npm test` (unit: `test/unit/money.test.ts`, integration: `test/integration/pipeline.test.ts`).
- **9 workers consolidated** — `workers/all.ts` launches all nine via `Promise.all()`; individual
  `worker:*` scripts still work for single-worker debug.
- **Live API surface** (all in `api/frontend.ts`, `api/auth.ts`, `api/admin.ts`):

| Method | Path | Auth | What it does |
|--------|------|------|--------------|
| GET | /health | no | Liveness check |
| POST | /auth/register | no | Register + auto-place member |
| POST | /auth/login | no | Returns access + refresh tokens + member |
| POST | /auth/refresh | no | Rotate tokens |
| GET | /auth/me | JWT | Current member profile |
| GET | /me | JWT | Same — used by frontend |
| PUT | /me/kyc | JWT | Upload KYC details |
| PUT | /me/bank | JWT | Save bank account |
| GET | /products | no | Product catalogue |
| POST | /orders | JWT | Create order, returns `paymentUrl` + `orderId` |
| GET | /orders/:orderId | JWT | Order details |
| POST | /dev/simulate-payment | JWT | DEV ONLY: auto-confirm order |
| POST | /webhooks/payment | no | Payment gateway callback (⚠ see G-2 below) |
| GET | /network/tree | JWT | Binary placement tree (BFS) |
| GET | /network/summary | JWT | Left/right counts, sponsor depth |
| GET | /network/directs | JWT | Direct referral list |
| GET | /dashboard | JWT | Stats, wallet, income series, recent txns |
| GET | /pairs | JWT | Matched pair history (cursor pagination) |
| GET | /wallet | JWT | Balance + deferred summary |
| GET | /wallet/ledger | JWT | Double-entry ledger entries (cursor pagination) |
| POST | /withdrawals | JWT | Request withdrawal |
| GET | /withdrawals | JWT | Withdrawal history |
| GET | /payouts | JWT | Payout history |
| GET | /ranks/progress | JWT | Rank ladder + achievement status |
| GET | /admin/ranks | JWT | Pending rank approvals (⚠ no role check — see G-3) |
| POST | /admin/ranks/:id/approve | JWT | Approve rank reward (⚠ see G-3) |
| POST | /admin/ranks/:id/reject | JWT | Reject rank reward (⚠ see G-3) |
| GET | /admin/withdrawals | JWT | Pending withdrawals (⚠ see G-3) |
| POST | /admin/withdrawals/:id/approve | JWT | Approve withdrawal (⚠ see G-3) |
| POST | /admin/withdrawals/:id/reject | JWT | Reject withdrawal (⚠ see G-3) |

### Frontend
- **Build clean** — `tsc -b && vite build` exits 0 (2585 modules transformed).
- **MSW mocks fully deleted** — `src/mocks/` removed, `msw` uninstalled, cached service worker
  auto-unregisters on next browser load. Pages render real empty/skeleton states when backend
  is unreachable.
- **15 pages all call real API** — no `placeholderData` mock fallbacks, no `|| mockX` chains.
- **RequireAuth wired** — `App.tsx` wraps `AppShell` in `<RequireAuth>`, which checks token and
  redirects to `/login` when unauthenticated.
- **JWT auth flow** — `lib/api.ts` axios instance attaches `Authorization: Bearer <token>`,
  auto-retries with refreshed token on 401.

| Page | Endpoints called |
|------|-----------------|
| Dashboard | GET /me, GET /dashboard, GET /network/tree |
| Wallet | GET /wallet, GET /withdrawals, GET /wallet/ledger, POST /withdrawals |
| Network | GET /network/summary, GET /network/directs, GET /network/tree |
| PairMatch | GET /dashboard, GET /pairs (cursor) |
| DirectMembers | GET /network/directs, GET /network/summary |
| IncomeReport | GET /dashboard, GET /wallet/ledger |
| RankRewards | GET /ranks/progress, GET /dashboard |
| PayoutHistory | GET /payouts |
| Notifications | GET /dashboard, GET /ranks/progress |
| Profile | GET /me, GET /dashboard, PUT /me/kyc, PUT /me/bank |
| BuyProduct | GET /products, POST /orders, POST /dev/simulate-payment |
| Settings | (navigates to /login — no data fetch) |
| Support | (static — no data fetch) |
| Login | POST /auth/login |
| Register | POST /auth/register, POST /auth/login |

---

## What's NOT working / open risks ❌

### S1 — Money loss or security breach possible today

**G-2 — Payment webhook unauthenticated (anyone can mint free activations)**
`POST /orders` returns `paymentIntent` (the idempotency key) to the client. Any logged-in member
can POST that key back to `POST /webhooks/payment` to auto-confirm their own order for free,
triggering pair bonuses up the entire upline. No gateway signature check exists.
Fix: add `WEBHOOK_SECRET`; reject unless `x-webhook-secret` matches; stop returning idempotency key from `/orders`.
→ `backend/src/api/frontend.ts`

**G-3 — Admin endpoints have no role check (any member can approve their own withdrawal)**
`/admin/*` routes only check `app.authenticate` (valid JWT). Any member can hit them.
Fix: add `role` column to `members`, include in JWT, add `app.requireAdmin` preHandler.
→ `backend/src/api/admin.ts`

**G-4 — Withdrawals disconnected from ledger; two contradictory payout paths**
`POST /withdrawals` does not hold funds — same balance can be requested five times. Admin approval
posts no ledger txn. Meanwhile the payout worker independently sweeps the *entire wallet* every
Saturday. Two payment models coexist; neither is correct end-to-end.
Fix: pick one model (automatic weekly sweep is the built pipeline); wire approval to a ledger txn
or delete the manual withdrawal flow.
→ `backend/src/api/frontend.ts` (POST /withdrawals), `backend/src/api/admin.ts`, `backend/src/workers/payout.ts`

**G-5 — First right-leg rank achiever silently lost (ranks 5–12 gate broken)**
Right-side branch of the rank-achiever counter upsert inserts `right_count = 0` on first insert
(should be 1). Every member's first right-leg rank-N achiever is dropped; they need a second one
before the next rank can open.
Fix: one-line change + backfill.
→ `backend/src/workers/counterPair.ts`

### S2 — Wrong business results or blocked launch

**G-6 — Cutoff window math drifts one day earlier every week**
`nextWindowStart` pins the hour to 18:00 on the day after `windowEnd`, which is Saturday — not
Sunday. Each window starts a day earlier than intended.
→ `backend/src/workers/cutoff.ts`

**G-7 — Failed payments marked `paid`**
Webhook `status === 'failed'` branch sets order status to `'paid'` (literal bug).
→ `backend/src/api/frontend.ts` (webhook handler)

**G-8 — Config values duplicated in SQL disagree with CFG**
`cutoff_earnings` CHECK hard-codes ₹1L cap; `pairs` hard-codes ₹1,000 bonus. Change env vars
and DB constraints fire against the new values, or reports show wrong figures.
→ `backend/db/migrations/005_pairs.sql`, `006_cutoffs.sql`, `backend/src/workers/counterPair.ts`

**G-9 — Auth hardening absent**
Default JWT secret (`dev-secret-change-in-prod`) — server boots in production without a custom secret.
No rate limiting on `/auth/login`. Refresh tokens are 30-day stateless (no revocation).
→ `backend/src/config.ts`, `backend/src/api/auth.ts`

**G-10 — Duplicate phone registration returns 500 not 409**
Unique constraint violation on `phone` is not caught, returns raw Postgres error.
→ `backend/src/services/placement.ts`

**G-12 — Any member can read any other member's subtree**
`GET /network/tree?root=<code>` does not verify the root is within the caller's downline.
Member codes are sequential — trivial to enumerate the whole org.
→ `backend/src/api/frontend.ts` (network/tree handler)

### S3 — Will bite under load or maintenance

**G-14 — Registration does slow work inside the transaction**
`argon2.hash` (~100–300ms) runs inside the DB txn; `findPlacementSlot` does one SELECT per tree
level (unbounded walk). Under burst load this serializes all registrations.

**G-15 — Test coverage misses every path where money can go wrong**
No HTTP-layer tests (auth, webhook, admin), no concurrency test, no cutoff-boundary test, no
cap-split test. Frontend has zero tests. See GAPS.md G-15 for the prioritized fix list.

**G-16 — Event pipeline delivery caveats undocumented**
`fanout` publishes then records `processed_events` in a separate transaction — crash window exists
but is safe only because increment IDs are deterministic. This invariant is not written down.
See GAPS.md G-16.

**G-17 — `evaluateQualification` may report wrong qualifying child in the event payload**
The audit `via_child_id`/`via_grandchild_id` fields can point to the wrong child (LIMIT 1, not
correlated). The qualification flag itself is correct.
→ `backend/src/services/qualification.ts`

### Minor / known
- `frontend/src/lib/api.ts` fallback port is `4000` (stale); only matters if `VITE_API_URL` is
  unset in the env file. Set `VITE_API_URL=http://localhost:3000` and this is moot.
- CORS is `origin: true` — must be an allowlist before production.
- `cron` workers use `setInterval` minute-matching — a restart at the wrong second skips a week;
  switch to a persisted last-run check (GAPS.md G-20).
- No CI, no backend lint (GAPS.md G-21).

---

## How to run it

Prereqs: Postgres 16 + Redis 7. Both are on Railway (credentials in `backend/.env` — never commit).

```bash
# 1. Backend — first time setup
cd backend
npm install
npm run migrate          # apply all db/migrations/*.sql in order
npm run seed             # create root member (phone 9999999999 / Root@1234) + open cutoff window

# 2. Backend — dev (two terminals)
npm run dev              # Fastify API on :3000 (tsx watch, auto-restarts)
npm run dev:workers      # all 9 workers in one process (tsx watch)

# ⚠️  CRITICAL: run exactly ONE avg-workers process.
# Two processes in the same consumer group interleave counterPair increments → corrupted pair counts.
# Never run `npm run dev:workers` alongside `npm run worker:counter` for the same group.

# 3. Frontend
cd frontend
npm install
npm run dev              # Vite on :5173

# Optional: generate 50 test members under root
cd backend && npm run simulate 50

# Production build
cd backend && npm run build && npm run start:api
cd backend && npm run start:workers          # one process only
cd frontend && npm run build                 # static output in dist/
```

**Per-worker debug** (only when the combined `dev:workers` isn't running):
```bash
npm run worker:outbox      # outbox relay only
npm run worker:fanout      # fanout only
npm run worker:counter     # counterPair only
# etc. (one process per group)
```
