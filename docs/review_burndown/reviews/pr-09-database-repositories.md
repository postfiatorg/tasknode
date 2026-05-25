# PR-09 Review: Database And Repositories

Date: 2026-05-25
Branch: `review/09-database-repositories`
Base: `origin/main` @ `d01d391`

## Summary

Reviewed migrations 001–044, `server/db/pool.js`, `server/db/migrate.js`, all
`server/repositories/*.js` modules, and database architecture docs. Postgres is
the durable cache for chat, billing, context, memory, tasks, Hive, Board Manager,
profile, and PFTL projection data. Migrations are ordered, idempotent via
`tasknode_schema_migrations`, and applied cleanly in local Docker. Repositories
consistently use parameterized SQL; account-scoped reads filter on `account_id`
where the table is account-owned. Auth provider identity, sessions, and wallet
link metadata remain JSON-backed in `server/runtime-store.js` — documented as a
known gap, not yet migrated.

## Findings

### P0

None.

### P1

1. **Auth provider identity uniqueness is not in Postgres**
   - **File/line:** `server/runtime-store.js:826-895`, `docs/wiki/architecture/database.md:120-123`
   - **Severity:** P1 for Fly/production durability
   - **Impact:** `linkProviderToAccount` enforces `(provider, providerUserId)` uniqueness through in-memory `state.accountIdentities`. A second Fly instance, container restart without durable store, or bridge pull that omits runtime JSON can allow duplicate provider links or lose identity maps even when Postgres is healthy.
   - **Verification:** No auth/account migration in `server/db/migrations/`; PR-01 noted the same boundary.
   - **Fix:** Deferred — migrate accounts, sessions, provider identities, and wallet links into typed tables (already listed under Known Gaps in database wiki).

2. **Wallet/task reads are wallet-scoped, not account-scoped**
   - **File/line:** `server/repositories/tasks.js`, `server/repositories/task-requests.js:291-320`
   - **Severity:** P1 (defense-in-depth, expected for chain-backed tasks)
   - **Impact:** Task list/detail and task-request reads key off linked wallet address. If two accounts ever shared a wallet link incorrectly at the route layer, Postgres would not stop cross-account task visibility. Routes must keep wallet-to-session binding authoritative.
   - **Verification:** `listTaskRequests` allows empty `accountId` when wallet is set (`$1::text = '' OR tr.account_id = $1`).
   - **Fix:** Optional follow-up — require non-empty `accountId` on account-authenticated routes; keep wallet-only path for pre-auth diagnostics only.

### P2

1. **`database.md` Current Caches list lags later migrations**
   - **File/line:** `docs/wiki/architecture/database.md:5-38`
   - **Severity:** P2
   - **Impact:** Table inventory covers most tables, but the bullet list omits `016`, `017`, `020`, `022`, `034`, `037`, `040`, `041`, and `044`. Reviewers scanning only the cache list can miss idempotency/status hardening and Board Manager budget changes.
   - **Verification:** Compare `server/db/migrate.js` migration array to Current Caches bullets.
   - **Fix:** Doc follow-up in PR-10 or a narrow wiki patch.

2. **Legacy `schema_migrations` table coexists with `tasknode_schema_migrations`**
   - **File/line:** Docker Postgres, `scripts/fly-dev-data-bridge.mjs:17-18`
   - **Severity:** P2 (operational)
   - **Impact:** Both tables hold 44 applied migration names. Runtime migrate uses only `tasknode_schema_migrations`. Bridge pull/push truncates both. Harmless today but confusing for operators inspecting Fly dev.
   - **Verification:** `\dt` and `SELECT COUNT(*) FROM schema_migrations` in `tasknodeofficial-db-1`.
   - **Fix:** Document-only or drop legacy table after confirming no external tooling reads it.

3. **`board_manager_action_results` has no dedupe constraint**
   - **File/line:** `server/db/migrations/033_board_manager_v0.sql:47-55`
   - **Severity:** P2
   - **Impact:** Worker/action-hook retries can append duplicate audit rows for the same run/action/target. Runs are idempotent via leases and job idempotency keys; action results are audit-only.
   - **Verification:** Table has PK on `id` only; no `(run_id, action, target_id)` unique index.
   - **Fix:** Optional unique partial index if duplicate audit rows become noisy.

