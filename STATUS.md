# Project Status & Runbook

## What's finished

### Phase 1 — Frontend ↔ Backend integration (complete)

| Area | Status |
|---|---|
| Backend compatibility routes (`/me`, `/dashboard`, `/network/summary`, `/network/directs`, `/network/tree`, `/wallet`, `/wallet/ledger`, `/withdrawals`, `/pairs`, `/payouts`, `/products`, `/ranks/progress`) | ✅ Done |
| Login returns full `member` object (name, code, rank, etc.) | ✅ Done |
| JWT access + refresh token flow in `frontend/src/lib/api.ts` | ✅ Done |
| `RequireAuth` route guard — unauthenticated → `/login` | ✅ Done |
| Remote Railway Postgres connected | ✅ Done |
| 9 DB migrations applied | ✅ Done |
| Root member seeded (`9999999999` / `Root@1234`) | ✅ Done |
| Mock-data flicker removed across all 9 data pages | ✅ Done |

### Phase 2 — Event transport migration (complete)

| Area | Status |
|---|---|
| `src/lib/streams.ts` — Redis Streams transport (`publishToStream`, `startConsumer`, `XAUTOCLAIM` recovery) | ✅ Done |
| `workers/all.ts` — all nine worker loops in one `avg-workers` process | ✅ Done |
| `outboxRelay`, `fanout`, `counterPair`, `qualification`, `ledger`, `rank` — Kafka replaced with Redis Streams | ✅ Done |
| `cutoff`, `payout`, `reconciler` — timer workers; no transport change needed | ✅ Done |
| `kafkajs` dependency removed | ✅ Done |
| `docker-compose.yml` deleted — local dev uses native Postgres 16 + Redis 7 | ✅ Done |
| `scripts/createTopics.ts` deleted — stream groups bootstrap themselves at startup via `XGROUP CREATE … MKSTREAM` | ✅ Done |
| `CFG.KAFKA_BROKERS` removed from `config.ts` | ✅ Done |
| `npm run start:api` / `npm run start:workers` scripts added | ✅ Done |
| `npm run build` clean, all 14 tests passing | ✅ Done |

### Open gaps (see GAPS.md)

- **G-2** — Webhook payment callback has no HMAC signature verification (security)
- **G-3** — Admin role check not enforced on admin routes
- **G-4** — Withdrawal request not connected to ledger worker
- **G-7** — Failed payments get marked `paid` in the orders table

---

## Runtime architecture (as running now)

```
┌─────────────────────┐     HTTP :3000     ┌─────────────────────┐
│  Vite :5173         │ ─────────────────▶ │  Fastify API        │
│  (frontend)         │                    │  backend/src/api/   │
└─────────────────────┘                    └──────────┬──────────┘
                                                      │ pg
                                           ┌──────────▼──────────┐
                                           │  Postgres 16        │
                                           │  (Railway remote)   │
                                           └─────────────────────┘
                                                      │
                                           ┌──────────▼──────────┐
                                           │  Redis 7 (local)    │
                                           │  Streams transport  │
                                           └──────────┬──────────┘
                                                      │
                              ┌───────────────────────▼───────────────────────┐
                              │  avg-workers (ONE process, workers/all.ts)    │
                              │  outboxRelay · fanout · counterPair            │
                              │  qualification · ledger · rank                 │
                              │  cutoff · payout · reconciler                  │
                              └────────────────────────────────────────────────┘
```

**Key config (`backend/.env`):**
- **Database:** `DATABASE_URL` — Railway Postgres URL (gitignored, never commit)
- **Redis:** `REDIS_URL=redis://localhost:6379`
- **API port:** `PORT=3000`
- **Frontend:** `VITE_API_URL=http://localhost:3000`, `VITE_USE_MOCKS=false`
- **JWT:** `JWT_SECRET` — must be set; dev default is insecure

**Critical constraint:** Run exactly **one** `avg-workers` process per environment.
Redis Streams consumer groups distribute entries across consumers; multiple instances would
interleave `counterPair` increments and break per-ancestor ordering. Do not scale
horizontally until per-key sub-streams are added.

