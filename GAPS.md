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

### G-2. Payment webhook is unauthenticated and unverifiable — anyone can mint activations (and therefore real money)
- **What:** `POST /webhooks/payment` accepts any JSON with an `orderId` + the order's `idempotencyKey` and confirms the order, activating the member and triggering pair bonuses through the whole upline. `POST /orders` *returns that idempotency key to the client* as `paymentIntent`, so any logged-in member can create an order and then "confirm" it themselves without paying. There is no gateway signature check, no shared secret, no IP allowlist.
- **Where:** `backend/src/api/orders.ts` (`/webhooks/payment`, `confirmOrder`, and the `paymentIntent` leak in `POST /orders`).
- **Why it matters:** Free activation ⇒ unlimited fake pairs ⇒ real ₹1,000 credits ledgered per pair ⇒ real bank payouts every Saturday. This is direct financial loss.
- **Fix (single task):** Add `WEBHOOK_SECRET` to `CFG`; in the webhook handler, reject unless header `x-webhook-secret` equals it (later replace with real gateway HMAC verification). Stop returning the idempotency key from `POST /orders` — return an opaque order id only.

### G-3. Admin endpoints have no role check — any member can approve their own withdrawal or rank reward
- **What:** All `/admin/*` routes use only `app.authenticate` (any valid member JWT). The code even admits it: “All admin routes require JWT for now; in prod, add role check.”
- **Where:** `backend/src/api/admin.ts`.
- **Why it matters:** Any member can approve pending withdrawals (including their own) and mark ₹25Cr rank rewards as fulfilled.
- **Fix (single task):** Migration `010_roles.sql`: `ALTER TABLE members ADD COLUMN role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin'))`. Include `role` in the JWT payload at login. Add an `app.requireAdmin` preHandler in `server.ts` that 403s unless `req.user.role === 'admin'`, and use it on every admin route.

### G-4. Withdrawals are disconnected from the ledger, and a second automatic payout path pays the full wallet anyway
- **What:** `POST /withdrawals` only inserts a row — it does **not** debit or hold wallet funds, so a member can file five withdrawal requests against the same ₹1,000 and each passes the balance check. `POST /admin/withdrawals/:id/approve` flips status but posts **no ledger transaction** — no money ever moves through this path. Meanwhile, the payout worker independently sweeps the **entire wallet balance** of every KYC+bank-verified member each Saturday regardless of any withdrawal request. Two contradictory payout models coexist.
- **Where:** `backend/src/api/wallet.ts` (POST /withdrawals), `backend/src/api/admin.ts` (approve/reject), `backend/src/workers/payout.ts` (`buildBatch`).
- **Why it matters:** Double-payment paths, phantom "approved" withdrawals that never pay, and a member-hostile surprise (their whole wallet leaves every week whether they asked or not).
- **Fix (single task, pick model A — it matches the built pipeline):** Keep the automatic weekly full-balance payout as the *only* payout mechanism. On `POST /withdrawals` and its admin approval, either delete the feature from backend+frontend, or convert it into a "hold": on request, post a ledger txn D wallet → C a new `withdrawal_hold` account, and on approve, D withdrawal_hold → C payout_clearing; exclude held funds from `buildBatch`. Do not ship both models.

### G-5. First right-leg rank achiever is silently lost (ranks 5–12 gate broken)
- **What:** In the rank-achiever counter upsert, the right-side branch inserts `right_count = 0` on first insert (the `VALUES ($1,$2,0)` with a "placeholder" comment), only incrementing on conflict. The left-side branch correctly inserts `1`. So the *first* rank-N achiever in a member's right leg is never counted; the member needs a second one before the level N+1 gate can open.
- **Where:** `backend/src/workers/counterPair.ts`, the `counter_type === 'rank_achiever'` / right-side `INSERT INTO leg_rank_counters` statement.
- **Why it matters:** Ranks 5–12 (₹10L gold up to ₹25Cr) are awarded later than earned, or never. Members will notice; this is a payout-dispute generator.
- **Fix (one line):** Change the right-side insert to `INSERT INTO leg_rank_counters (member_id, rank_level, right_count) VALUES ($1,$2,1)` keeping the same `ON CONFLICT … right_count + 1`. Then backfill: `UPDATE leg_rank_counters lrc SET right_count = (SELECT COUNT(*) …)` recomputed from `rank_achievements` joined through `placement_path` (or simply recompute both columns for all rows in one script).

