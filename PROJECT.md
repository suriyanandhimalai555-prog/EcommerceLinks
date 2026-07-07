# PROJECT.md — Agila Vetri Groups (AVG) Platform

> Read this first. It is the orientation a senior engineer would give a new hire.
> For known problems, read `GAPS.md`. For connecting the frontend to the backend, follow `INTEGRATION.md` step by step. For day-to-day operational rules, see `CLAUDE.md`.

---

## 1. What this is

This repository contains a **full-stack member platform for Agila Vetri Groups (AVG)**, a binary pair-match MLM (multi-level marketing) business operating in Tamil Nadu, India. Members join under a sponsor, buy a product package to "activate", recruit others into a binary tree (left leg / right leg), and earn:

- **Pair-match bonuses**: ₹1,000 every time one new active member on the left leg "pairs" with one on the right leg, counted from the member's own position in the tree.
- **Weekly cap with carry-forward**: pair income is capped at ₹1,00,000 per weekly cutoff window; the excess goes to a "deferred" balance and is swept into the wallet when the next window opens.
- **12-level rank ladder**: ranks 1–4 are earned by accumulating "qualified" members on both legs (25/50/100/250 each side); ranks 5–12 are earned by having at least one achiever of the previous rank in each leg. Rewards range from a Kodaikanal tour to a Rolls Royce.
- **Qualification gate**: a member becomes "qualified" only when they are active AND have an active direct referral who in turn has an active direct referral (3 generations in the *sponsor* tree).
- **Weekly payouts**: every Saturday, KYC+bank-verified members with wallet ≥ ₹500 have their full wallet balance paid out via a bank CSV file, minus 5% TDS. GST (18%) is added on product purchases.

Audience: two apps in one repo. The **member portal** (this frontend) is for MLM members — dashboard, genealogy tree, income reports, wallet, withdrawals, rank progress, bilingual English/Tamil UI. Admin capability (approving withdrawals and rank rewards) currently exists only as backend API routes with no dedicated UI.

**Current state, honestly:** the backend and frontend were built against *similar but not identical* API contracts and have never been run against each other. The frontend runs 100% on MSW browser mocks (`VITE_USE_MOCKS=true`). Connecting them is the single most important next task and is fully scripted in `INTEGRATION.md`.

---

## 2. Repository layout

```
EcommerceLinks/
├── .env.example          # FRONTEND env vars only (misleadingly at root)
├── .vite/                # committed build junk — safe to delete
├── backend/              # Node.js/TypeScript event-driven API + workers
│   ├── db/migrations/    # 9 numbered SQL files, applied in order by db/migrate.ts
│   ├── scripts/          # createTopics, seedRoot, simulate (load generator)
│   ├── src/
│   │   ├── api/          # Fastify routes: auth, orders, network, wallet, reports, admin
│   │   ├── domain/       # ranks.ts — rank ladder definitions and thresholds
│   │   ├── events/       # event types, topic map, transactional outbox writer
│   │   ├── lib/          # db pool/txn, kafka, redis, money (bigint paise), ids
│   │   ├── services/     # placement (registration + tree walk), qualification
│   │   └── workers/      # 9 standalone processes (see §4)
│   └── test/             # unit (money) + integration (full pipeline, needs docker)
└── frontend/             # React 19 + Vite + Tailwind member portal
    └── src/
        ├── pages/        # 15 route pages (Dashboard, Network, Wallet, …)
        ├── components/   # layout/, ui/, tree/ (live) + dashboard/ (DEAD CODE)
        ├── lib/          # api.ts (axios + token refresh), auth.ts (token store)
        ├── mocks/        # MSW handlers + data — THE de-facto API contract
        ├── data/         # mockData.ts — older, DEAD mock set
        ├── i18n/         # en.json + ta.json (Tamil)
        └── types/api.ts  # TypeScript contract every page codes against
```

---

## 3. Tech stack and why

