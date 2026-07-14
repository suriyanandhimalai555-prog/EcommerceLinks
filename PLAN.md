# PLAN.md — AVG Restructuring Plan (Phases 1–8, with Architect's Corrections)

**This is the governing plan for all restructuring, transport, and deployment work in this repo.** When any other doc disagrees with it about architecture direction, this plan wins.

**The architecture is: modular monolith on Railway, Postgres as source of truth, Redis Streams as the event transport.** There is exactly one event architecture in this system — transactional outbox → Redis Streams → idempotent workers. The repo still contains legacy transport files from an earlier broker-based setup; §2A ends with the checklist that deletes them. No new code may import or extend them.

**Target:** ~30,000 users maximum, gradual growth, solo-maintainable, Railway-hosted.
**Priority order honored throughout:** maintenance > deployment > debugging > reasonable scaling > cost.
**Execution environment:** this plan is written to be executed by Claude Code against the local working copy.

**Three deliberate decisions — read these first, do not re-litigate:**

1. **Redis stays, and is load-bearing.** Redis Streams *is* the event transport. The pair-matching pipeline — counters, pairs, ledger, ranks — runs on it. Removing Redis means removing the event architecture. It additionally serves rate limiting and (later, if measured) caching. This is not "adding Redis"; it is the backbone.
2. **No big-bang controller/service/repository restructure.** Physically moving every file into `modules/*/{controller,service,repository}` would touch ~100% of a money-handling codebase that currently has **no CI** — the maximum-risk move for the minimum benefit. The existing layout already implements the same layering under different names (§3 mapping table). The plan does targeted alignment, not wholesale relocation, and only after CI exists.
3. **No repository layer over the money paths.** The SQL in `counterPair`, `ledger`, `placement`, and the outbox relay is deliberately explicit about locking (`SELECT … FOR UPDATE`, `SKIP LOCKED`) and transaction boundaries (`withTxn`). A generic repository abstraction hides exactly the two things that make this system correct. Query code stays visible at its call site, organized per module — separation happens by file, not by abstraction.

---

## PHASE 1 — Current system understanding (verified against code + repo docs)

**Monorepo:** `backend/` + `frontend/`, operational docs (`CLAUDE.md`, `PROJECT.md`, `GAPS.md`, `INTEGRATION.md`, `STATUS.md`) that must stay accurate (Phase 7 includes updating them).

**Backend:** Fastify + TypeScript, raw SQL via `pg` (no ORM), Zod on every request body. Event-driven core: any state change writes to `events_outbox` inside the same transaction (`writeOutbox`); the outbox relay publishes to Redis Streams; consumers are idempotent via `processed_events (consumer_group, event_id)`. Worker inventory (audited, one by one):

| Worker | Kind | Notes |
|---|---|---|
| outboxRelay | producer | `FOR UPDATE SKIP LOCKED` poll → `XADD` → stamp `published_at` |
| fanout | consumer (per-event) | lifecycle → per-ancestor CounterIncrements; **also direct-publishes** (sanctioned exception) |
| counterPair | consumer (batch) | per-ancestor grouping, one txn per ancestor, `FOR UPDATE` on counters — the hot path (counters/ranks only; income minting removed in migration 020) |
| pairComplete | consumer (per-event) | 3rd group on lifecycle stream: on MemberActivated, parent-row `FOR UPDATE`, both-directs-active check, emits PairCompleted (the income trigger since 020) |
| qualification | consumer (per-event) | 2nd group on lifecycle stream |
| ledger | consumer (per-event) | money writes; per-event txn atomicity is the contract |
| rank | consumer (per-event) | rank ladder |
| cutoff, payout, reconciler | timer-driven | weekly window scheduler, Saturday payout batcher, nightly drift check |

**Frontend:** React 19 + Vite + TanStack Query + react-hook-form/Zod + i18next (en+ta) + Tailwind tokens + `components/ui/*` primitives. `mocks/handlers.ts` + `types/api.ts` are the API contract; INTEGRATION.md holds the exact connection steps.

**Database:** Postgres 16, append-only numbered migrations tracked in `schema_migrations`. Money as NUMERIC(14,2) rupees in columns / bigint paise in logic. Two-trees model: `sponsor_id` (qualification only) vs `parent_id`+`position` (all counting). Integrity constraints (unique slot, single root, single open cutoff, `pairs_matched <= LEAST(l,r)`, `balance >= 0`, `earned <= cap`) are the last line of defense and are never weakened.

