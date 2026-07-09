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

### Phase 3 — Gap fixes (PLAN.md Phase 7 step ③) — complete

| Gap | Fix | Files |
|---|---|---|
| G-2 Webhook unauth | `WEBHOOK_SECRET` + `x-webhook-secret` header check | `config.ts`, `frontend.ts`, `011_orders_status.sql` |
| G-3 Admin no role | `010_roles.sql` + `requireAdmin` decorator (DB lookup) + `role` in `/me` | `server.ts`, `admin.ts`, `frontend.ts`, `auth.ts`, `fastify.d.ts` |
| G-4 Dual payout models | Removed withdrawal request feature; auto-payout is sole model; `POST /admin/payouts/trigger` added | `admin.ts`, `frontend.ts`, `Wallet.tsx`, `Settings.tsx` |
| G-5 Right-leg rank count=0 | `VALUES ($1,$2,1)` one-liner | `counterPair.ts` |
| G-6 Window drift | `nextWindowStart` drops hour override; `windowEnd = start+7d−1s`; Saturday-anchor seed | `cutoff.ts` |
| G-7 Failed → paid | `status='failed'` on failed webhook branch | `frontend.ts`, `011_orders_status.sql` |

**Migrations to apply:** `npm run migrate` (applies `010_roles.sql` and `011_orders_status.sql`)

### Phase 4 — Remaining gap fixes + hardening (PLAN.md Phase 7 step ③ cont.)

| Gap | Fix | Files |
|---|---|---|
| Admin never promoted | `012_root_admin.sql` promotes root to admin; seed script now inserts `role='admin'` | `012_root_admin.sql`, `scripts/seedRoot.ts` |
| G-8 Config duplication | `counterPair.ts` now uses `CFG.PAIR_BONUS_PAISE` / `fromPaise()`; types widened; config constants test added | `counterPair.ts`, `events/types.ts`, `test/unit/config.test.ts` |
| G-9 Auth hardening | (1) startup throws in prod on insecure defaults; (2) login rate-limited 10/min/IP; (3) `refresh_tokens` table + jti rotation + `POST /auth/logout`; frontend `logout()` calls server | `config.ts`, `auth.ts`, `server.ts`, `013_refresh_tokens.sql`, `frontend/src/lib/auth.ts`, `Sidebar.tsx`, `Settings.tsx` |
| G-10 Dup registration 500 | catch block maps `members_phone_key`/`members_email_key` → 409 | `services/placement.ts` |
| G-12 Tree privacy | `/network/tree` auth guard: `placement_path @> ARRAY[$caller]` else 403 | `api/frontend.ts` |
| G-14 Registration perf | `argon2.hash` hoisted before `withTxn`; `findPlacementSlot` replaced with recursive CTE | `services/placement.ts` |
| G-15 Tests | Cap-boundary math, config guard, HTTP-layer (dup-phone 409, token rotation, logout, tree 403, **G-2/G-7 webhook gate + failed status**), pipeline (**T-CTE** 2-level walk, **T-G8-bonus** `applyIncrements` DB round-trip → `pairs.bonus_amount` + outbox `amount_paise` both from CFG) | `test/unit/ledger.test.ts`, `test/unit/config.test.ts`, `test/integration/http.test.ts`, `test/integration/pipeline.test.ts` |
| G-21 CI + lint | Biome added to backend (`npm run lint`); `.github/workflows/ci.yml` gates `main` | `biome.json`, `package.json`, `.github/workflows/ci.yml` |
| G-18 Dead code | `App.css`, `react.svg`, `vite.svg`, `hero.png` deleted; root `.gitignore` added; tracked `.vite/` + `.DS_Store` removed from index | `.gitignore`, `frontend/src/` |

**Migrations to apply:** `npm run migrate` (applies `012_root_admin.sql` and `013_refresh_tokens.sql`)

**Test count:** 40 backend tests (7 files) — all pass

### Open gaps (see GAPS.md)

- **G-11** — Cosmetic hardcodes (Topbar unreadCount, Profile "mobile verified", no-op save buttons) — not real-money bugs; cleanup deferred
- **G-13** — Client-side route protection exists (RequireAuth is wired ✅); verify no pages bypass it
- **G-5 backfill** — If production data exists, right-leg rank counts need a one-time backfill script
- **Concurrency test** — No automated test for simultaneous `applyIncrements` to the same ancestor (correctness is proven by the deterministic-id invariant, but no test exists)

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