| Piece | Choice | Evident reasoning |
|---|---|---|
| API server | **Fastify 4** + `@fastify/jwt` + `@fastify/cors` | Lightweight, fast, first-class JWT decorator pattern (`app.authenticate`). |
| Language | **TypeScript (strict), ESM, tsx runner** | No build step in dev; `type: module` throughout. |
| Database | **PostgreSQL 16** | The business logic is heavily relational and invariant-driven (unique placement slots, check constraints like `pairs_matched <= LEAST(left, right)`, partial unique indexes such as "exactly one root" and "exactly one open cutoff"). |
| Events | **Kafka protocol via Redpanda** (kafkajs) | Fan-out of one activation to potentially thousands of ancestors is done asynchronously; Redpanda chosen as a single-binary dev-friendly Kafka. Topic map in `src/events/topics.ts`. |
| Outbox | **Transactional outbox table + relay worker** | Guarantees events are emitted iff the DB transaction committed. `writeOutbox()` must be called inside the caller's transaction — this is a hard rule. |
| Money | **bigint paise + big.js** (`lib/money.ts`) | All arithmetic in integer paise; NUMERIC(14,2) in Postgres; `Number` never used for arithmetic. GST uses floor division (`pct`), TDS uses half-up rounding (`pctRoundUp`). |
| Cache | **Redis (ioredis)** | Only used for 60s caching of `/network/tree` responses. |
| Passwords | **argon2** | Modern KDF. |
| Time | **luxon, Asia/Kolkata everywhere** | Cutoff windows and payout schedules are IST business rules. |
| Frontend | **React 19 + Vite 8 + TypeScript** | SPA, no SSR. |
| Data fetching | **TanStack Query v5 + axios** | Every page is `useQuery`/`useMutation`; axios instance in `lib/api.ts` handles bearer token injection and 401→refresh-token retry with a request queue. |
| Forms | **react-hook-form + zod** | All auth/withdraw/KYC forms. |
| Styling | **Tailwind 3 with a custom design-token theme** | Custom classes like `avg-card`, `avg-btn-primary`, color tokens `ink`, `surface-page`, `primary`, `violet`. |
| Mocks | **MSW 2 (browser service worker)** | The entire frontend was developed against `src/mocks/handlers.ts`. Treat those handlers + `types/api.ts` as the API contract the backend must satisfy. |
| i18n | **i18next**, `en` + `ta` | Language persisted in `localStorage.avg_lang`, toggled in the Topbar. |
| Charts | **recharts** | Dashboard income area chart, network level distribution bars. |

---

## 4. Architecture

### 4.1 The two trees (most important concept in the codebase)

Every member sits in **two different trees simultaneously**:

1. **Sponsor tree** (`members.sponsor_id`) — who *referred* you. Used for the 3-generation qualification gate (BR-5 in code comments) and nothing else.
2. **Placement tree** (`members.parent_id` + `position` L/R) — where you physically sit in the binary structure. Used for everything money-related: counters, pairs, ranks.

They differ because of **spillover**: when you register under sponsor S choosing leg L, `findPlacementSlot()` walks from S down the *extreme left edge* until it finds an empty L slot. Your placement parent may be several levels below your sponsor.

Each member stores denormalized ancestry: `placement_path` (array of ancestor ids, root first) and `placement_sides` (which side of each ancestor this member falls on). These arrays are what makes fan-out O(depth) instead of a recursive query, and are guarded by a check constraint that both arrays have equal length.

### 4.2 Event-driven money pipeline

```
 HTTP API (Fastify)                         Postgres                    Redpanda topics
 ─────────────────                          ────────                    ───────────────
 POST /auth/register ──┐
 POST /webhooks/payment┴─► [txn: mutate rows + INSERT events_outbox]
                                              │
                                              ▼  (poll 100ms, FOR UPDATE SKIP LOCKED)
                                     worker: outboxRelay ───────────►  avg.member.lifecycle
                                                                       avg.counter.increments
        ┌──────────────────────────────────────────────────────────┐  avg.ledger.commands
        │                                                          │  avg.rank.events
        ▼                                                          ▼  avg.payout.events
 worker: fanout                                          worker: qualification
 (MemberActivated/Qualified/RankAchieved                 (MemberActivated → evaluate BR-5 for
  → one CounterIncrement per ancestor in                  member, sponsor, grand-sponsor;
  placement_path, deterministic uuidv5 ids)               may emit MemberQualified)
        │
        ▼ avg.counter.increments (partitioned by ancestor_id)
 worker: counterPair
 (locks member_counters row, bumps left/right active/qualified,
  appends leg_activations, mints pairs where min(L,R) > pairs_matched,
  emits PairMatched + RankEvalRequested)
        │                                    │
        ▼ avg.ledger.commands                ▼ avg.rank.events
 worker: ledger                       worker: rank
 (creditPairBonus: double-entry       (evaluateRanks: walk levels 1→12 in
  ledger txn, cap check against        order, insert rank_achievements,
  open cutoff, split wallet vs         emit RankAchieved — which loops back
  deferred; sweepDeferred on new       through fanout for levels 4–11)
  window)
 
 worker: cutoff    — cron Sat 18:00 IST: close window, open next, emit DeferredSweepRequested per member
 worker: payout    — cron Sat 18:30 IST: build payout batch, debit wallets, write bank CSV to backend/out/payouts/
 worker: reconciler— cron 02:00 IST: sample-recompute counters/pairs/balances from source-of-truth tables, alert on drift
```

