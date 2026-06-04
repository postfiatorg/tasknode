# PR-02 Review: Deployment, Docker/Fly Data Bridge, And Config Safety

Date: 2026-05-24
Branch: `review/02-deploy-docker-fly-data`
Base: `origin/main` @ `4851610`

## Summary

Reviewed Fly deploy config, local Docker compose, the Fly dev Postgres bridge,
database pool/migrate boundaries, and deployment docs. The bridge correctly
targets `tasknodeofficial-dev` only, generated env files stay gitignored, and
Fly process roles are separated. Two small fixes improve fail-closed behavior
when the Fly proxy is down.

## Findings

### P0

None.

### P1

1. **`TASKNODE_FLY_DEV_DATA_BRIDGE` was not injected into fly-data containers**
   - **File/line:** `docker-compose.fly-data.yml:7-16`, `scripts/fly-dev-data-bridge.mjs:147`
   - **Severity:** P1
   - **Impact:** The generated env flag was used for compose interpolation only. API startup could not distinguish “Fly bridge mode with dead proxy” from a generic database failure.
   - **Verification:** Generated env file contained the flag; container env did not until this branch.
   - **Fix:** Included — pass `TASKNODE_FLY_DEV_DATA_BRIDGE=true` in fly-data compose override.

2. **Startup failed opaquely when Fly proxy was unavailable in bridge mode**
   - **File/line:** `server/index.js:957-967`
   - **Severity:** P1
   - **Impact:** `migrateDatabase()` throws on connection failure; users got raw Postgres errors instead of bridge recovery steps.
   - **Verification:** Docs say rerun `npm run docker:dev:fly-data` when proxy dies; error message did not.
   - **Fix:** Included — wrap migrate startup with bridge-specific guidance when the flag is set.

3. **`fly-dev:data:pull` / `fly-dev:data:push` are destructive**
   - **File/line:** `scripts/fly-dev-data-bridge.mjs:306-337`
   - **Severity:** P1 (operational)
   - **Impact:** Truncate-and-reload against Fly dev or local Docker can wipe shared dev data if run casually. Backups go to `/tmp` but operator must know the risk.
   - **Verification:** Read `pull()` / `push()` — both truncate reloadable tables before restore.
   - **Fix:** Documented as residual risk; no code change (backups already written).

### P2

1. **Fly-data Docker mode still starts the local `db` service**
   - **File/line:** `docker-compose.dev.yml:2-16`, `docker-compose.fly-data.yml`
   - **Severity:** P2
   - **Impact:** Unused local Postgres container consumes resources; `pull`/`status` still reference local Docker DB at `127.0.0.1:5436`.
   - **Verification:** `docker:dev:fly-data` uses both compose files; only API/web/board-manager switch to host networking.
   - **Fix:** Deferred — acceptable for dev; note for later compose cleanup.

2. **Docker dev API runs process role `all`; Fly separates web and worker**
   - **File/line:** `docker-compose.dev.yml:22`, `fly.toml:7-10`, `server/process-role.js`
   - **Severity:** P2
   - **Impact:** Local Docker runs background workers inside the API container while Fly uses a dedicated worker machine group. Dev behavior is broader than production topology.
   - **Verification:** `dev:api` does not set `TASKNODE_PROCESS_ROLE`; Fly sets `web` / `worker` / `board-manager`.
   - **Fix:** Documented; intentional local-dev convenience.

3. **Small Fly vs local table-count drift**
   - **Severity:** P2
   - **Impact:** `npm run fly-dev:data:status` showed minor differences (`chat_messages` 1192 fly vs 1176 local) during review — expected when environments are not freshly synced.
   - **Verification:** `npm run fly-dev:data:status` on 2026-05-24.
   - **Fix:** None required.

## What Looks Correct

- Bridge reads `DATABASE_URL` from `tasknodeofficial-dev` via `fly ssh`, not PFTasks apps.
- `fly.toml` sets Task Node Discord callback URI and separates `app`, `worker`, and `board-manager` processes.
- `.gitignore` covers `.env.*`; `git ls-files` shows no tracked env secrets.
- Default `npm run docker:dev` uses isolated local Postgres; fly-data mode requires explicit `npm run docker:dev:fly-data`.
- Migrations are idempotent via `tasknode_schema_migrations`.
- Deployment wiki docs state wallet vaults are origin-local and warn against PFTasks DB retargeting.

## Fixes Included On This Branch

1. Inject `TASKNODE_FLY_DEV_DATA_BRIDGE=true` into fly-data API and board-manager containers.
2. Add bridge-specific startup error when migrations fail under that flag.
3. Fix indentation in `server/db/migrate.js` migration loop.

## Checks Run

```bash
npm ci
npm run fly-dev:data:status          # pass
npm run security-smoke               # pass
git diff --check origin/main...HEAD  # pass
git ls-files '*.env*'                # none tracked
```

Manual evidence:

- `fly-dev:data:status` returned Fly and local counts for six shared tables plus runtime-store summaries.
- Bridge files contain no PFTasks hostname/database references.

## Residual Risks

- Operators must treat `fly-dev:data:push` as a shared-dev write operation.
- Fly proxy and Fly API token are required for bridge commands; CI cannot fully exercise live bridge without credentials.
- Runtime auth/wallet state remains JSON-backed alongside Postgres until later migration PRs.

## Merge Recommendation

**Merge** after integration owner re-runs `npm run quality`, `npm run smoke`, and `npm run route-smoke` on this branch.

---

```text
Review PR: PR-02
Boundary: Deployment, Docker/Fly data bridge, config safety
Branch: review/02-deploy-docker-fly-data
Changed files:
  docker-compose.fly-data.yml
  server/index.js
  server/db/migrate.js
  docs/review_burndown/reviews/pr-02-deploy-docker-fly-data.md
Findings:
- P0: none
- P1: bridge flag not in container env (fixed); opaque proxy-down startup (fixed); destructive pull/push ops (documented)
- P2: unused local db in fly-data mode; Docker all-in-one workers vs Fly split; minor count drift
Fixes included: fly-data env flag in compose; bridge startup error; migrate indent
Checks run: fly-dev:data:status, security-smoke, git diff --check
Manual app evidence: fly/local table count comparison via status command
Residual risks: destructive push/pull; bridge needs Fly credentials
Merge recommendation: merge after quality + smoke + route-smoke re-run by integration owner
```
