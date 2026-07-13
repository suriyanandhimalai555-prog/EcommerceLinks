# CLAUDE.md — Operational guide for this repo

Monorepo: `backend/` (Fastify + Postgres + Redis Streams, event-driven MLM engine) and `frontend/` (React 19 + Vite member portal).

- **PLAN.md** — **the governing plan (Phases 1–8 + §2A transport spec).** Architecture, Railway deployment design, and the mandatory order of all work. When any other doc disagrees with it about direction, PLAN.md wins. Read it before starting any structural, transport, or deployment work.
- **PROJECT.md** — architecture, the two-trees concept, event pipeline, critical paths. Read before touching backend logic.
- **GAPS.md** — every known bug/weakness with file paths and scoped fixes, ordered by severity. Check it before "discovering" a bug.
- **INTEGRATION.md** — exact, ordered, copy-paste steps to connect frontend to backend. Follow it verbatim; do not improvise.
- **STATUS.md** — what has actually been done and is running now; where it and older doc statements disagree about *status*, STATUS.md wins.

## The architecture (one paragraph)

**Modular monolith.** Fastify API (`avg-api`) takes writes and records every pipeline-relevant state change in the `events_outbox` table inside the same DB transaction. One worker process (`avg-workers`, `workers/all.ts`) runs nine loops: the outbox relay publishes outbox rows to **Redis Streams** (`XADD`); consumers (`fanout`, `counterPair`, `qualification`, `ledger`, `rank`) read via consumer groups (`XREADGROUP`/`XACK`/`XAUTOCLAIM`) and are idempotent through `processed_events`; three timer loops (`cutoff`, `payout`, `reconciler`) run internal Asia/Kolkata schedulers. **Postgres is the source of truth and the durable event log; Redis is transport + rate limiting — losing Redis loses no data.** Deployment: Railway (Singapore) — `avg-api` + `avg-workers` + Postgres/Redis plugins; frontend is a static Vite build on Cloudflare Pages. Full spec: PLAN.md §2A and §5.

**Build state:** the transport migration (PLAN.md §2A) is **complete**. `lib/streams.ts` is the transport; `workers/all.ts` consolidates all nine loops. The legacy broker files (kafka.ts, createTopics.ts, docker-compose.yml, kafkajs) have been deleted. CI and Railway deployment are the next steps (PLAN.md Phase 7 steps ① and ⑧).

**Mandatory execution order (PLAN.md Phase 7 — do not reorder):** ~~① CI first~~ ~~② transport build per §2A~~ → **next: ① CI** (GitHub Actions gating `main`) → ③ gap fixes (~~G-3 done~~, G-7+webhook auth, G-5, G-6, G-4, each with tests) → ④ structural alignment (one folder per commit) → ⑤ index migration + EXPLAIN baselines → ⑥ logging/pagination/rate-limit/contract tests → ⑦ INTEGRATION.md verbatim → ⑧ staging then production. Restructuring before CI exists is prohibited.

**Decisions already made — do not re-litigate or "improve":**

- **Redis is load-bearing, never optional.** Redis Streams *is* the event transport (plus rate limiting). Removing it removes the event architecture.
- **No ORM and no repository layer**, especially over the money paths (`counterPair`, `ledger`, `placement`, outbox relay). The explicit `SELECT … FOR UPDATE` / `SKIP LOCKED` / `withTxn` code is what makes the system correct; abstractions that hide locking and transaction boundaries are rejected. SQL stays visible at its call site.
- **No big-bang `modules/*/{controller,service,repository}` restructure.** The existing layout (`api/` routes = controllers, `services/` = services, `workers/` = jobs, `lib/` = utils) already implements the template's layering. Only targeted alignment: extract `src/middleware/` (authenticate, errorHandler, rateLimit), co-locate Zod `*.schemas.ts` beside route modules, delete dead code — and only after CI exists.
- **Route handlers are HTTP-only** (parse → call service → map response). Any SQL found in a handler moves into `services/`.
- **Also intentionally NOT added:** any other broker/queue, PgBouncer, read replicas, sharding, ltree/materialized-path trees, GraphQL, a caching layer (except one measured Redis exception in PLAN.md Phase 6), Next.js/SSR. Each solves a >100k-user problem. See PLAN.md Phase 8 before proposing any of them.

