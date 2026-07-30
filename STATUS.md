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
| `workers/all.ts` — all eight worker loops in one `avg-workers` process | ✅ Done |
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

### Phase 9 — Income rework: 2-Direct Pair Matching (2026-07-14)

The L/R counter-matched income model (`newPairs = min(L,R) − pairs_matched`, qualification-gated minting, `PairMatched` → `creditPairBonus`) was **replaced** per the confirmed business plan:

| Area | Change | Files |
|---|---|---|
| Pair definition | A pair completes at member P when **both of P's direct referrals are active** (≤1 own pair per member — `uq_pairs_one_per_member`); leg balance is irrelevant to income | `workers/pairComplete.ts` (new, group `avg-pair-complete` on lifecycle), `db/migrations/020_pair_accruals.sql` |
| Beneficiaries | ₹1000 per completed pair to P **and every placement ancestor** — one `pair_accruals` row each, fanned out as `PairBonusAccrued` (deterministic uuidv5, direct-published to the ledger stream) | `workers/fanout.ts` (`fanOutPairBonus`) |
| Qualification gate | ALL accruals stay `pending` until the earner qualifies (3-gen gate, tightened July 2026: both directs active + ≥1 active grandchild; `scripts/revertQualification.ts` claws back releases made under the old one-child rule); `evaluateQualification` also emits `PendingBonusReleaseRequested` → retroactive release; already-qualified earners are paid immediately on accrual | `services/qualification.ts`, `workers/ledger.ts` (`accruePairBonus`, `releasePendingBonuses`) |
| Ledger | `creditBonusWithCap` extracted from `creditPairBonus` (deleted); release key `pairbonus:{pair_id}:{beneficiary_id}` shared by both paths; cap/deferred/sweep unchanged | `workers/ledger.ts` |
| Removed | `PairMatched`, `mint_check` (D-3 flush), counterPair minting; `member_counters.pairs_matched` frozen at 0 (drop in a later release); `avg.pair.matched` stream unused | `workers/counterPair.ts`, `workers/fanout.ts`, `events/types.ts` |
| Reconciler | pairs_matched drift check → released-accrual-has-ledger-txn + pending-implies-unqualified (1h grace) | `workers/reconciler.ts` |
| API/frontend | `/dashboard` income from released accruals + `pendingBonusPaise`; `/pairs` = accrual history (`pairMemberCode`, `status`); PairMatch/Dashboard UI + en/ta strings | `api/frontend.ts`, `frontend/src/types/api.ts`, `pages/PairMatch.tsx`, `pages/Dashboard.tsx` |
| Tests | Worked-example E2E (02=₹2000, 03 pending→released), sibling-activation concurrency, accrue/release idempotency, retroactive-release cap split, reconciler invariants | `test/integration/pairAccrual.test.ts` (new), `pipeline.test.ts`, `test/unit/*` |

**Worked example (ground truth):** 02 → 03(L), 04(R) active; 03 → 05(L), 06(R). 05 activates → 02 qualifies → 02's own-pair ₹1000 releases. 06 activates → pair at 03 → 03 accrues ₹1000 pending; 02 paid ₹1000 → **02 = ₹2000, 03 = ₹0**. A buyer under 05/06 → 03 qualifies → 03 = ₹1000.

**Migration to apply:** `npm run migrate` (applies `020_pair_accruals.sql`; requires a dev DB reset first if legacy multi-pair rows exist — `npm run reset -- --yes && npm run migrate && npm run seed`).

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