---

## S2 — High

### G-6. Cutoff window math drifts one day earlier every week
- **What:** Comments say windows run Sunday 18:00 → Saturday 17:59:59 IST. `ensureCutoffExists` seeds that correctly, but `nextWindowStart(windowEnd)` = `windowEnd + 1s` with hour pinned to 18:00 — which is **Saturday** 18:00, not Sunday. The next window then ends Friday 17:59, the following one starts Friday 18:00, and so on: each week starts a day earlier. The close cron only fires Saturdays, so windows also spend up to 24h "open past their recorded end", meaning bonuses land in a window whose `window_end` predates them.
- **Where:** `backend/src/workers/cutoff.ts` (`nextWindowStart`, `windowEnd`).
- **Why it matters:** Weekly caps, deferred sweeps, and payout dates are all keyed off these windows; reports will disagree with reality within two weeks of launch.
- **Fix (single task):** Make `nextWindowStart` deterministic: the new window starts exactly at the moment the previous one is closed — i.e. `windowEnd.plus({seconds:1})` with **no** `.set({hour:18})`, and derive `windowEnd = windowStart.plus({days:7}).minus({seconds:1})`. Add a unit test asserting 8 consecutive windows all start Saturday 18:00:00 IST and are exactly 7 days long. (Decide once whether the business rule is Sat-18:00→Sat-17:59 or Sun→Sat, and update the comments to match.)

### G-7. Failed payments are recorded as `paid`
- **What:** The webhook's `status === 'failed'` branch runs `UPDATE orders SET status = 'paid' WHERE … status = 'created'`. There is no `failed` value in the status CHECK constraint, and marking a failed payment "paid" is the worst possible substitute.
- **Where:** `backend/src/api/orders.ts` webhook handler; `backend/db/migrations/003_commerce.sql` status CHECK.
- **Why it matters:** Order-state reporting is corrupted; a later "success" webhook for the same order would still confirm it (status `paid` is in the confirmable set), potentially activating someone whose payment bounced.
- **Fix (single task):** Migration adding `'failed'` to the orders status CHECK; change the branch to set `status='failed'`; exclude `failed` from the confirmable statuses in `confirmOrder`.

### G-8. Config values are duplicated in SQL and disagree with `CFG`
- **What:** (a) `cutoff_earnings` has `CHECK (earned <= 100000.00)` hardcoding a ₹1,00,000 cap while `CUTOFF_CAP_PAISE` is an env var — raise the env cap and every credit past ₹1L throws a constraint violation inside the ledger worker. (b) Pair insert hardcodes `bonus_amount = 1000.00` (twice: column default and the INSERT literal) while the ledger credits `CFG.PAIR_BONUS_PAISE`; change the env var and `pairs.bonus_amount` (used by `/dashboard` total income) disagrees with the ledger.
- **Where:** `backend/db/migrations/006_cutoffs.sql`, `005_pairs.sql`, `backend/src/workers/counterPair.ts` (INSERT INTO pairs), `backend/src/workers/ledger.ts`.
- **Why it matters:** Silent divergence between "what we display" and "what we paid" — exactly what the reconciler exists to prevent, introduced by design.
- **Fix (single task):** In `counterPair.ts`, insert `fromPaise(BigInt(CFG.PAIR_BONUS_PAISE))` instead of the literal. Either drop the SQL cap CHECK or document that `CUTOFF_CAP_PAISE`/`PAIR_BONUS_PAISE` are fixed constants of the scheme and delete them from env-tunable config.