## Commands

Backend (run from `backend/`). Local infra: Postgres 16 + Redis 7 (native install — no Docker required).

```bash
npm install
npm run migrate               # apply db/migrations/*.sql in filename order
npm run seed                  # create root member (login root@avg.com / Root@1234) + open cutoff window
npm run seed:management       # create the off-tree management@avg.com master account (role=management) and demote root to member
npm run dev                   # API server (tsx watch). Default PORT=3000
npm run dev:workers           # ALL nine worker loops in one process (tsx, hot-reload)
npm run start:api             # compiled API (node dist/src/api/server.js)
npm run start:workers         # compiled workers (node dist/src/workers/all.js)
npm run worker:outbox         # …individual loops, for debugging one worker at a time:
npm run worker:fanout         #    (never run alongside start:workers — shared consumer groups)
npm run worker:counter
npm run worker:qualification
npm run worker:ledger
npm run worker:rank
npm run worker:cutoff         # also needed solo so an open cutoff window exists
npm run worker:payout
npm run worker:reconciler
npm test                      # vitest; unit tests always pass, integration needs infra+migrate+seed
npm run simulate 50           # register+activate 50 fake members under root
npm run build                 # tsc → dist/
```

Frontend (run from `frontend/`):
```bash
npm install
npm run dev        # Vite on http://localhost:5173
npm run build      # tsc -b && vite build
npm run lint       # oxlint
```

There is no CI or deploy pipeline **yet**. Building CI (GitHub Actions gating `main`) is step ① of PLAN.md — nothing structural moves until it is green. Target deployment is Railway per PLAN.md §5.

## Conventions this codebase actually follows