**Auth:** JWT access+refresh; `app.authenticate` preHandler; ~~G-3 open: admin routes lack role checks~~ **G-3 FIXED** — `app.requireAdmin` (live DB role lookup; three-tier roles `management`/`admin`/`member` since migration 016, see STATUS.md 2026-07-12). Other known gaps: G-4 withdrawals not ledger-connected, G-5 right-leg rank counter first-insert, G-6 cutoff window drift, G-7 failed payments marked `paid`.

**Background jobs:** the nine workers above; no cron infrastructure needed (cutoff/payout/reconciler carry internal schedulers, timezone-correct for Asia/Kolkata).

**File uploads:** none yet (KYC/receipts are a known future need — Cloudflare R2, `lib/storage.ts`).

**Third-party integrations:** payment webhook exists (currently unauthenticated — treat with G-7 as one work item). No email/SMS provider wired yet.

**Env vars:** `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET` (dev default present — must be rotated), `PORT`, money params (`PAIR_BONUS_PAISE`, `CUTOFF_CAP_PAISE`, `GST_PCT`, `TDS_PCT`, `MIN_PAYOUT_PAISE`).

**Deployment config:** none yet — no CI, no pipeline. Building both is what this plan does.

---

## PHASE 2 — Architecture decision

**Modular monolith, three deployed services + two Railway plugins.** No microservices, no Kubernetes, no brokers or queues of any kind beyond Redis Streams.

| Service | What | Why it's separate |
|---|---|---|
| `frontend` | Vite static build on **Cloudflare Pages** (₹0, Chennai edge) — or Railway static if one-dashboard matters more | different deploy cadence; static ≠ compute |
| `avg-api` | Fastify: auth, REST, business writes via outbox | user-facing latency isolated from batch work |
| `avg-workers` | one process, all nine loops (`workers/all.ts`) | pipeline restarts/deploys must not drop API traffic; genuinely different failure domain |
| Postgres plugin | source of truth + durable event log (`events_outbox`) | managed |
| Redis plugin | Streams transport + rate limit | see decision #1 |

At 30k users this is the ceiling of topology. The only future split (workers → pipeline + schedulers) is a start-command change, not a code change.

---

## PHASE 2A — Event transport: Redis Streams (build spec)

This section is the implementation spec for the transport. It is what `avg-workers` runs on. **Postgres (`events_outbox`) is the durable event log; Redis Streams is transport only** — losing Redis loses no data, because unpublished/republishable events live in Postgres and consumers are idempotent.

**`lib/streams.ts`** (new; replaces the legacy client wrapper) built on the existing ioredis singleton in `lib/redis.ts`:

- `publish(stream, event)` → `XADD <stream> MAXLEN ~ 1000000 * event <json>` (approximate trimming; the outbox is the permanent record).
- `consume({ stream, group, consumer, count, handler })` → loop of `XREADGROUP GROUP <group> <consumer> COUNT <n> BLOCK 5000 STREAMS <stream> >`, call handler, then `XACK`. Ack **after** the handler's DB transaction commits — at-least-once delivery, dedup in `processed_events`.
- Group bootstrap: `XGROUP CREATE <stream> <group> $ MKSTREAM` at consumer startup, swallowing BUSYGROUP (idempotent; this replaces the standalone topic-creation script entirely).
- Recovery: on startup and every ~60s, `XAUTOCLAIM <stream> <group> <consumer> 60000` to take over pending entries from crashed consumers and re-run them through the same handler. Safe because idempotency is in Postgres, not in the transport.

**Streams** (keep the existing logical names from `events/topics.ts`; the partition counts disappear — one stream each, plain FIFO):

| Stream key | Producer | Consumer groups |
|---|---|---|
| `avg.member.lifecycle` | outboxRelay | `avg-fanout`, `avg-qualification`, `avg-pair-complete` |
| `avg.counter.increments` | fanout (direct `XADD` — sanctioned non-relay producer) | `avg-counter-pair` |
| `avg.pair.matched` | *(unused since migration 020 — PairMatched removed; constant kept in topics.ts, delete with dead code in Phase 3)* | — |
| `avg.ledger.commands` | outboxRelay + fanout (direct `XADD` of PairBonusAccrued — sanctioned) | `avg-ledger` |
| `avg.rank.events` | outboxRelay | `avg-rank` |
| `avg.payout.events` | outboxRelay | (audit/consumed by payout tooling) |