## 2026-07-12 — Separate management account + admin console
- **Roles are now three-tier:** `management` (master, off-tree) → `admin` (appointed staff) → `member`. Migration `016_management_role.sql` extended the role check, rescoped `uq_single_root` to `WHERE parent_id IS NULL AND role <> 'management'` (invariant "one tree root" preserved), and added `members.blocked`.
- **`management@avg.com` (AVGMGMT1)** seeded via `npm run seed:management` (env `MGMT_SEED_PASSWORD`); it is the only account that can grant/revoke `admin`, cannot be blocked or demoted via API, lives off-tree (no slot, no team-count pollution, registration under it returns 409). **root@avg.com was demoted to a plain member.**
- New admin endpoints (all `requireAdmin` + audit-logged): `POST /admin/members/:id/block`, `GET /admin/overview`, `GET /admin/payouts` + `/:batchId/items`, `GET/POST-replay/DELETE /admin/dead-letters`. Login/refresh reject blocked members (403 `ACCOUNT_BLOCKED`).
- Frontend: role-gated `/admin` console (lazy chunk); staff logins land on `/admin`; Settings' payout button replaced by a console link.
- **Applied to the Railway DB and verified end-to-end on 2026-07-12.** NOTE: any deployed API older than this code needs a redeploy for the console (and the blocked-login enforcement) to work against production.

## 2026-07-13 — Console pages as routes, live topbar, review fixes
- Admin console sections are now **real routes** (`/admin`, `/admin/members|ranks|payouts|system|audit`), not tabs. The management account's sidebar lists them directly (member pages hidden — it is off-tree); appointed `admin` members keep the member menu + one console entry with a route-linked pill subnav. Management visiting `/` is redirected to `/admin` (`MemberHome` guard, gated on query-pending so the dashboard never mounts early).
- Topbar is live: the bell shows the real unread count from the shared `lib/useNotifications.ts` derivation (same source as the Notifications page) and navigates to `/notifications`; the avatar opens a working dropdown (My Profile / Settings / Logout; management gets Settings/Logout and no bell).
- **Code-review fixes:** blocking a member now also revokes all their refresh tokens (session dies at next refresh; residual exposure = access-token TTL ≤15m — `app.authenticate` intentionally stays DB-free); the management-sponsor 409 guard moved INTO `services/placement.ts` `registerMember` (covers simulate/tests; integration tests added in `test/integration/http.test.ts`); login's blocked check rides `buildMe` (no extra round trip; `/me` now returns `blocked`); DLQ replay audits only when its DELETE actually removed the row; audit-log UI uses offset pagination (`useInfiniteQuery`); shared `lib/roles.ts` (`isStaff`/`isManagement`/`homeFor`), `lib/useLogout.ts`, and `avg-btn-danger` replace scattered copies.
- **Member-code prefix corrected AGV → AVG** (brand is Agila Vetri Groups): `lib/ids.ts` generator fixed and migration `017_avg_code_prefix.sql` rewrote all existing codes (`AVG100001`, …). member_code has no FKs, so only display/referral links change — **previously shared referral links containing an AGV… code will no longer resolve** (register returns "Sponsor not found"); members should re-copy their link.