### G-9. Auth hardening absent: default JWT secret, no login rate limit, irrevocable 30-day refresh tokens
- **What:** `JWT_SECRET` defaults to `dev-secret-change-in-prod` (server boots happily in production with it); no rate limiting or lockout on `/auth/login` (phone+password brute force); refresh tokens are stateless with a 30-day TTL and no revocation store — a stolen refresh token cannot be invalidated; logout doesn't exist server-side.
- **Where:** `backend/src/config.ts`, `backend/src/api/auth.ts`, `backend/src/api/server.ts`.
- **Why it matters:** This system moves money to bank accounts. Account takeover = redirected payouts.
- **Fix (three small tasks):** (1) In `config.ts`, throw at startup if `NODE_ENV==='production'` and `JWT_SECRET` is the default. (2) Add `@fastify/rate-limit` scoped to `/auth/login` (e.g. 10/min/IP). (3) Add a `refresh_tokens` table (jti, member_id, expires_at, revoked_at); issue jti in refresh tokens; check + rotate on `/auth/refresh`; add `POST /auth/logout` that revokes.

### G-10. Duplicate phone/email registration returns 500, not 409
- **What:** `registerMember`'s retry loop only catches unique violations on `uq_placement_slot`. A duplicate `phone` (or `email`) unique violation is re-thrown raw; the route handler only maps `statusCode` 404/409 and otherwise re-throws → 500 with a Postgres error in logs, generic failure in the UI.
- **Where:** `backend/src/services/placement.ts` (catch block), `backend/src/api/auth.ts` (`/register`).
- **Why it matters:** Registration is the top of the funnel; users retrying with the same phone see an opaque server error instead of "phone already registered".
- **Fix (single task):** In the catch block, if `pg.code === '23505'` and constraint is `members_phone_key` or `members_email_key`, throw a 409 with a clear message. Add a unit/integration test registering the same phone twice.

### G-11. Mock data is baked into the "live" UI — users can see fake money
- **What:** Every page passes mock objects as TanStack Query `placeholderData`, so real deployments flash fabricated balances (₹18,500 wallet, 210 pairs) before — or, on any fetch error, *instead of* — real data (`dash || mockDashboard`, `data?.items || mockPayouts`). Worse, several views are 100% mock with no fetch at all: `Profile.tsx` (`const me = mockMe`), `Topbar.tsx` (mock user name/avatar), `Notifications.tsx`, `IncomeReport.tsx`, and the stats header in `DirectMembers.tsx` (`const s = mockNetworkSummary`).
- **Where:** all files importing from `frontend/src/mocks/data.ts` (12 pages/components — grep `from '../mocks/data'`).
- **Why it matters:** Showing members fake income figures in a money app is a trust and possibly legal problem; error states silently masquerade as healthy data.
- **Fix:** Steps 6–7 of `INTEGRATION.md` remove the always-mock pages. Then a follow-up task: delete every `placeholderData: mock*` and `|| mock*` fallback, replacing with skeleton loaders (the `Skeleton` component already exists) and an error state (`EmptyState` exists).

### G-12. Any member can read any other member's subtree
- **What:** `GET /network/tree?root=<anyMemberCode>` resolves arbitrary member codes with no check that the root is within the caller's downline. Member codes are sequential (`AGV100001`, `AGV100002`, …) so enumeration is trivial.
- **Where:** `backend/src/api/network.ts`.
- **Why it matters:** Leaks the entire organization's structure, names, and activation status to any member — competitive and privacy exposure.
- **Fix (single task):** After resolving `rootId`, verify `rootId === caller` OR caller's id appears in the target's `placement_path` (`SELECT 1 FROM members WHERE id=$root AND placement_path @> ARRAY[$caller]::bigint[]`); else 403.

---

## S3 — Medium