---

## Start from scratch

### Prerequisites
- Node 20+
- **Postgres 16** and **Redis 7** running locally (native install or any method — no Docker required)
- `backend/.env` must exist (copy from a teammate — holds `DATABASE_URL` and `JWT_SECRET`)

### Start infra

```bash
# Postgres 16 and Redis 7 — start however you have them installed, e.g.:
redis-server &               # if installed via Homebrew
# Postgres should already be running
```

### Migrate + seed

```bash
cd backend
npm install
npm run migrate              # apply all db/migrations/*.sql to Postgres
npm run seed                 # create root member + open cutoff window
```

### Start API + workers

```bash
# Terminal A — API server (hot-reload in dev)
npm run dev

# Terminal B — all nine worker loops in one process
npm run dev:workers
```

Or with compiled output:
```bash
npm run build
npm run start:api     # Terminal A
npm run start:workers # Terminal B
```

### Individual worker debugging (one loop at a time)
```bash
npm run worker:outbox        # outbox relay
npm run worker:fanout        # lifecycle → counter increments
npm run worker:counter       # counter/pair matching
npm run worker:qualification # 3-gen qualification gate
npm run worker:ledger        # pair bonus + deferred sweep
npm run worker:rank          # rank ladder evaluation
npm run worker:cutoff        # weekly window scheduler (also needed for an open cutoff)
npm run worker:payout        # Saturday payout batcher (optional in dev)
npm run worker:reconciler    # nightly drift check (optional in dev)
```

> **Warning:** never run `npm run start:workers` simultaneously with any `worker:counter`,
> `worker:fanout`, `worker:ledger`, or `worker:rank` command — they share Redis Stream
> consumer groups, and two consumers in the same group interleave entries.

### Start frontend

```bash
cd ../frontend
npm install
npm run dev                  # Vite on http://localhost:5173
```

---

## How to test

### Login credentials
| Field | Value |
|---|---|
| Phone | `9999999999` |
| Password | `Root@1234` |

### Diagnostic key
- **`—`** (em dash) in any field = endpoint not yet wired or returned an error — check Network tab / backend logs
- **`0` / `₹0`** = endpoint wired, server responded, genuine zero (fresh account)
- **Fake/hard-coded data** = should no longer appear; if you see it, check for `placeholderData` in the page component

### End-to-end checklist

**1. Auth round-trip**
```bash
TOKEN=$(curl -s -XPOST http://localhost:3000/auth/login \
  -H 'content-type: application/json' \
  -d '{"phone":"9999999999","password":"Root@1234"}' \
  | jq -r .accessToken)
echo $TOKEN
```
Expected: a JWT string.

**2. Verify each endpoint returns 200**
```bash
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/me | jq .
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/dashboard | jq .totalIncomePaise
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/network/summary | jq .totalTeam
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/wallet | jq .balancePaise
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/wallet/ledger | jq .items
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/pairs | jq .items
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/ranks/progress | jq .levels[0]
```

**3. Generate real data and verify the pipeline**
```bash
cd backend
npm run simulate 30   # registers + activates 30 fake members under root
```

Then in another terminal:
```bash
# Verify counters moved through Redis Streams
redis-cli XINFO GROUPS avg.counter.increments
# pending should be draining to 0

# Verify DB side
psql $DATABASE_URL -c "SELECT left_active, right_active, pairs_matched FROM member_counters LIMIT 5;"
```

Then refresh the browser — real counts should replace zeros on Dashboard, Network, Pair Match, and Wallet.

---

## Money / data conventions (quick ref)

- All amounts in backend = **integer bigint paise** (1 rupee = 100 paise)
- API JSON field names end in `Paise` (e.g. `balancePaise`, `amountPaise`)
- Frontend displays via `formatINR(paise)` — divides by 100 internally
- DB stores NUMERIC(14,2) rupees; `lib/money.ts` helpers handle conversion
- **Two trees:** `sponsor_id` = who referred you (3-gen qualification gate only); `parent_id + position` = binary placement tree (all counters, pairs, ranks). Confusing them gives wrong numbers silently.
