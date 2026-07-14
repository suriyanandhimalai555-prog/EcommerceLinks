# GAPS.md — Honest audit of every weakness found

Ordered by severity, most important first. Each gap: what it is, where it lives, why it matters, and a fix scoped small enough for a single focused task.

Severity legend: **S1** = money loss / security breach possible today · **S2** = wrong business results or blocked launch · **S3** = will bite under load, failure, or maintenance · **S4** = hygiene.

---

## S1 — Critical

### G-1. Frontend is not connected to the backend; the API contracts diverge in ~15 places
- **What:** The frontend was built entirely against MSW mocks. The backend implements similar endpoints with different paths, field names, response envelopes, units, and even a different default port (backend `PORT=3000`, frontend `.env.example` says `http://localhost:4000`). Concretely: login response lacks `member`; `/me` vs `/auth/me`; `/products` returns `basePaise` not `basePricePaise` and no `badges`; `POST /orders` returns rupee string `totalAmount` not `totalPaise`; `GET /orders/:id`, `POST /dev/simulate-payment`, `PUT /me/kyc`, `PUT /me/bank`, `GET /network/directs`, `GET /payouts` don't exist; `/network/summary`, `/pairs`, `/wallet`, `/wallet/ledger`, `/withdrawals`, `/ranks/progress`, `/dashboard` all return different shapes (`entries` vs `items`, `D/C` vs `credit/debit`, missing `currentWindow`, `incomeSeries`, `recentTransactions`, `todayPairBonusPaise`, `rank.currentLevel` vs `rank.current`, etc.); `POST /withdrawals` expects rupees, frontend sends `amountPaise`.
- **Where:** `backend/src/api/*` vs `frontend/src/mocks/handlers.ts` + `frontend/src/types/api.ts` (the contract) and every file in `frontend/src/pages/`.
- **Why it matters:** The product does not function. Nothing else on this list can be verified end-to-end until this is fixed.
- **Fix:** Follow `INTEGRATION.md` exactly. Strategy: make the backend serve the frontend's mock contract via one new route module, rather than editing 15 pages.

### ~~G-2. Payment webhook is unauthenticated and unverifiable~~ ✅ FIXED
- **What was fixed:** `WEBHOOK_SECRET` added to `CFG`; webhook handler in `backend/src/api/frontend.ts` now rejects with 401 unless `x-webhook-secret` header matches (when secret is configured). Idempotency key leak from `POST /orders` was already fixed in a prior session.
- **Remaining:** Replace the shared-secret check with real gateway HMAC verification when a payment provider is chosen.

### ~~G-3. Admin endpoints have no role check~~ ✅ FIXED
- **What was fixed:** Migration `010_roles.sql` adds `role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin'))` to `members`. `app.requireAdmin` decorator added to `server.ts` (verifies JWT then does a live DB lookup for `role='admin'`, returns 403 otherwise). All `/admin/*` routes now use `requireAdmin`. `role` field added to `/me` and login response. Frontend `Me` type updated; `Settings.tsx` shows “Admin Controls” section only when `me.role === 'admin'`.

### ~~G-4. Withdrawals disconnected from ledger / dual payout models~~ ✅ FIXED
- **What was fixed:** Chose model A (auto-payout only). Removed `POST /withdrawals` and `GET /withdrawals` from `frontend.ts`. Removed admin withdrawal approval/reject routes from `admin.ts`. Wallet page no longer shows withdrawal form or table. Added `POST /admin/payouts/trigger` (admin-only) so the admin can manually kick off the Saturday payout batch from Settings; the "Trigger Payout Now" button is visible only when `me.role === 'admin'`.
- **Withdrawals table** (`backend/db/migrations/008_payouts.sql`): The `withdrawals` table is intentionally retained as dead schema — the feature was removed before it shipped, but the table is kept to avoid a destructive migration. It has no live callers. If member-initiated withdrawals are added in a future release, use this table rather than re-creating it.

### ~~G-5. First right-leg rank achiever silently lost~~ ✅ FIXED
- **What was fixed:** One-line fix in `backend/src/workers/counterPair.ts` — right-side `INSERT INTO leg_rank_counters` now uses `VALUES ($1,$2,1)` (was `0`). Unit test added in `test/unit/counterPair.test.ts`.
- **Remaining:** If this system has been running with live data, run a backfill: `UPDATE leg_rank_counters SET right_count = (SELECT COUNT(*) FROM rank_achievements ra JOIN members m ON m.placement_path @> ARRAY[leg_rank_counters.member_id] AND m.position = 'R' WHERE ra.rank_level = leg_rank_counters.rank_level AND ra.member_id = m.id)` (adjust to your placement schema).