## 2026-07-13 — Product catalog (S3 multi-image) + KYC document gate
- **Products are now management-editable** with description + multiple S3 images. Migration `018_products_images_kyc_docs.sql`: `products.description`, `products.id` → identity (next insert gets id 4+), new `product_images` (ordered, `ON DELETE CASCADE`) and `kyc_documents` tables. `kyc_status` stays on `members`; the existing approve endpoint is unchanged.
- **S3 transport** (`lib/s3.ts`, `@aws-sdk/client-s3` + presigned POST): the browser uploads directly to bucket `s3-ecommerce-links-bucket` (ap-south-1); the API only signs. Keys are always server-minted `{prefix}/{uuid}.{ext}` (extension from validated content type, ≤5 MB, jpeg/png/webp). `products/*` is meant to be public-read; `kyc/{memberId}/*` is private, served only via ≤15-min presigned GETs, and members can only ever sign keys inside their own JWT-derived folder.
- **New endpoints** — admin (`requireAdmin`; product mutations additionally management-only, all audit-logged): `GET/POST /admin/products`, `PATCH /admin/products/:id`, `POST /admin/products/images/presign`, `GET /admin/members/:id/kyc-documents`. Member: `POST /me/kyc/presign`, `GET/POST /me/kyc/documents` (re-upload after rejection resets status to pending); `GET /products` now returns `description` + `images`.
- **Purchase gate:** `POST /orders` returns `409 KYC_REQUIRED` unless `kyc_status='verified'`. `confirmOrder`/activation/pipeline untouched. `simulate.ts`/`seedRoot.ts` mark generated members verified (they bypass HTTP, this keeps demo data coherent).
- Frontend: management-only **Products** console page (multi-image upload w/ progress + previews + reorder, `rupeesToPaise` string-math price input); BuyProduct shows product images, a thumbnail-switcher gallery for the selected product, and a KYC-required banner (server 409 also mapped); Profile KYC tab has the real document uploader + uploaded-doc list; MembersTab modal shows the member's KYC images via presigned URLs before verify/reject. New `components/ui/ImageUploader|ImageGallery`, `lib/s3upload.ts` (XHR direct-to-S3 — deliberately not the axios instance). i18n en+ta.
- Tests: 81/81 green (`s3keys` unit tests; integration: KYC gate 409→201, product CRUD 403/201/paise-math/audit/active-toggle). Stale `Phase 2` admin tests were updated to the three-tier role model (they still assumed root=admin), and test helpers no longer pick management accounts as anchors.
- **⚠️ NOT DONE — bucket setup + key rotation:** the bucket currently has **no CORS config and no bucket policy** (verified 2026-07-13), so browser uploads and public product images will not work yet. Run `npx tsx scripts/setupS3Bucket.ts` (applies CORS for the dev/prod origins + public-read policy scoped to `products/*`; needs a key with `s3:PutBucketCORS`/`s3:PutBucketPolicy`, or apply the same JSON in the console). The access key currently in `backend/.env` was shared in chat and **must be rotated**; scope its replacement to `s3:PutObject/GetObject/DeleteObject` on `products/*` + `kyc/*` only.

## 2026-07-15 — Email service, optional login OTP, gapless member codes
- **Email service** added (`src/lib/email.ts`); wired for OTP and welcome mail. Two management-flippable flags seeded into `system_settings` (`023_email_settings.sql`): `login_otp_enabled` and `welcome_email_enabled`, **both default `false`** — no email/OTP behaviour is on until management enables it via `PATCH /admin/settings`. No redeploy needed to flip.
- **Optional login OTP:** when `login_otp_enabled` is on, `POST /auth/login` returns an OTP challenge; the code is emailed and verified via a **rate-limited, atomic** verify (single-use, expiry-bounded). **Management accounts bypass OTP entirely** (`eea5a0b`) so the master account can always get in. Frontend adds an OTP entry step with an **expiry countdown + resend cooldown** (`ff5332f`).
- **System settings k/v store** (`022_system_settings.sql`): management runtime feature-flag table (`system_settings(key, value jsonb, updated_by)`). First flag `kyc_optional` (default `false` = KYC stays mandatory for product purchase). Read by the order-creation gate; flipped via `PATCH /admin/settings` with audit log.
- **Gapless member-code counter** (`021_member_code_counter.sql`): single-row `member_code_counter` incremented **inside the registration txn**, so a rolled-back signup also rolls back the number — AVG codes never skip. Seeded from `MAX(existing code)+1`.
- Also: password strength hardening + secure/atomic OTP generation with rate limiting (`9b2bc60`); KYC status polling + gapless-code refactor of admin rank queries (`a7103e5`).