- **Money:** integer **bigint paise** in all backend logic (`lib/money.ts`: `toPaise`, `fromPaise`, `pct` floor, `pctRoundUp` half-up). DB columns are NUMERIC(14,2) rupees. Frontend contract uses `number` paise with field names ending `Paise`. Never do arithmetic on `Number` rupees.
- **DB access:** raw SQL via `pg` — no ORM, no repository layer (decided; see above). Multi-statement writes go through `withTxn(async c => …)`. BIGINTs arrive as strings; convert with `BigInt()`.
- **Events:** any state change that must notify the pipeline calls `writeOutbox(c, event)` **inside the same transaction**. Never `XADD` to a stream directly from API routes — only `outboxRelay` publishes (sanctioned exceptions: fanout's direct increment `publishToStream`, and the admin DLQ replay endpoint re-delivering an already-published event). New event types go in `events/types.ts` + a routing case in `events/outbox.ts`. Stream keys and consumer groups are in PLAN.md §2A.
- **Idempotency:** every consumer checks/records `processed_events (consumer_group, event_id)`. Fan-out increment ids are deterministic uuidv5 of `sourceEventId:ancestorId` — preserve this; it is what makes at-least-once delivery (and `XAUTOCLAIM` re-delivery) safe.
- **Errors (backend):** throw `Error` with a `statusCode` property; route handlers map 404/409, else 500. Zod `safeParse` on every request body, `400` with `error.flatten()`.
- **Naming:** DB snake_case; API JSON camelCase; the mapping is done by hand in each route.
- **Frontend data:** every page = TanStack Query `useQuery`/`useMutation` against the axios instance in `lib/api.ts` (never raw fetch/axios — the instance carries auth + refresh). Types come from `src/types/api.ts`. Forms = react-hook-form + zod. Text through i18next `t()` with keys in `i18n/en.json` **and** `ta.json` (add both).
- **Styling:** Tailwind with custom tokens (`ink`, `ink-muted`, `surface-page`, `surface-line`, `primary`, `violet`, `success`, `warning`, `danger`) and utility classes `avg-card`, `avg-btn-primary` defined in `index.css`. Reuse `components/ui/*` (StatCard, DataTable, Badge, Modal, Skeleton, EmptyState, FormField, Tabs) before writing new primitives.

## Gotchas

- **Two trees.** `sponsor_id` (who referred you — used ONLY for the 3-generation qualification gate) vs `parent_id`+`position` (binary placement — used for all counters/pairs/ranks). Picking the wrong tree gives wrong numbers, not errors. **Since the 2-referral cap** (July 2026): registration places the new member directly under their sponsor (first referral → L, second → R, third → 409), so `parent_id = sponsor_id` for all new rows and the trees coincide going forward — but both columns remain, and pre-cap data may still have `sponsor_id ≠ parent_id`.
- **The API server alone appears "broken".** Counters/pairs/wallet only move when the outbox relay + workers are running. If a dashboard stays at zero after activity, start the workers.
- **No open cutoff window ⇒ ledger worker throws.** Run `npm run seed` (calls `ensureCutoffExists`) before generating pairs.
- **Ports disagree by default:** backend listens on 3000; frontend `.env.example` points to 4000. INTEGRATION.md standardizes on 3000.
- **`frontend/src/types/api.ts` is the API contract and the regression oracle for all restructuring** (the MSW mocks that used to co-own this role have been deleted). When backend and frontend disagree, the contract type wins — change the backend. During structural moves, route URLs and JSON shapes must stay byte-identical.
- **Don't trust a page showing numbers** — verify the endpoint actually responds in the Network tab before declaring it "works".
- **Dead code traps:** `frontend/src/components/dashboard/*`, `src/data/mockData.ts`, `layout/Header.tsx`, `layout/Layout.tsx` are unused (scheduled for deletion in their own commit per PLAN.md Phase 3; `src/mocks/` has already been deleted). Backend legacy transport files are likewise deletion-only (PLAN.md §2A checklist).
- **Fastify throws on duplicate route registration** — you cannot register a second handler for an existing method+path; replace the module registration instead (this is why INTEGRATION.md swaps route modules rather than adding overrides).
- **Known-buggy areas (see GAPS.md before "fixing" symptoms):** withdrawals not ledger-connected (G-4), right-leg rank counter first-insert (G-5), cutoff window drift (G-6), failed payments marked `paid` + unauthenticated payment webhook (G-7/G-2 — one work item). G-3 (admin role checks) is FIXED — see the roles gotcha below.
- **Three-tier roles (since migration 016):** `management` (off-tree master account `management@avg.com` — parent_id NULL, empty placement path, excluded from `uq_single_root`, the only account that can grant/revoke `admin`) → `admin` (appointed member-staff) → `member`. The tree root `root@avg.com` is a plain member, NOT an admin. `members.blocked` gates login/refresh (blocking also revokes refresh tokens); it is deliberately not `is_active`, which belongs to the money pipeline — `registerMember` itself rejects management sponsors (409). Frontend role logic goes through `frontend/src/lib/roles.ts` (`isStaff`/`isManagement`/`homeFor`) — don't compare role strings inline.

## Rules

- **Never weaken a database constraint to silence an error.** The constraints (unique placement slot, single root — since migration 016 scoped as single **tree** root: `uq_single_root … WHERE parent_id IS NULL AND role <> 'management'` — single open cutoff, `pairs_matched <= LEAST(l,r)`, `balance >= 0`, `earned <= cap`) are the last line of defense for real money.
- **Never edit an applied migration file.** Add a new numbered file `NNN_name.sql`; `db/migrate.ts` tracks applied names in `schema_migrations`.
- **Destructive schema changes ship in two releases:** add-and-backfill first, constrain/drop in the next — any deploy must be able to roll back one version.
- **Money-critical files require a test with any change:** `workers/counterPair.ts`, `workers/ledger.ts`, `workers/payout.ts`, `services/placement.ts`, `lib/money.ts`.
- **`writeOutbox` must stay inside the caller's transaction**; producers other than `outboxRelay` should not publish lifecycle/ledger events directly (sanctioned exceptions: fanout publishing increments, and the admin DLQ replay re-delivering an already-published event).
- **Follow PLAN.md's execution order.** No structural moves before CI exists; one folder per commit; `npm run build` + `npm test` after each; docs updated in the same PR as the change they describe.
- **All amounts crossing the API boundary are integer paise** with `…Paise` field names. Do not introduce rupee floats in JSON.
- **Auth-required routes** must use the `app.authenticate` preHandler; `/admin/*` routes must use `app.requireAdmin` (live DB role lookup, accepts `admin` and `management`) and write `admin_audit_log` for every mutation.
- Don't commit `.vite/`, `backend/out/`, or `.env` files.