4. **`route-smoke` default port differs from running Docker dev web**
   - **File/line:** `scripts/route-smoke.mjs:8-12`
   - **Severity:** P2 (CI/dev ergonomics)
   - **Impact:** Default `ROUTE_SMOKE_PORT=5194` starts its own Vite server. Against the Docker stack on `:5174`, first run timed out on CDP navigate; passing `ROUTE_SMOKE_USE_EXISTING=1 ROUTE_SMOKE_BASE_URL=http://127.0.0.1:5174` succeeded.
   - **Verification:** Failed bare `npm run route-smoke`; passed with existing-server env vars.
   - **Fix:** Document in review checks or align default port with Docker dev.

## What Looks Correct

- **Pool:** Connection limits, statement timeout, transaction wrapper with per-session
  `statement_timeout`, and `isUniqueViolation` helper (`server/db/pool.js`).
- **Migrate:** Explicit ordered list 001–044; each migration runs in a transaction
  and records in `tasknode_schema_migrations`; safe to re-run (`server/db/migrate.js`).
- **Idempotency / uniqueness (Postgres):**
  - Daily airdrop: `(account_id, run_date)` unique for production runs and submitted
    issuances (`019`, `020`).
  - Profile snapshots: completed rows unique on
    `(account_id, input_fingerprint, prompt_digest, model)` (`022`).
  - Network tasks: allocation and generation job `idempotency_key` unique indexes
    (`039`, `040`).
  - Board Manager jobs: active `(scope, idempotency_key)` unique (`042`).
  - Task lifecycle: pointer/event dedupe indexes (`006`, `009`); task request PK on
    `request_id` with upsert (`012`).
  - Billing: ledger `idempotency_key` unique (`001`); memory/deep-memory job uniqueness
    (`004`, `005`, `013`).
- **Account scoping:** Chat, context, memory, profile, Hive context, billing, and
  Board Manager user-message audit queries include `account_id = $1` filters.
- **SQL safety:** Repository SQL uses `$n` parameters; no untrusted string
  concatenation into query text (template literals are display/formatting only).
- **Docs:** `database.md` table inventory maps major stateful features to surfaces;
  `data-architecture-hardening-plan.md` matches pointer-observation, audit, and
  repair tooling that exists today.
- **Integrity tooling:** `npm run data-architecture-audit` passes on Docker API with
  zero drift counts (except historical ignored reducer rows).

## Checks Run

```bash
npm ci
npm run quality
npm run security-smoke
ROUTE_SMOKE_USE_EXISTING=1 ROUTE_SMOKE_BASE_URL=http://127.0.0.1:5174 npm run route-smoke
git diff --check
docker exec tasknodeofficial-api-1 npm run data-architecture-audit
```

Manual evidence:

- `\dt` in `tasknodeofficial-db-1`: 57 public tables including Board Manager,
  Hive, network task, profile airdrop, and PFTL cache tables.
- All 44 migrations present in `tasknode_schema_migrations`.
- Uniqueness indexes on daily airdrop and profile snapshots confirmed via
  `pg_indexes`.
- Live data: production airdrop runs and submitted issuances each have
  `COUNT(*) = COUNT(DISTINCT (account_id, run_date))` (2/2, no duplicates).

## Residual Risks

- Auth, sessions, and provider identities remain JSON-durable until explicit DB
  migrations land.
- Task visibility depends on route-layer wallet binding, not Postgres account FKs.
- Fly dev runtime-store JSON is not fully represented in Postgres bridge tables.
- `route-smoke` needs existing-server env when Docker web is already on `:5174`.

## Merge Recommendation

**Merge** (review-only). No application code changes on this branch. Integration
owner should re-run `npm run quality` and route-smoke with the Docker dev URL
before merge. Track auth/account Postgres migration and wiki cache-list sync as
follow-ups.

---

```text
Review PR: PR-09
Boundary: Database migrations, pool, repositories, architecture docs
Branch: review/09-database-repositories
Changed files:
  docs/review_burndown/reviews/pr-09-database-repositories.md
  docs/review_burndown/burndown.md
Findings:
- P0: none
- P1: auth provider identity not in Postgres; task reads wallet-scoped not account-scoped
- P2: database.md cache list lag; legacy schema_migrations table; board_manager_action_results no dedupe; route-smoke port mismatch with Docker dev
Fixes included: none (review-only)
Checks run: quality, security-smoke, route-smoke (existing :5174), git diff --check, data-architecture-audit
Manual app evidence: Docker psql table list, migration inventory, airdrop uniqueness query, pg_indexes
Residual risks: JSON auth store; wallet-bound task reads; route-smoke env for Docker
Merge recommendation: merge review-only after quality + route-smoke re-run
```
