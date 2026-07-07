# CLAUDE.md — Operational guide for this repo

Monorepo: `backend/` (Fastify + Postgres + Redpanda/Kafka + Redis, event-driven MLM engine) and `frontend/` (React 19 + Vite member portal, currently mock-driven).

- **PROJECT.md** — architecture, the two-trees concept, event pipeline, critical paths. Read before touching backend logic.
- **GAPS.md** — every known bug/weakness with file paths and scoped fixes, ordered by severity. Check it before "discovering" a bug.
- **INTEGRATION.md** — exact, ordered, copy-paste steps to connect frontend to backend. Follow it verbatim; do not improvise.

## Commands

Backend (run from `backend/`):
```bash
docker compose up -d          # Postgres 16 (5432), Redpanda (9092), Redis (6379)
npm install
npm run migrate               # apply db/migrations/*.sql in filename order
npm run topics                # create Kafka topics (idempotent)
npm run seed                  # create root member (phone 9999999999 / Root@1234) + open cutoff window
npm run dev                   # API server (tsx watch). Default PORT=3000
npm run worker:outbox         # each worker is a separate process — run in its own terminal:
npm run worker:fanout
npm run worker:counter
npm run worker:qualification
npm run worker:ledger
npm run worker:rank
npm run worker:cutoff         # weekly window scheduler (also needed so an open window exists)
npm run worker:payout         # Saturday payout batcher (optional in dev)
npm run worker:reconciler     # nightly drift check (optional in dev)
npm test                      # vitest; unit tests always pass, integration needs docker+migrate+seed
npm run simulate 50           # register+activate 50 fake members under root
npm run build                 # tsc
```

Frontend (run from `frontend/`):
```bash
npm install
npm run dev        # Vite on http://localhost:5173
npm run build      # tsc -b && vite build
npm run lint       # oxlint
```

There is no deploy pipeline and no CI. Nothing runs automatically.

## Conventions this codebase actually follows

- **Money:** integer **bigint paise** in all backend logic (`lib/money.ts`: `toPaise`, `fromPaise`, `pct` floor, `pctRoundUp` half-up). DB columns are NUMERIC(14,2) rupees. Frontend contract uses `number` paise with field names ending `Paise`. Never do arithmetic on `Number` rupees.
- **DB access:** raw SQL via `pg` — no ORM. Multi-statement writes go through `withTxn(async c => …)`. BIGINTs arrive as strings; convert with `BigInt()`.
- **Events:** any state change that must notify the pipeline calls `writeOutbox(c, event)` **inside the same transaction**. Never call the Kafka producer directly from API routes. New event types go in `events/types.ts` + a routing case in `events/outbox.ts`.
- **Idempotency:** every Kafka consumer checks/records `processed_events (consumer_group, event_id)`. Fan-out increment ids are deterministic uuidv5 of `sourceEventId:ancestorId` — preserve this; it is what makes at-least-once delivery safe.
- **Errors (backend):** throw `Error` with a `statusCode` property; route handlers map 404/409, else 500. Zod `safeParse` on every request body, `400` with `error.flatten()`.
- **Naming:** DB snake_case; API JSON camelCase; the mapping is done by hand in each route.
- **Frontend data:** every page = TanStack Query `useQuery`/`useMutation` against the axios instance in `lib/api.ts` (never raw fetch/axios — the instance carries auth + refresh). Types come from `src/types/api.ts`. Forms = react-hook-form + zod. Text through i18next `t()` with keys in `i18n/en.json` **and** `ta.json` (add both).
- **Styling:** Tailwind with custom tokens (`ink`, `ink-muted`, `surface-page`, `surface-line`, `primary`, `violet`, `success`, `warning`, `danger`) and utility classes `avg-card`, `avg-btn-primary` defined in `index.css`. Reuse `components/ui/*` (StatCard, DataTable, Badge, Modal, Skeleton, EmptyState, FormField, Tabs) before writing new primitives.

## Gotchas

- **Two trees.** `sponsor_id` (who referred you — used ONLY for the 3-generation qualification gate) vs `parent_id`+`position` (binary placement — used for all counters/pairs/ranks). Picking the wrong tree gives wrong numbers, not errors.
- **The API server alone appears "broken".** Counters/pairs/wallet only move when the outbox relay + workers are running. If a dashboard stays at zero after activity, start the workers.
- **No open cutoff window ⇒ ledger worker throws.** Run `npm run seed` (calls `ensureCutoffExists`) before generating pairs.
- **Ports disagree by default:** backend listens on 3000; frontend `.env.example` points to 4000. INTEGRATION.md standardizes on 3000.
- **`frontend/src/mocks/handlers.ts` + `types/api.ts` are the API contract.** When backend and frontend disagree, the mock shape wins — change the backend.
- **`placeholderData: mock…` everywhere:** pages render fake data instantly; don't be fooled that an endpoint "works" just because the page shows numbers. Verify in the Network tab.
- **Dead code traps:** `frontend/src/components/dashboard/*`, `src/data/mockData.ts`, `layout/Header.tsx`, `layout/Layout.tsx` are unused. `src/mocks/data.ts` is the live one.
- **`/dev/simulate-payment` and `GET /orders/:id` exist only in mocks** until INTEGRATION.md step 3 is applied.
- **Fastify throws on duplicate route registration** — you cannot register a second handler for an existing method+path; replace the module registration instead (this is why INTEGRATION.md swaps route modules rather than adding overrides).
- **Known-buggy areas (see GAPS.md before "fixing" symptoms):** cutoff window drift (G-6), right-leg rank counter first-insert (G-5), failed payments marked `paid` (G-7), withdrawals not ledger-connected (G-4).

## Rules

- **Never weaken a database constraint to silence an error.** The constraints (unique placement slot, single root, single open cutoff, `pairs_matched <= LEAST(l,r)`, `balance >= 0`, `earned <= cap`) are the last line of defense for real money.
- **Never edit an applied migration file.** Add a new numbered file `NNN_name.sql`; `db/migrate.ts` tracks applied names in `schema_migrations`.
- **Money-critical files require a test with any change:** `workers/counterPair.ts`, `workers/ledger.ts`, `workers/payout.ts`, `services/placement.ts`, `lib/money.ts`.
- **`writeOutbox` must stay inside the caller's transaction**; producers other than `outboxRelay` should not publish lifecycle/ledger events directly (fanout publishing increments is the one sanctioned exception).
- **All amounts crossing the API boundary are integer paise** with `…Paise` field names. Do not introduce rupee floats in JSON.
- **Auth-required routes** must use the `app.authenticate` preHandler; admin routes must additionally check role once G-3 is fixed.
- `frontend/public/mockServiceWorker.js` is **generated** by MSW — never hand-edit.
- Don't commit `.vite/`, `backend/out/`, or `.env` files.