## 2026-07-16..18 — Order payment-proof workflow + admin orders
- **Payment-proof upload/review** (`cf8f58e`): members upload payment screenshots to S3 for manual review. Schema evolved across three migrations — a single `orders.payment_proof_key` column (`024`) was superseded by a **multi-proof table** `order_payment_proofs(order_id, s3_key UNIQUE, uploaded_at)` (`025`), and the now-unused single column dropped (`026`). Multiple screenshots per order supported.
- **Admin orders management** (`9b2bc60`, `b3c1e3e`): admin console lists orders with **infinite (offset) pagination**; support email address corrected.
- **Welcome email deferred** (`028_members_welcome_sent.sql`, `fb8ed1e`): idempotent welcome mail is sent **only when signup actually completes** — immediately at registration if OTP login is off, or after first successful OTP verify if on. `welcome_sent_at` NULL = not yet sent; existing members backfilled to `created_at` so no stale welcome fires.
- **On-behalf activation** (`fdcceb9`): admin can activate a member on their behalf; order-creation logic refactored to share the confirm/activation path.

## 2026-07-21..22 — Rejected orders, flat pricing, phone non-unique, depth-12, product deletion
- **Rejected order status** (`027_orders_rejected_status.sql`, `aba12fb`): `orders.status` CHECK gains `rejected`, plus a `rejection_reason` column — management can reject a payment proof so the member re-uploads. Management can also **override a rejected order → `paid`** (promote). `rejected` orders remain reusable by `createOrder` dedup (see CLAUDE.md product-deletion gotcha).
- **Flat pricing — GST removed** (`c62e1be`): GST calculation deleted; all products are flat-priced. `GST_PCT` may linger in env/config but is no longer applied on the order path. **Docs corrected** in PROJECT.md/CLAUDE.md.
- **Phone no longer unique** (`029_drop_members_phone_unique.sql`, `0e4756a`): `members_phone_key` dropped — families/groups may register under one mobile number. Phone stays `NOT NULL` (contact/display only); **login is email-only** (email stays UNIQUE). Do not re-add the unique constraint.
- **Tree depth limit raised to 12** (`0e4756a`): network downline read is now capped by `CFG.MAX_TREE_DEPTH` (env `MAX_TREE_DEPTH`, default 12; was a hardcoded 6); network downline integration tests added (`6d034fa`).
- **Management-only product deletion** (`36143d0`): order-gated hard delete — see the CLAUDE.md gotcha (any order in any status → 409 "deactivate instead", because `orders.product_id` has no ON DELETE CASCADE).
- Also: debounced search on the KYC-approvals table (`3935aad`).

## 2026-07-23..24 — Notifications, bank rejection, password reset, admin tree, rank rewards, qualification tighten
- **Server-side notifications tracking** (`030_members_notifications_seen.sql`, `2973e90`): `members.notifications_seen_at` timestamp. The notifications **feed** is still derived client-side from wallet credits + achieved ranks (`frontend/src/lib/useNotifications.ts`), but **read/unread state is now server-persisted** — `POST /me/notifications/seen` bumps the timestamp; `/me` returns `notificationsSeenAt`; clearing the bell on one device clears it everywhere (cross-device consistent). This refines the 2026-07-13 topbar note above.
- **Bank rejection status** (`031_bank_status_rejected.sql`, `2973e90`): `members.bank_status` CHECK expands to `pending`/`verified`/`rejected`, mirroring the three-state KYC model. Member bank-detail management + admin bank rejection flow added.
- **Password reset flow** (`01cfd8f`): scoped-OTP password reset with email delivery (reuses the OTP infra; no new migration). Public reset routes on the frontend.
- **Admin network tree + admin-grant confirmation + rank rewards** (`165f289`): admin console gains a **network/genealogy tree** view; granting the `admin` role now requires a **mandatory confirmation** step (management-only action); **rank-reward values updated**.
- **Qualification gate tightened + revert tooling** (`032_pair_accruals_release_seq.sql`, `d7c115e`): the 3-generation gate now requires **both directs active AND ≥1 active grandchild under an active direct**. `pair_accruals.release_seq` versions the release idempotency key so a qualification **revert** (`scripts/revertQualification.ts`) can claw back and later re-release accruals made under the old one-child rule. Already reflected in CLAUDE.md / PROJECT.md income-model sections.
- Also: order-detail expansion in MyOrders + admin order editing (`2ae5f18`).

