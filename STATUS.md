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

**Test count:** 44 backend tests (7 files) — all pass (see Phase 5 for current count)

### Phase 5 — Qualification-gated pair minting + admin management operations

| Area | Fix | Files |
|---|---|---|
| Phase 0.1: in-batch Set-based dedupe | `seenIds` Set prevents processing duplicate event IDs in same batch before the DB lock | `workers/counterPair.ts` |
| Phase 0.2: `postLedgerTxn` guard on `cutoff_earnings` | `if (posted)` guard prevents double-counting `cutoff_earnings` on XAUTOCLAIM replay | `workers/ledger.ts` |
| Phase 1.1: mint_check synthetic event (D-3) | On `MemberQualified`, fanout emits a `CounterIncrement` with `counter_type='mint_check'` targeting M themselves — flushes backlog pairs accumulated while M was unqualified | `workers/fanout.ts`, `events/types.ts` |
| Phase 1.2: qualification gate (BR-4, BR-6) | `counterPair` checks `is_qualified` after the `FOR UPDATE` lock; `newPairs=0n` if unqualified; `mint_check` is a no-op in the increment loop (reuses existing per-ancestor serialization) | `workers/counterPair.ts` |
| Phase 2: Admin management operations (8 new endpoints) | `GET /admin/members`, `PATCH /admin/members/:id`, `POST /admin/members/:id/kyc`, `POST /admin/members/:id/bank`, `POST /admin/members/:id/adjustment`, `POST /admin/members/:id/reset-password`, `POST /admin/members/:id/role` (root-only), `GET /admin/audit-log` | `api/admin.ts` |
| Phase 2: BR-12 audit log on all admin mutations | All 8 new endpoints + retrofitted ranks/approve, ranks/reject, payouts/trigger — every mutation writes `admin_audit_log` in the same transaction | `api/admin.ts` |
| Phase 2: Double-entry adjustment ledger (BR-11) | Adjustment endpoint uses `postLedgerTxn` with system `adjustment` account as contra; never writes directly to `wallet_balances` | `api/admin.ts` |
| Migration `014_admin_ops.sql` | Adds `'adjustment'` to `accounts.kind` CHECK, inserts system adjustment account, creates `admin_audit_log` with indexes | `db/migrations/014_admin_ops.sql` |
| `LedgerLeg` exported | Interface now exported from `workers/ledger.ts` for use in `api/admin.ts` | `workers/ledger.ts` |
| T-G8-bonus fix | Ancestor qualified before `applyIncrements` call (gate now blocks unqualified ancestors) | `test/integration/pipeline.test.ts` |
| New tests (T-qual-gate, T-backlog-mint) | Unqualified ancestor → 0 pairs; mint_check after qualification flushes backlog pair | `test/integration/pipeline.test.ts` |
| New tests (Phase 2 admin suite, 5 tests) | Credit/debit adjustment balance + audit row; KYC update persisted + audit row; non-admin 403; non-root admin role change 403 | `test/integration/http.test.ts` |
| `scripts/reset.ts` | Adds adjustment account to post-TRUNCATE INSERT | `scripts/reset.ts` |

**Migration to apply:** `npm run migrate` (applies `014_admin_ops.sql`)

**Test count:** 49 backend tests (7 files) — all pass

### Phase 6 — Security hardening + operational correctness

| Area | Fix | Files |
|---|---|---|
| #3 Root credentials from env | `seedRoot.ts` reads `ROOT_SEED_PASSWORD` env var — throws if missing; no hardcoded default | `scripts/seedRoot.ts` |
| #6 NODE_ENV gates inverted | Startup guards fire in `staging`/`production` (not just `production`); test/dev are exempt | `src/config.ts` |
| #6 `/dev/simulate-payment` conditional | Route registered ONLY when `NODE_ENV=development`; absent in staging/production entirely | `src/api/frontend.ts` |
| Medium: timingSafeEqual | Webhook secret comparison uses `crypto.timingSafeEqual` (constant-time; prevents timing attacks) | `src/api/frontend.ts` |
| Medium: `/auth/register` rate limit | 20 req/min/IP (same as login ceiling; argon2 is also a natural throttle) | `src/api/auth.ts` |
| Medium: `/network/tree` 404 instead of 403 | Unauthorised tree access returns 404 — avoids leaking member-code existence | `src/api/frontend.ts` |
| Medium: `closeAndOpenCutoff` snapshot fix | Deferred-balance query uses transaction client `c` not `pool()` — same snapshot as the close UPDATE | `src/workers/cutoff.ts` |
| #4 State-based cutoff cron | `run()` queries `cutoffs WHERE status='open' AND window_end < now()` each tick — self-heals after downtime | `src/workers/cutoff.ts` |
| #4+#9 State-based payout cron (7-day rule) | `run()` queries closed cutoffs where `payout_date <= CURRENT_DATE` and no batch exists — fires next Saturday after cutoff close | `src/workers/payout.ts` |
| #2 Payout idempotency | `buildBatch` split: phase 1 = txn with `pg_advisory_xact_lock` + items + ledger; phase 2 = CSV from DB post-commit; phase 3 = `status='sent'` only after `writeFile`. Cron now skips only batches with `status='sent'` (not just existence) — allows retrying a stuck `'building'` batch after a crash between phases | `src/workers/payout.ts` |
| #10 RFC-4180 CSV quoting | `csvQuote()` wraps comma/newline/quote fields; prefixes `=+-@` with apostrophe (formula injection prevention) | `src/workers/payout.ts` |
| #7 Poison-message handling | After `MAX_DELIVERY_ATTEMPTS=5` XPENDING deliveries, entry is parked in `dead_letters` and XACK'd. **Scope: message-mode consumers only** (fanout, ledger, etc.). Batch-mode consumers (counterPair) re-deliver the full batch on failure — they rely on the deterministic-id idempotency invariant for safety; per-entry parking in batch mode would require cursor tracking (deferred). | `src/lib/streams.ts` |
| Migration `015_dead_letters.sql` | `dead_letters (stream, consumer_group, entry_id, payload, delivery_count)` with unique constraint | `db/migrations/015_dead_letters.sql` |
| New tests: csvQuote (11) + buildBatch idempotency (4) | csvQuote: RFC-4180 + formula injection; buildBatch: first call → status=sent; second call → 1 batch, 1 item, 1 ledger_txn (no double-posting) | `test/unit/payout.test.ts`, `test/integration/pipeline.test.ts` |