---

## S2 — High

### ~~G-6. Cutoff window math drifts one day earlier every week~~ ✅ FIXED
- **What was fixed:** `nextWindowStart` now returns `windowEnd + 1 second` with no `.set({hour:18})` override. `windowEnd` now returns `windowStart + 7 days − 1 second`. `ensureCutoffExists` fresh-seed changed from Sunday-anchor to Saturday-anchor (matching the close cron). Both functions exported. Unit test in `test/unit/cutoff.test.ts` asserts 8 consecutive windows start Saturday 18:00:00, end Saturday 17:59:59, and are exactly 7 days long.

### ~~G-7. Failed payments recorded as `paid`~~ ✅ FIXED
- **What was fixed:** Migration `011_orders_status.sql` adds `'failed'` to the `orders.status` CHECK. Webhook handler in `backend/src/api/frontend.ts` now sets `status='failed'` on the failed branch. `confirmOrder` already only matches `status IN ('created','paid')` so failed orders cannot be double-confirmed.

### ~~G-8. Config values are duplicated in SQL and disagree with `CFG`~~ ✅ FIXED
- **What was fixed:** `counterPair.ts` now imports `CFG` and `fromPaise`; the `INSERT INTO pairs` literal `1000.00` is replaced by `fromPaise(BigInt(CFG.PAIR_BONUS_PAISE))`, and the `PairMatched` event `amount_paise` is now `Number(CFG.PAIR_BONUS_PAISE)`. DB constraints (`005_pairs.sql` DEFAULT, `006_cutoffs.sql` `chk_cap`) kept intact — unit test in `test/unit/config.test.ts` guards that `CFG.PAIR_BONUS_PAISE === 100000` and `CFG.CUTOFF_CAP_PAISE === 10000000` match the DB schema. `events/types.ts` `PairMatched.amount_paise` widened from literal `100000` to `number`.
- **Superseded (2026-07-14):** the 020 income rework removed `PairMatched` and counterPair minting; the G-8 guard carries over — `workers/pairComplete.ts` writes `pairs.bonus_amount`/`PairCompleted.amount_paise` from `CFG.PAIR_BONUS_PAISE` (see STATUS.md Phase 9).

### ~~G-9. Auth hardening absent~~ ✅ FIXED (all three parts)
- **What was fixed:** (1) `config.ts` now throws at startup in production if `JWT_SECRET` is the dev default, `WEBHOOK_SECRET` is empty, or `DATABASE_URL`/`REDIS_URL` are missing. (2) `@fastify/rate-limit@9` added; `/auth/login` is rate-limited to 10 requests/min/IP. (3) Migration `013_refresh_tokens.sql` adds `refresh_tokens (jti UUID PK, member_id, expires_at, revoked_at)`; `auth.ts` issues a `jti` per refresh token, validates the jti on `/auth/refresh`, rotates (revokes old, issues new) on use. `POST /auth/logout` revokes the jti. Frontend `lib/auth.ts` exports `logout()` which calls `/auth/logout` before clearing local state; Sidebar and Settings now use it. Tests in `test/integration/http.test.ts` verify rotation and revocation.

### ~~G-10. Duplicate phone/email registration returns 500, not 409~~ ✅ FIXED
- **What was fixed:** `placement.ts` catch block now maps `pg.code === '23505'` with `constraint === 'members_phone_key'` → 409 "Phone number already registered" and `members_email_key` → 409 "Email address already registered". Tested in `test/integration/http.test.ts`.

### G-11. Mock data is baked into the "live" UI — users can see fake money
- **What:** Every page passes mock objects as TanStack Query `placeholderData`, so real deployments flash fabricated balances (₹18,500 wallet, 210 pairs) before — or, on any fetch error, *instead of* — real data (`dash || mockDashboard`, `data?.items || mockPayouts`). Worse, several views are 100% mock with no fetch at all: `Profile.tsx` (`const me = mockMe`), `Topbar.tsx` (mock user name/avatar), `Notifications.tsx`, `IncomeReport.tsx`, and the stats header in `DirectMembers.tsx` (`const s = mockNetworkSummary`).
- **Where:** all files importing from `frontend/src/mocks/data.ts` (12 pages/components — grep `from '../mocks/data'`).
- **Why it matters:** Showing members fake income figures in a money app is a trust and possibly legal problem; error states silently masquerade as healthy data.
- **Fix:** Steps 6–7 of `INTEGRATION.md` remove the always-mock pages. Then a follow-up task: delete every `placeholderData: mock*` and `|| mock*` fallback, replacing with skeleton loaders (the `Skeleton` component already exists) and an error state (`EmptyState` exists).

