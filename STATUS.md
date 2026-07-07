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
| 6 Kafka topics created | ✅ Done |
| Root member seeded (`9999999999` / `Root@1234`) | ✅ Done |
| Mock-data flicker removed across all 9 data pages | ✅ Done |
| `STATUS.md` runbook (this file) | ✅ Done |

### Phase 2 — Known open gaps (not yet fixed)

See **GAPS.md** for details on each. High-impact ones:

- **G-2** — Webhook payment callback has no HMAC signature verification (security)
- **G-3** — Admin role check not enforced on admin routes
- **G-4** — Withdrawal request not connected to ledger worker (withdrawal balance doesn't drop until manual)
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
                                           │  Railway Postgres    │
                                           │  (remote, Railway)  │
                                           └─────────────────────┘
                                                      │
                                           ┌──────────▼──────────┐
                                           │  Redpanda :19092    │ ◀── Docker local
                                           │  Redis :6379        │ ◀── Docker local
                                           └──────────┬──────────┘
                                                      │
                                    ┌─────────────────▼─────────────────┐
                                    │  6 Workers (each a separate proc) │
                                    │  outbox · fanout · counter         │
                                    │  qualification · ledger · rank     │
                                    └────────────────────────────────────┘
```

**Key config:**
- **Database:** Railway Postgres — URL is in `backend/.env` (gitignored, never commit it)
- **Kafka:** `KAFKA_BROKERS=localhost:19092` — Redpanda's **external** listener (not `:9092` which is internal)
- **Redis:** `redis://localhost:6379`
- **API port:** `3000`  
- **Frontend:** `VITE_API_URL=http://localhost:3000`, `VITE_USE_MOCKS=false`

---

## Start from scratch

### 1. Prerequisites
- Node 20+, Docker Desktop running
- `backend/.env` must exist (copy from a teammate — it holds the Railway DB URL and JWT secret)

### 2. Start infrastructure
```bash
cd backend
docker compose up -d          # Redpanda (19092) + Redis (6379) — Postgres is remote, skip
```

### 3. Migrate + seed
```bash
npm install
npm run migrate               # apply all db/migrations/*.sql to Railway Postgres
npm run topics                # create Kafka topics (idempotent)
npm run seed                  # create root member + open cutoff window
```

### 4. Start API + workers (each in its own terminal)
```bash
npm run dev                   # API on :3000

npm run worker:outbox
npm run worker:fanout
npm run worker:counter
npm run worker:qualification
npm run worker:ledger
npm run worker:rank
```

> Optional in dev: `worker:cutoff`, `worker:payout`, `worker:reconciler`

### 5. Start frontend
```bash
cd ../frontend
npm install
npm run dev                   # Vite on http://localhost:5173
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
- **Fake/hard-coded data** = should no longer appear anywhere; if you see it, check for any remaining `placeholderData` or `?? mock` in the page component

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

**2. Verify each endpoint returns 200 (not 500)**
```bash
# Replace $TOKEN with the value above
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/me | jq .
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/dashboard | jq .totalIncomePaise
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/network/summary | jq .totalTeam
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/network/directs | jq .items
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/wallet | jq .balancePaise
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/wallet/ledger | jq .items
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/withdrawals | jq .items
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/pairs | jq .items
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/payouts | jq .items
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/products | jq .
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/ranks/progress | jq .levels[0]
```

A `500` or network error here means the backend has an issue — the UI will show `—` forever for those fields.

**3. Browser smoke-test — load all 9 pages**

Open http://localhost:5173, login, then visit each route. Expected for a fresh root account:

| Page | What you should see |
|---|---|
| Dashboard | `₹0` income, `0` pairs, `0` counters, "Welcome back, [real name]", empty recent transactions |
| Network | `0` team members across all stats, "Loading tree…" or empty tree |
| Wallet | `₹0` balances, empty ledger table, empty withdrawals |
| Pair Match | `0` pairs, empty pairs table |
| Income Report | `₹0` chart, empty ledger |
| Rank Rewards | Rank ladder loaded (12 levels), L1 "In Progress" |
| Payout History | Empty payouts table, `₹0` summary cards |
| Buy Product | 3 product cards (from catalog) |
| Profile | Real name / member code from DB |

**No fake names, no invented numbers, no flash of placeholder content.**

**4. Generate real data**
```bash
cd backend
npm run simulate 30   # registers + activates 30 fake members under root
```

Then refresh the browser — you should see real counts replace the zeros on Dashboard, Network, Pair Match, and Wallet.

**5. Full activation flow (manual)**
1. Register a new member via `/register?sponsor=[rootMemberCode]`
2. Log in as that member → go to "Buy Product"
3. Select a plan → place order → click "Simulate Payment"
4. Switch terminal and watch the workers process the events
5. Return to Dashboard → counters should increment within a few seconds

---

## Money / data conventions (quick ref)

- All amounts in backend = **integer bigint paise** (1 rupee = 100 paise)
- API JSON field names end in `Paise` (e.g. `balancePaise`, `amountPaise`)
- Frontend displays via `formatINR(paise)` — divides by 100 internally
- DB stores NUMERIC(14,2) rupees; the `lib/money.ts` helpers handle conversion
- **Two trees:** `sponsor_id` = who referred you (3-gen qualification gate only); `parent_id + position` = binary placement tree (all counters, pairs, ranks). Confusing them gives wrong numbers silently.