**Migration to apply:** `npm run migrate` (applies `015_dead_letters.sql`)

**Test count:** 64 backend tests (8 files) — all pass

**Root credentials:** The seeded password (`Root@1234`) is still in the DB and in test fixtures. **Action required:** rotate the root password in the DB (`UPDATE members SET password_hash=... WHERE parent_id IS NULL`) and update `STATUS.md` + `.env` once a secure password is chosen. The seed script now requires `ROOT_SEED_PASSWORD` for any future fresh seeds.

**NODE_ENV gate note:** The startup guards fire when `NODE_ENV` is anything other than `development` or `test`. Railway auto-sets `NODE_ENV=production` for all deployed services. Staging environments must also set `NODE_ENV=production` (or `staging`) explicitly — the default of `development` would bypass the guards if NODE_ENV is unset.

### Phase 7 — Referral-built binary tree (2-referral cap + referral-only registration)

| Area | Change | Files |
|---|---|---|
| 2-referral cap + direct placement | Registration places the new member **directly under the sponsor**: first referral → L, second → R, third → 409 "Referral limit reached". Sponsor row locked `FOR UPDATE`; spillover walk (`findPlacementSlot`) deleted. `parent_id = sponsor_id` for all new rows (sponsor tree ≡ binary tree going forward). No migration needed — `uq_placement_slot` is the DB-level cap. | `src/services/placement.ts` |
| `preferredLeg` removed from API | `POST /auth/register` no longer accepts a leg; body = sponsorCode, name, phone, email?, password | `src/api/auth.ts`, `frontend/src/types/api.ts` |
| Referral-only registration UI | `/register` requires `?sponsor=CODE`; sponsor code shown read-only; without a link → "You need a referral link to join" empty state; leg selector deleted; backend errors surfaced verbatim | `frontend/src/pages/auth/Register.tsx` |
| Tap-to-refer tree | Vacant slot click copies the **parent member's** referral link (`/register?sponsor=<code>`); every member node has a copy-link button; member card click drills down (server-side, whole network browsable) | `frontend/src/components/tree/BinaryTree.tsx`, `useTreeLayout.ts`, `frontend/src/pages/Network.tsx` |
| simulate BFS rewrite | Sponsors picked breadth-first from members with <2 children — respects the cap, re-runnable | `scripts/simulate.ts` |
| Tests restructured for the cap | Shared `helpers.ts` (`registerAnchor` — fresh 0-child anchor per describe); all `preferredLeg` payloads removed; T-CTE spillover test replaced with **T-CAP** (L, R, 409 + parent/sponsor asserts); new HTTP **CAP** suite incl. concurrent last-slot race → exactly [201, 409] | `test/integration/helpers.ts`, `http.test.ts`, `pipeline.test.ts` |

**Data note:** pre-cap rows may still have `sponsor_id ≠ parent_id` (old spillover placements); a fresh reset (`scripts/reset.ts` + seed) is recommended before deploying this.

### Phase 8 — Email-mandatory registration + email login

| Area | Change | Files |
|---|---|---|
| Login by email | `POST /auth/login` takes `{email, password}`; `findMemberByPhone` → `findMemberByEmail`; emails normalized to lowercase on write and lookup | `src/api/auth.ts`, `src/services/placement.ts` |
| Email mandatory | `RegisterBody.email` required; `RegisterInput.email: string`; migration backfills legacy NULLs with `<member_code>@placeholder.local` then `SET NOT NULL`. Phone remains required (contact/display only) | `db/migrations/016_email_required.sql` |
| Root login | `root@avg.com / Root@1234` (email was already seeded); reset/seed console messages updated | `scripts/reset.ts` |
| Frontend | Login page uses an email field; Register email mandatory (label no longer "optional"); auto-login after register posts email; `LoginReq`/`RegisterReq` updated; en+ta strings updated | `pages/auth/Login.tsx`, `Register.tsx`, `types/api.ts`, `i18n/*` |
| Tests | All registrations carry unique emails; all logins by email; new duplicate-email 409 test | `test/integration/helpers.ts`, `http.test.ts`, `pipeline.test.ts` |

**Migration to apply:** `npm run migrate` (applies `016_email_required.sql`)

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
- **Two trees:** `sponsor_id` = who referred you (3-gen qualification gate only); `parent_id + position` = binary placement tree (all counters, pairs, ranks). Confusing them gives wrong numbers silently. Since the 2-referral cap, new registrations always have `parent_id = sponsor_id` (direct placement, L then R).