### ~~G-12. Any member can read any other member's subtree~~ ✅ FIXED
- **What was fixed:** `/network/tree` handler in `frontend.ts` now verifies after resolving `rootId` that either `rootId === user.sub` OR the caller's id appears in the target's `placement_path` (`SELECT 1 FROM members WHERE id = $1 AND placement_path @> ARRAY[$2::bigint]`). Returns **404** (not 403) for both "not found" and "not in downline" — avoids leaking whether a member code exists. Redis cache key unchanged (auth check runs before cache read, preventing cross-caller data leaks). Tested in `test/integration/http.test.ts`.

---

## S3 — Medium

### G-13. Client-side route protection exists but is never applied
- **What:** `RequireAuth` in `frontend/src/routes/guard.tsx` is dead code; `App.tsx` wraps nothing. Logged-out users can load every page (they'll see mock/placeholder data per G-11, compounding the confusion).
- **Fix (single task):** Wrap the `AppShell` route element: `element={<RequireAuth><AppShell /></RequireAuth>}` and add a bootstrap that calls `/auth/refresh` + `/me` on app start when only a refresh token exists.

### ~~G-14. Registration transaction does slow work and unbounded walking while holding a connection~~ ✅ FIXED
- **What was fixed:** (1) `argon2.hash` is now called **before** `withTxn` — the CPU-heavy work no longer holds a pooled connection and does not repeat on placement-slot retries. (2) `findPlacementSlot` unbounded `while(true)` loop replaced by a single recursive CTE (`WITH RECURSIVE walk AS (SELECT id WHERE id=$sponsor UNION ALL SELECT m.id FROM members m JOIN walk w ON m.parent_id = w.id AND m.position = $leg) SELECT id ORDER BY id DESC LIMIT 1`).

### ~~G-15. Test coverage misses every path where money can go wrong~~ ✅ FIXED (backend tests)
- **What was added:** (1) `test/unit/ledger.test.ts` — cap-boundary arithmetic for `creditPairBonus` at zero, at the split point (₹99,500 earned → ₹500 wallet / ₹500 deferred), at cap, and for 101 pairs totalling exactly cap. (2) `test/unit/config.test.ts` — guards that `CFG.PAIR_BONUS_PAISE`/`CFG.CUTOFF_CAP_PAISE` match the DB schema constants. (3) `test/integration/http.test.ts` — HTTP-layer tests via Fastify inject: G-10 duplicate-phone 409, G-9 token rotation (old jti rejected after rotation), logout revocation, G-12 tree privacy 403; **G-2/G-7 webhook gate** (missing/wrong secret → 401; correct secret → 200 + order confirmed + MemberActivated in outbox; failed status → order marked 'failed'). (4) `test/integration/pipeline.test.ts` — **T-CTE** (3 consecutive members on same leg form a depth-3 chain, proving the recursive CTE 2-level walk); **T-G8-bonus** (calls `applyIncrements` against a real DB member, queries `pairs.bonus_amount` and `events_outbox.PairMatched.amount_paise` — both must come from `CFG.PAIR_BONUS_PAISE`, not a hardcoded literal).
- **Remaining:** concurrency test for simultaneous `applyIncrements` (the idempotency guard is proven correct by the at-least-once deterministic-id invariant, but no automated concurrency test exists yet).
- **Superseded in part (2026-07-14):** the 020 income rework replaced `creditPairBonus`/T-G8-bonus with `creditBonusWithCap` unit tests and `test/integration/pairAccrual.test.ts` (worked-example E2E, sibling-activation concurrency, accrue/release idempotency, retroactive cap split) — see STATUS.md Phase 9.

### G-16. Event pipeline delivery/ordering caveats are real but undocumented
- **What:** `fanout` publishes increments to the stream *then* records `processed_events` in a separate transaction — a crash between the two re-publishes increments (safe only because increment ids are deterministic; this invariant is not written down anywhere). `RankEvalRequested` is emitted per counter batch and rank evaluation reads counters in a *new* transaction — benign, but a reader will burn an hour convincing themselves. `counterPair` processes long per-ancestor batches without acknowledging progress mid-batch — a batch of thousands of increments for one whale ancestor that dies mid-run gets re-delivered whole (safe for the same deterministic-id reason, but it must stay that way).
- **Where:** `backend/src/workers/fanout.ts`, `counterPair.ts`.
- **Fix:** (1) In the PLAN.md §2A transport build, `XACK` each entry only after its ancestor's txn commits, and rely on `XAUTOCLAIM` re-delivery for crashes. (2) Write the "deterministic id ⇒ at-least-once is safe" invariant as comments at both the producer and consumer.

### G-17. `evaluateQualification` may report the wrong qualifying child in the event payload
- **What:** The `RETURNING` subqueries pick *any* active direct (`LIMIT 1`, no ORDER BY, no requirement that this child has the active grandchild), which can differ from the child that actually satisfied the `EXISTS`. The qualification flag itself is correct; the `via_child_id`/`via_grandchild_id` audit fields can be wrong.
- **Where:** `backend/src/services/qualification.ts`.
- **Fix (single task):** Correlate: pick the child in one subquery `(SELECT r.id FROM members r JOIN members g ON g.sponsor_id=r.id AND g.is_active WHERE r.sponsor_id=m.id AND r.is_active LIMIT 1)` and derive the grandchild from that same `r.id`.

### G-18. Dead code and committed junk
- **What:** Never-imported: `frontend/src/components/dashboard/*` (6 files), `frontend/src/data/mockData.ts`, `frontend/src/components/layout/Header.tsx`, `Layout.tsx`, `frontend/src/routes/guard.tsx` (until G-13 is done), `frontend/src/App.css`, default Vite assets (`react.svg`, `vite.svg`). Repo root: `.vite/` build artifacts committed; `.env.example` at root contains only frontend vars (misleading — backend has no env example at all); `frontend/README.md` is the untouched Vite template.
- **Fix (single task):** Delete the dead files, add `.vite/` to a root `.gitignore`, move `.env.example` into `frontend/`, create `backend/.env.example` listing every key in `config.ts`, and replace `frontend/README.md` with two lines pointing to `PROJECT.md`/`INTEGRATION.md`.

### G-19. Reconciler only samples and only writes alerts to local disk
- **What:** Nightly check samples 500 members / 200 wallets and writes JSON alert files to `backend/out/` with a `console.error`. No paging, no metric, no full-scan mode, and drift is detected but never repaired.
- **Where:** `backend/src/workers/reconciler.ts`.
- **Fix (single task):** Add an exit-code/webhook notification hook (env `ALERT_WEBHOOK_URL`, POST the alert summary) and a `--full` CLI flag that scans all rows for pre-payout Friday runs.

### G-20. Assorted correctness papercuts
- **What/Where/Fix, one line each:**
  - `fromPaise` goes through `Number` — precision loss above ~₹90 trillion; fine in practice, add a comment + guard (`lib/money.ts`).
  - ~~Cron workers use `setInterval` minute-matching~~ ✅ **FIXED for cutoff + payout** — both now query DB state each tick and self-heal after downtime. `reconciler` still uses clock-based scheduling (lower priority; fix when adding `ALERT_WEBHOOK_URL` per G-19).
  - `webhook`/`orders` cast paise through `Number(...)` for event payloads — consistent with event types but caps at 2^53; acceptable, document it.
  - `simulate.ts` hardcodes `10000/1800/11800` instead of computing via `money.ts` — will silently diverge if GST changes.
  - Redis cache for trees has no invalidation on registration — new members can be invisible for up to 60s; acceptable, but state it in the UI or shorten TTL.
  - CORS is `origin: true` (reflect any origin) — fine for dev, must be an allowlist in production (`server.ts`).
  - `withdrawals` CHECK `amount >= 500` duplicates `MIN_PAYOUT_PAISE` config (same class as G-8).

---

## S4 — Hygiene

### ~~G-21. No lint/format tooling in backend; no CI anywhere~~ ✅ FIXED
- **What was fixed:** Biome added to backend (devDependency `@biomejs/biome`); `npm run lint` script added (runs `biome check src/ scripts/ db/`); `biome check --write` applied safe auto-fixes across 28 source files. CI workflow `.github/workflows/ci.yml` created: two jobs — `backend` (Postgres 16 + Redis 7 service containers → lint → build → migrate → seed → test) and `frontend` (lint → build). Gates `main` branch on push and PR.

### G-22. Two mock datasets and template README confuse newcomers
- **What:** `src/mocks/data.ts` (live contract) vs `src/data/mockData.ts` (dead) — a new engineer will edit the wrong one; covered by G-18's deletion but worth calling out as the trap it is.