**Every consumer is idempotent** via the `processed_events (consumer_group, event_id)` table, and every state change that must produce an event does so through `writeOutbox()` in the same transaction. Fan-out increments use *deterministic* uuidv5 ids (`source_event_id:ancestor_id`) so redelivery dedupes cleanly downstream.

### 4.3 Double-entry ledger

`accounts` (member wallet, member deferred_bonus, and four system accounts: bonus_expense, payout_clearing, tds_payable, bank) + `ledger_txns` + `ledger_entries`. `postLedgerTxn()` in `workers/ledger.ts` enforces sum(debits) === sum(credits) > 0 and is idempotent on an idempotency key. `wallet_balances` is a materialized running balance updated in the same transaction; the reconciler cross-checks it nightly against SUM(ledger_entries).

**Pair bonus flow:** D bonus_expense ₹1,000 → C wallet (up to the weekly cap room) + C deferred_bonus (overflow).
**Payout flow:** D wallet gross → C payout_clearing net + C tds_payable tds; on bank settlement, D payout_clearing → C bank; on failure, D payout_clearing → C wallet (re-credit).

### 4.4 Frontend architecture

- `main.tsx` conditionally boots MSW when `VITE_USE_MOCKS === 'true'`, then renders `App`.
- `App.tsx` wires TanStack Query + react-router. `/login` and `/register` are public; everything else nests under `AppShell` (Sidebar + Topbar + Outlet). **Note: `routes/guard.tsx` defines `RequireAuth` but it is never used — no route is actually protected.**
- `lib/auth.ts`: access token in memory, refresh token in `localStorage.avg_refresh`, `me` object in memory.
- `lib/api.ts`: axios instance; request interceptor attaches bearer; response interceptor performs single-flight refresh on 401 with a wait-queue, redirects to `/login?reason=session_expired` on failure.
- Every data page uses `useQuery` with **mock data as `placeholderData`** — so pages render instantly with fake numbers and then (in theory) swap to real data. Several pages never left the mock stage at all (see GAPS G-11).

---

## 5. Key design decisions and their reasoning

1. **Counters over recomputation.** `member_counters` is a hot denormalized row per member (fillfactor 70 for HOT updates). Recomputing left/right active counts from the tree on every read would be O(subtree); instead each activation fans out one increment per ancestor. `leg_activations (ancestor_id, side, seq)` records *which* member was the Nth activation on each side, which is what lets pair minting name the exact left/right members forming pair N.
2. **Pair minting is pure arithmetic**: `newPairs = min(leftActive, rightActive) − pairsMatched`, executed under a row lock, with a DB check constraint backstopping the invariant. Deterministic and replay-safe (`ON CONFLICT (member_id, sequence_no) DO NOTHING`).
3. **Cap enforcement at credit time, not payout time.** The ledger worker consults the open cutoff's `cutoff_earnings` row under lock and splits the credit between wallet and deferred. A DB check (`earned <= 100000.00`) backstops it.
4. **Rank evaluation is strictly ordered** (level N can only be achieved after N−1; the loop `break`s at the first unmet level), and rank achievements for levels 4–11 fan back out as `rank_achiever` counter increments to power the level 5–12 gates.
5. **One squashed commit** — the git history carries no archaeology; this document and the code are all you have.
6. **The frontend mock layer is the contract.** `frontend/src/mocks/handlers.ts` + `frontend/src/types/api.ts` define exactly what every page expects. When connecting the backend, make the backend speak *that* dialect rather than editing 15 pages (this is the strategy `INTEGRATION.md` takes).