### G-13. Client-side route protection exists but is never applied
- **What:** `RequireAuth` in `frontend/src/routes/guard.tsx` is dead code; `App.tsx` wraps nothing. Logged-out users can load every page (they'll see mock/placeholder data per G-11, compounding the confusion).
- **Fix (single task):** Wrap the `AppShell` route element: `element={<RequireAuth><AppShell /></RequireAuth>}` and add a bootstrap that calls `/auth/refresh` + `/me` on app start when only a refresh token exists.

### G-14. Registration transaction does slow work and unbounded walking while holding a connection
- **What:** `registerMember` runs `argon2.hash` (~100–300ms CPU) *inside* the transaction, and `findPlacementSlot` walks the extreme edge one SELECT per level — a 10,000-deep power leg is 10,000 sequential queries inside one txn. Under concurrent registrations to the same sponsor/leg, contention resolves only by 23505-retry (up to 5 full re-walks).
- **Where:** `backend/src/services/placement.ts`.
- **Fix (two tasks):** (1) Hash the password before opening the transaction. (2) Replace the walk with a single recursive CTE that finds the deepest node on the given edge, or maintain an "extreme node per (member, side)" pointer table updated on insert.
- **Why it matters:** Registration is the system's write hot path; MLM launches are bursty by nature.

### G-15. Test coverage misses every path where money can go wrong
- **What:** Unit tests cover only `lib/money.ts`. The integration suite is good but (a) requires the full docker stack and silently no-ops without a seeded root, (b) exercises worker functions directly, never the HTTP layer (zero tests for auth, webhook, withdrawals, admin), (c) has no concurrency test for simultaneous increments/pair minting, no cutoff-boundary test (₹99,500 + ₹1,000 split), no window-rollover test (which would have caught G-6), and (d) the frontend has zero tests of any kind.
- **Where:** `backend/test/`, absence of `frontend/src/**/*.test.*`.
- **Fix (scoped tasks, in order of value):** (1) API-level test: register → order → webhook (with secret) → poll counters. (2) Cap-boundary unit test around `creditPairBonus` split math. (3) Cutoff window generation test (8 weeks, fixed clock). (4) Concurrency test: two `applyIncrements` batches for the same ancestor in parallel. (5) Frontend: vitest + testing-library smoke test that Login submits and stores tokens against an MSW server.

### G-16. Event pipeline delivery/ordering caveats are real but undocumented
- **What:** `fanout` produces to Kafka *then* records `processed_events` in a separate transaction — a crash between the two re-produces increments (safe only because increment ids are deterministic; this invariant is not written down anywhere). `RankEvalRequested` is emitted per counter batch and rank evaluation reads counters in a *new* transaction — benign, but a reader will burn an hour convincing themselves. `counterPair` uses `eachBatch` without heartbeat/offset management for long batches (a batch of thousands of increments for one whale ancestor can exceed the session timeout and rebalance mid-transaction).
- **Where:** `backend/src/workers/fanout.ts`, `counterPair.ts`.
- **Fix:** (1) Add `await heartbeat()` inside the per-ancestor loop and `resolveOffset` per message in `counterPair`. (2) Write the "deterministic id ⇒ at-least-once is safe" invariant as comments at both the producer and consumer.

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
  - Cron workers use `setInterval` minute-matching (`hour===18 && minute===0`) — a GC pause or restart at the wrong second skips the week; switch cutoff/payout/reconciler to a persisted "last run" check (`if now >= scheduled && not yet run for this date`).
  - `webhook`/`orders` cast paise through `Number(...)` for event payloads — consistent with event types but caps at 2^53; acceptable, document it.
  - `simulate.ts` hardcodes `10000/1800/11800` instead of computing via `money.ts` — will silently diverge if GST changes.
  - Redis cache for trees has no invalidation on registration — new members can be invisible for up to 60s; acceptable, but state it in the UI or shorten TTL.
  - CORS is `origin: true` (reflect any origin) — fine for dev, must be an allowlist in production (`server.ts`).
  - `withdrawals` CHECK `amount >= 500` duplicates `MIN_PAYOUT_PAISE` config (same class as G-8).

---

## S4 — Hygiene

### G-21. No lint/format tooling in backend; no CI anywhere
- **What:** Frontend has oxlint; backend has nothing (no eslint/biome, no prettier); no GitHub Actions — tests never run automatically; single squashed commit means no history to bisect.
- **Fix:** Add biome (or eslint) to backend with the existing code style (2-space, no semicolons... note: backend omits semicolons inconsistently — pick one via formatter); add a CI workflow: install, `tsc --noEmit` both apps, backend unit tests, frontend `npm run build`.

### G-22. Two mock datasets and template README confuse newcomers
- **What:** `src/mocks/data.ts` (live contract) vs `src/data/mockData.ts` (dead) — a new engineer will edit the wrong one; covered by G-18's deletion but worth calling out as the trap it is.