**Invariants that carry over unchanged (do not renegotiate):**
- `writeOutbox(c, event)` inside the caller's transaction; only `outboxRelay` publishes (fanout's publishing of increments and pair-bonus accruals is the exception).
- Every consumer checks/records `processed_events (consumer_group, event_id)` — keep the exact group names above; they are the dedup keyspace.
- Fan-out ids (increments and pair-bonus accruals) stay deterministic uuidv5 of `sourceEventId:ancestorId`/`sourceEventId:beneficiaryId` — this is what makes at-least-once delivery and `XAUTOCLAIM` re-delivery safe.
- `counterPair` keeps batch semantics: read COUNT ≈ 500, group by ancestor, one txn per ancestor, `XACK` per entry after its txn commits. Ordering guarantees needed are per-stream FIFO only; final serialization happens at the DB via `FOR UPDATE`.

**`workers/all.ts`** (new): starts all nine loops in one process; on SIGTERM stops reading, drains in-flight handlers, closes pg pool and redis, exits 0. `package.json` gains `start:api` (node `out/api/server.js`) and `start:workers` (node `out/workers/all.js`); the per-worker `worker:*` scripts remain for debugging a single loop locally.

**Verification (local, before anything depends on it):** native Postgres 16 + Redis 7 → `npm run migrate && npm run seed` → `npm run dev` + `npm run start:workers` → `npm run simulate 50` → counters, pairs, wallet all move; reconciler reports no drift; `npm test` green.

**Legacy transport deletion checklist** — the earlier broker-based transport is dead; this checklist is the *only* place its artifacts are named, so they can be removed. Delete, in one commit, after the above verification passes:

- [x] `backend/src/lib/kafka.ts`
- [x] `backend/scripts/createTopics.ts` and the `"topics"` script in `backend/package.json`
- [x] the `kafkajs` dependency in `backend/package.json`
- [x] the `KAFKA_BROKERS` entry in `backend/src/config.ts` and all `.env*` files
- [x] `backend/docker-compose.yml` (local dev uses native Postgres 16 + Redis 7; prod uses Railway plugins)
- [x] any remaining doc/script line referencing the deleted files

---

## PHASE 3 — Codebase structure: alignment, not upheaval

The template's target and the current reality are the same architecture wearing different clothes:

| Template concept | Already exists as | Action |
|---|---|---|
| `modules/x/routes` + `controller` | route modules (Fastify handlers doing HTTP-only: parse → call service → map response) | keep; enforce "HTTP-only" in review — any handler containing SQL moves that SQL into `services/` |
| `modules/x/service` | `services/` (placement, qualification, …) | keep |
| `modules/x/repository` | inline SQL at call sites via `pg` + `withTxn` | **deliberately not adopted** (decision #3) |
| `modules/x/validation` | Zod schemas per route | co-locate: one `*.schemas.ts` beside each route module |
| `modules/x/types` | `events/types.ts` + per-file types | keep; shared API types stay mirrored with `frontend/src/types/api.ts` |
| `middleware/` | auth preHandler + error mapping registered in server setup | extract into `src/middleware/{authenticate.ts, errorHandler.ts}` — small, real win for debugging |
| `config/` | `src/config.ts` | keep single-file until it exceeds ~150 lines |
| `jobs/` | `src/workers/` | keep name; it's accurate and documented everywhere |
| `database/` | `db/migrations/` + `lib/db.ts` | keep |
| `utils/` | `lib/` (money, redis, streams) | keep name |

**Target tree (delta from current marked `←`):**

```
backend/src/
├── config.ts
├── middleware/            ← extracted: authenticate.ts, errorHandler.ts, rateLimit.ts (new)
├── api/
│   ├── server.ts
│   └── routes/            ← each resource: auth.ts, members.ts, placement.ts, orders.ts,
│       …                    wallet.ts, ranks.ts, cutoff.ts, admin.ts, uploads.ts(new)
│                            + sibling *.schemas.ts (Zod)
├── services/              (business logic — unchanged)
├── events/                (types.ts, outbox.ts, topics.ts — unchanged)
├── workers/               (all.ts + nine workers)
└── lib/                   (db.ts, money.ts, redis.ts, streams.ts, storage.ts(new))
```

**Execution rules for Claude Code:** one folder per commit; after each move run `npm run build` (tsc catches every broken import) + `npm test`; route URLs and JSON shapes byte-identical (the frontend mock contract is the regression oracle); dead code deleted in its own commit (`frontend/src/components/dashboard/*`, `src/data/mockData.ts`, `layout/Header.tsx`, `layout/Layout.tsx`); update CLAUDE.md paths in the same PR as each move. **Sequencing: this entire phase happens after Phase 5's CI exists** — restructuring without a test gate is how working systems break.

---

## PHASE 4 — Database optimization (for 30k users, measured not imagined)

At 30k members the whole DB is single-digit GB. The work is indexes and pool math, nothing exotic.

**Indexes to add (one new migration, `NNN_indexes.sql`), each tied to a real query:**

```sql
-- Outbox relay polls unpublished rows constantly; partial index keeps it O(pending)
CREATE INDEX CONCURRENTLY idx_outbox_unpublished
  ON events_outbox (id) WHERE published_at IS NULL;

-- Genealogy walks: children of a node (placement tree)
CREATE INDEX CONCURRENTLY idx_members_parent ON members (parent_id);
-- Sponsor tree: direct referrals + 3-gen qualification gate
CREATE INDEX CONCURRENTLY idx_members_sponsor ON members (sponsor_id);

-- Wallet/ledger pages use keyset pagination per member
CREATE INDEX CONCURRENTLY idx_ledger_member_id_id
  ON ledger_entries (member_id, id DESC);

-- Pair history per member (dashboard)
CREATE INDEX CONCURRENTLY idx_pairs_member ON pairs (member_id, sequence_no DESC);
```

(Claude Code: before creating each, check `\di` — some may exist as constraint backings; skip duplicates. Verify actual table/column names against migrations.)

**Query patterns:** run `EXPLAIN ANALYZE` on the three heaviest reads — full downline (recursive CTE on placement tree), dashboard aggregate, admin member list — and record baselines in `RUNBOOK.md`. Recursive CTEs on 30k rows with `idx_members_parent` are milliseconds; no materialized-path or ltree rework is warranted at this scale (**intentionally not added**, Phase 8).

**Connection pooling:** Railway Postgres allows ~100 connections. Set `pg.Pool` max = 10 on the API, 10 on workers (headroom for staging + psql). No PgBouncer at this scale — it's another service to maintain for a problem we don't have. `statement_timeout = 30s` on the API pool (a runaway admin query shouldn't hold connections), none on workers (cutoff sweeps may legitimately run long).

**Migrations:** discipline already correct (append-only, tracked). Rule (also in CLAUDE.md): destructive changes ship in two releases (add-and-backfill, then constrain/drop) so any deploy can roll back one version.

---

## PHASE 5 — Deployment architecture (Railway)

| Service | Root | Build | Pre-deploy | Start | Health |
|---|---|---|---|---|---|
| `avg-api` | `backend` | `npm ci && npm run build` | `npm run migrate` | `npm run start:api` | `/health` (pg ping + redis ping + build SHA) |
| `avg-workers` | `backend` | `npm ci && npm run build` | — | `npm run start:workers` | restart-on-exit + `/health/pipeline` alert |
| `frontend` | Cloudflare Pages | `npm run build` → `dist/` | — | static | Pages built-in |
| Postgres, Redis | plugins | — | — | — | platform |

Region **Singapore**; private networking (`.railway.internal`) between services and plugins; `staging` + `production` Railway environments — staging auto-deploys `main`, production deploys a manually promoted tag (a solo operator deploys money code awake and watching). CI (GitHub Actions `ci.yml`: build + migrate + test against service containers, frontend lint+build) gates `main` via branch protection. **CI is built first in the execution order — it is the safety net every other phase stands on.**

**Environment variables (complete production set):** `DATABASE_URL`*, `REDIS_URL`* (*Railway references*), `JWT_SECRET` (fresh 256-bit), `NODE_ENV=production`, `TZ=Asia/Kolkata`, `PORT`, `CORS_ORIGIN` (exact frontend domain), `PAIR_BONUS_PAISE`, `CUTOFF_CAP_PAISE`, `GST_PCT`, `TDS_PCT`, `MIN_PAYOUT_PAISE`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `SENTRY_DSN`. Frontend: `VITE_API_URL`, `VITE_USE_MOCKS=false`.

---

## PHASE 6 — Performance improvements (practical list, in order of real impact)

1. **Error handling + logging first** (debugging is priority #3): pino structured JSON logs with a request-id; the extracted `errorHandler.ts` maps `statusCode` errors and reports everything else to Sentry with the request-id; worker loops log `{group, stream, eventId}` on every failure — this is what makes 2 AM debugging possible.
2. **Keyset pagination** on ledger, downline, and admin member lists (`?after=<id>&limit=`) backed by the Phase 4 indexes. Offset pagination degrades precisely where MLM data grows.
3. **Rate limiting** (`@fastify/rate-limit` on Redis): 5/min/IP on login+register, 100/min default. Security and performance in one middleware.
4. **Validation**: already Zod-everywhere; add response-shape checks in integration tests against `types/api.ts` (the contract).
5. **Caching — mostly don't.** The dashboard reads are indexed single-digit-ms queries at 30k users. One justified exception *if measured slow*: full-downline genealogy JSON, cached in Redis 60s keyed by member, invalidated lazily. Add only with an EXPLAIN trace proving need.
6. **API response size:** genealogy endpoints return depth-limited trees (`?depth=3` default) with lazy expansion — bounds payloads regardless of downline size, and matches how the UI renders trees anyway.

---

## PHASE 7 — Migration safety (the order of ALL work — do not reorder)

1. **CI first** (Phase 5's `ci.yml` + branch protection) — nothing else moves until green.
2. ~~**Transport build** per §2A~~ ✅ **DONE** — `lib/streams.ts` + `workers/all.ts` built; legacy broker/kafka files deleted; build clean; all 14 tests passing.
3. **Launch-blocking gap fixes:** ~~G-3 (admin roles — done 2026-07-12, requireAdmin + admin_audit_log + integration tests)~~, G-7 (failed payments + webhook auth), then G-5, G-6, G-4 per GAPS.md order. Each with a test (money-critical-file rule).
4. **Phase 3 structural alignment**, one folder per commit, build+test after each.
5. **Phase 4 index migration** + EXPLAIN baselines.
6. **Phase 6 items 1–4** (logging, pagination, rate limit, contract tests).
7. **INTEGRATION.md** executed verbatim — frontend off mocks.
8. **Phase 5 deployment:** staging up, smoke the full member journey (register → activate → counters move → pair → wallet), then production tag.

Backward compatibility oracle throughout: `frontend/src/types/api.ts` + `mocks/handlers.ts` — when backend and frontend disagree, the mock shape wins (existing rule). Docs updated in the same PR as the change they describe.

---

## PHASE 8 — Final output summary

**Before this plan:** correct event-driven core (outbox → idempotent workers) wrapped in undeployable packaging — Docker-dependent local infra, a heavyweight broker with no Railway home, nine terminal windows to run, no CI, no deploy story, four known money/security gaps, frontend disconnected on mocks.

**After this plan:** the same correct core on deployable packaging — Redis Streams transport (§2A), two Node services + two managed plugins on Railway (Singapore), static frontend on Cloudflare Pages, R2 for files, CI-gated tag deploys, domain-level pipeline monitoring, indexes and pagination sized for 30k users.

**Folder structure:** modular monolith; template vocabulary mapped onto existing layout (§3 table); only real moves are `middleware/` extraction, schema co-location, and dead-code deletion.

**Railway plan:** §5 table. **Services created:** `avg-api`, `avg-workers` (+ Pages). **Env vars:** §5 list.

**Performance work done:** partial outbox index, tree/ledger indexes, keyset pagination, pool sizing + statement timeouts, pino+Sentry+request-ids, rate limiting, depth-limited genealogy responses.

**Intentionally NOT added, and why:**
- *Kubernetes / microservices / API gateway* — three services is the whole topology; the failure domains already separate cleanly.
- *ORM (Prisma/Drizzle) or repository layer* — would hide the explicit locking that makes the money paths correct (decision #3).
- *Removing Redis* — it is the event backbone, not an optimization (decision #1).
- *A message broker or queue SaaS* — Redis Streams covers the pipeline's needs at 30k users; Postgres holds the durable log.
- *Big-bang folder restructure* — maximum churn on money code with no CI; alignment instead (decision #2).
- *PgBouncer, read replicas, sharding, ltree/materialized-path trees, GraphQL, caching layer* — each solves a >100k-user problem this system is architected to reach *later* without them.
- *Next.js/SSR* — authenticated portal, no SEO surface; static SPA on a CDN is faster and free.

**CTO's one-line summary:** the codebase's problem was never its structure — it was packaging, gaps, and the missing safety net. This plan fixes those three in that order and leaves the working core alone.