### Documentation currency (2026-07-25 audit)
- **STATUS.md, PROJECT.md, CLAUDE.md** are current through **migration 032** as of this audit.
- **Known-stale, deliberately not swept:** `INTEGRATION.md` (a "follow verbatim" historical integration script — its order-creation snippet still computes GST and caps tree depth at 4); `PLAN.md` (`GST_PCT` remains in the env-var lists as a preserved money-spec); `GAPS.md` (bug tracker; coverage stops ~migration 013, and reconciling which G-* are fixed is a separate verification task). Treat these three as historical/reference, not current-state.

## 2026-07-26 — Leg-directed referral placement
- **`POST /auth/register` accepts an optional `leg` (`L`/`R`)** again — but link-driven, not a form selector (the Phase 7 removal of `preferredLeg` still stands for the UI). Omitted → auto-fill (first referral → L, second → R, third → 409), the member's generic share link and the `simulate.ts`/test path — unchanged. Sent → the recruit is **pinned** to that slot, or **409 "Left/Right position already filled"** if taken (no silent fallback to the other leg). `nextChildPosition` → `resolvePosition(sponsorId, leg, c)` in `services/placement.ts`, under the existing sponsor `FOR UPDATE` lock; the `uq_placement_slot` retry branch is untouched (the preferred-taken error is a `statusCode` 409, not a `23505` conflict, so it propagates instead of retrying into the other leg).
- **Tree UI:** tapping a **vacant** slot now copies a leg-specific link (`?sponsor=CODE&leg=L|R`) using the slot's own side (`useTreeLayout.ts` already tags vacant nodes `L`/`R`); a member's own node copy button stays generic (auto-fill). `frontend/src/components/tree/BinaryTree.tsx`, `pages/auth/Register.tsx` (reads+forwards `leg`), `types/api.ts` (`RegisterReq.leg?`).
- **Tests:** new **LEG** suite in `test/integration/http.test.ts` — `leg=R` lands R with L still open; `leg=L` when L filled → 409 with R untouched; invalid `leg` → 400. Existing CAP + concurrent-race tests unchanged.

## 2026-07-29 — Income model v2: carry-forward pair matching (PR1 — migration 038)

Replaces the "2 Direct Pair Matching" model (migration 020) with unbounded carry-forward matching. Worker count: nine → **eight** (`pairComplete.ts` deleted).

| Area | Change | Files |
|---|---|---|
| Migration 038 | `DROP INDEX uq_pairs_one_per_member`; `CREATE INDEX idx_pairs_member_seq ON pairs (member_id, sequence_no)`; `COMMENT ON COLUMN member_counters.pairs_matched` updated (live, not deprecated) | `db/migrations/038_multi_pair_carry_forward.sql` |
| `counterPair.ts` rewritten | Reads `pairs_matched` under `FOR UPDATE`; mints pairs to target via `INSERT … ON CONFLICT DO NOTHING`; writes `PairCompleted` (audit, random UUID) and `PairBonusAccrued` (deterministic `pairAccrualEventId`) per pair inside the existing txn; sets `pairs_matched=target` in the final UPDATE (D-3 set-to-target) | `src/workers/counterPair.ts` |
| `pairComplete.ts` deleted | Pair detection now inside `counterPair.ts`; `avg-pair-complete` consumer group is now dead history | `src/workers/pairComplete.ts` (deleted) |
| `fanout.ts` stripped of pair-bonus fan-out | `fanOutPairBonus` and `PairCompleted` branch removed; only `MemberActivated`/`MemberQualified`/`RankAchieved` counter-increment fan-out remains | `src/workers/fanout.ts` |
| `ledger.ts` cap mode split | `creditBonusWithCap(mode)`: `"forfeit"` → immediate overage to `bonus_forfeited` (BR-12); `"defer"` → overage to `deferred_bonus` (BR-13, backlog release via `releasePendingBonuses`) | `src/workers/ledger.ts` |
| `reconciler.ts` extended | `pairs_drift` check: asserts `pairs_matched = LEAST(L,R)`, pair row count, and `COUNT(pair_accruals per pair) = 1` (BR-7 invariant) | `src/workers/reconciler.ts` |
| `lib/ids.ts` | Added `pairAccrualEventId(pairId, beneficiaryId)` — `uuidv5("pairbonus:…", FANOUT_NS)` (D-9 deterministic event id) | `src/lib/ids.ts` |
| Tests | Unit: carry-forward target math, idempotency, chk_pairs_le_min invariant; Integration: pairAccrual (BR-7 no fan-out, worked example, idempotency, cap BR-12/BR-13), qualificationRevert (v2 own-pair scenario) | `test/unit/counterPair.test.ts`, `test/integration/pairAccrual.test.ts`, `test/integration/qualificationRevert.test.ts` |