---

## 6. Critical paths — what is load-bearing

**Do not change casually (money and tree invariants):**
- `backend/src/workers/counterPair.ts` — pair minting. A bug here mints or loses real money.
- `backend/src/workers/ledger.ts` — `postLedgerTxn`, cap split, sweep. Double-entry integrity lives here.
- `backend/src/services/placement.ts` — tree placement, `placement_path`/`placement_sides` construction, slot-conflict retry. A wrong path corrupts every downstream counter for that member forever.
- `backend/src/lib/money.ts` — every rupee flows through these four functions.
- `backend/db/migrations/*.sql` — constraints ARE the safety net (unique placement slot, single root, single open cutoff, pairs ≤ min(L,R), balance ≥ 0). Never weaken a constraint to "make an error go away".
- `backend/src/events/outbox.ts` — `writeOutbox` must stay inside the caller's transaction.

**Moderately sensitive:**
- `workers/fanout.ts` (deterministic ids), `workers/rank.ts` (ordered ladder), `workers/cutoff.ts` (window math — currently buggy, see GAPS G-6), `frontend/src/lib/api.ts` (refresh queue).

**Safe to change casually:**
- All frontend pages/components (presentation only), `i18n` JSON, `scripts/simulate.ts`, Tailwind config, `mocks/*` (but remember it doubles as the contract spec), anything in the dead-code list (GAPS G-18).

---

## 7. Surprises and non-obvious things that will trip you up

1. **The frontend and backend disagree on ~15 endpoints/shapes and even on the port** (backend defaults to 3000; the frontend's `.env.example` points at 4000). Nothing works end-to-end until you follow `INTEGRATION.md`.
2. **"Directs" is ambiguous.** Direct *referrals* live in the sponsor tree; direct *children* live in the placement tree. The qualification gate uses sponsor; counters use placement. Mixing these up produces subtly wrong numbers, not errors.
3. **The API server alone does almost nothing.** Registration and order confirmation only write rows + outbox events. Without `outboxRelay`, `fanout`, `counterPair`, `qualification`, `ledger`, and `rank` workers all running, dashboards stay at zero forever. There is no single "start everything" command — each worker is its own `npm run worker:*` process.
4. **`creditPairBonus` throws if there is no open cutoff window.** Always run `npm run seed` (which calls `ensureCutoffExists`) before generating any activity.
5. **BIGINT columns come back from `pg` as strings** on purpose (see comment in `lib/db.ts`). Convert with `BigInt(...)` explicitly; never `parseInt` money.
6. **Amounts cross the wire in different units**: DB stores NUMERIC rupees, backend logic uses bigint paise, the frontend contract uses *number paise* (`balancePaise` etc.), and the current backend wallet POST expects *rupees*. This unit mismatch is one of the integration bugs.
7. **The webhook idempotency scheme is unusual**: `POST /webhooks/payment` matches `gatewayEventId` against the *order's own* `idempotency_key`, so the "gateway" must echo back the key returned by `POST /orders` as `paymentIntent`. There is no real payment gateway integrated; there is also no signature verification (GAPS G-2).
8. **Rank names differ by layer**: backend `domain/ranks.ts` says "Rank 1…12" with reward strings; the frontend expects marketing names ("Starter Achiever", …, "Royal Achiever") and pulls display names from i18n keys `ranks.l1..l12`.
9. **Weekly window math has a drift bug** — the code comments say windows run Sunday 18:00 → Saturday 17:59 IST, but `nextWindowStart()` actually produces a start one day earlier each successive week (GAPS G-6).
10. **`frontend/src/components/dashboard/` and `src/data/mockData.ts` are dead** — a first-draft dashboard superseded by `pages/Dashboard.tsx`. Editing them changes nothing on screen.
11. **Payout CSVs and reconciliation alerts are written to the backend filesystem** (`backend/out/…`), not to any storage service.
12. **Tests need infrastructure**: `npm test` in backend runs the money unit tests fine, but the integration suite requires docker compose (Postgres+Redpanda+Redis) up, migrations applied, and root seeded — otherwise tests silently short-circuit (`if (!rootRows[0]) return`).