**Worked example (ground truth under v2):** 02 earns ₹1,000 from its own pair (L=03, R=04) when both activate and 02 qualifies. 03's pair (05, 06) accrues ₹1,000 to 03 only — 02 receives nothing from 03's pair. All accruals pend until earner qualifies; backlog release defers overage to `deferred_bonus`, immediate release forfeits overage to `bonus_forfeited`.

**Migration to apply (dev copy):** `npm run migrate` (applies `038_multi_pair_carry_forward.sql`).

**⚠ Production deploy requires the T6 backfill script (PR2) and D-7 gate:** `pairComplete.ts` must stop before migration; run `backfillPairsV2.ts --dry-run` before `--execute`; resume workers only after backfill confirms zero drift.

## 2026-07-29 — Income model v2 surfaces + backfill script (PR2 — T6, T7)

| Area | Change | Files |
|---|---|---|
| T6 — Backfill script | `scripts/backfillPairsV2.ts` (`npm run backfill:pairs`): dry-run default; per-member txn; re-runnable (ON CONFLICT DO NOTHING); production-host guard (`hayabusa.proxy.rlwy.net` blocked unless `--i-know`); blocking precheck on `release_seq > 0`; deletes pending v1 ancestor fan-out accruals; inserts v2 pairs + accruals; sets `pairs_matched=target`; emits `PendingBonusReleaseRequested` for qualified members | `scripts/backfillPairsV2.ts`, `package.json` |
| T7 — API: pairsMatched source | `/dashboard` now reads `pairs_matched` from `member_counters` (live, since 038) — not `COUNT(*) FROM pair_accruals` (v1 count) | `src/api/frontend.ts` |
| T7 — API: carryForward v2 | `carryForward.{side,excess}` now computed as `left_active-pairs_matched` / `right_active-pairs_matched`; by invariant LEAST(L,R)=pairs_matched so at most one leg has surplus | `src/api/frontend.ts` |
| T7 — Frontend: deferredBalancePaise | Dashboard Pair Summary card shows `deferredBalancePaise` row when non-zero (BR-13 backlog releases defer overage there; meaningful again under v2) | `frontend/src/pages/Dashboard.tsx` |
| T7 — i18n | `pairs.subtitle` updated (no more "and every upline"); `pairs.legBalance` → "Carry Forward"; `pairs.legBalanceNote` updated for v2 semantics; `pairs.deferredBonus` added | `frontend/src/i18n/en.json`, `ta.json` |
| T7 — API contract | `DashboardCounters.pairsMatched` and `Dashboard.carryForward` doc comments updated | `frontend/src/types/api.ts` |
| T9 — E2E integration test | 10-member binary tree with scripted activation order; asserts per-node `pairs_matched`, total 9 pairs, BR-7 (one accrual per pair), qualification+release for M0/P1/P2, BR-14 reconciler invariants | `test/integration/e2e.test.ts` |
