# Deploy Runbook

Task Node production is `https://tasknode.postfiat.org`, served by the Fly app
`tasknodeofficial-dev`. Use this runbook for normal production deploys,
rollbacks, and first-response deploy triage.

## Production Shape

`fly.toml` defines the HTTP app, role-specific background workers, and the
Board Manager process group:

```text
app                    npm run start:web
worker-pftl            npm run start:worker:pftl
worker-taskgen         npm run start:worker:taskgen
worker-task-review     npm run start:worker:task-review
worker-context-rewrite npm run start:worker:context-rewrite
worker-hive            npm run start:worker:hive
worker-memory-profile  npm run start:worker:memory-profile
worker-airdrop         npm run start:worker:airdrop
board-manager          npm run start:board-manager
```

Only `app` receives HTTP traffic. Every `worker-*` process group and
`board-manager` must be verified separately after every deploy. The legacy
`worker` process still exists for local compatibility, but production rejects
the monolith worker unless `TASKNODE_ALLOW_MONOLITH_WORKER=true` is set
explicitly.

Database pool defaults are role-aware. `web` gets a larger pool for request
traffic, task generation/context rewrite get medium pools for provider-heavy
work, and low-frequency workers get smaller pools. `/api/system/status` exposes
`databasePool.role`, `max`, `total`, `idle`, and `waiting` for the current
process.

Every process starts through `server/index.js`, and startup calls
`migrateDatabase()` before the process finishes booting. That migrator reads the
explicit filename list in `server/db/migrate.js` and applies unapplied SQL files
from `server/db/migrations/` into `tasknode_schema_migrations`. A migration
failure is therefore a deploy failure, even if the Docker image built cleanly.

## Deploy Command

Normal production deploy:

```bash
cd /home/pfrpc/repos/tasknodeofficial
npm run fly:deploy:prod
```

The package script expands to:

```bash
TASKNODE_CONFIRM_PRODUCTION_DEPLOY=yes \
  npm run migration-registration-smoke && \
  node scripts/fly-deploy-preflight.mjs && \
  fly deploy -a tasknodeofficial-dev -c fly.toml --remote-only && \
  npm run fly:background-guard
```

Do not use raw `fly deploy` for normal production releases. The npm wrapper
checks migration registration, confirms that `fly.toml` targets the production
hostname, deploys the image, and then runs the background guard so the
non-HTTP `worker-*` and `board-manager` process groups are started and have
`restart=always`.

## Rollback

The installed `flyctl` on this host does not support `fly image rollback`.
Rollback by redeploying the previous image tag directly.

Find release image tags:

```bash
fly releases -a tasknodeofficial-dev --image
```

Copy the previous known-good deployment image SHA/tag, then deploy it:

```bash
fly deploy \
  -a tasknodeofficial-dev \
  --image registry.fly.io/tasknodeofficial-dev:<prev-deployment-sha> \
  --remote-only
```

After rollback, still run the background guard and live checks:

```bash
npm run fly:background-guard
curl -fsS https://tasknode.postfiat.org/health
fly status -a tasknodeofficial-dev
```

Example from the recent deploy sequence: after `ba8c3a9` added Board Manager
GLM 5.2 usage telemetry, `0e9dfae` registered migration
`069_board_manager_run_usage.sql`, and `928b5c5` added the
migration-registration smoke. Use the actual tag from `fly releases --image`
for rollback; do not infer it from the git SHA.

## Failure Modes To Avoid

### 061-Class: Migration Timeout On Prod-Sized Tables

Symptom: the image builds, but one process or all process groups fail during
startup because a migration statement exceeds the production statement timeout.
The same SQL may pass on small dev data.

What happened: migration `061_projection_fixture_cleanup.sql` originally did
too much broad cleanup work against production-sized tables. The fix landed as
`146f893` / PR #98 by restricting the cleanup scope.

Avoidance:

- Validate new migrations against prod-sized data, not only small local Docker
  fixtures.
- Avoid unbounded JSON scans and broad full-table DML in migrations.
- Prefer indexed predicates, task-id-backed rows, bounded updates, or a guarded
  operator script when cleanup may be large.
- Before deploy, read the migration and ask: "What is the worst-case row count
  on production?"

If a migration timeout reaches production, rollback first to restore service,
then fix the migration. Do not keep retrying the same image.

### 069-Class: SQL File Not Registered

Symptom: code boots expecting a new column/table, but the database never got it
because a `server/db/migrations/*.sql` file exists but is not listed in
`server/db/migrate.js`.

What happened: migration `069_board_manager_run_usage.sql` existed but was not
registered, so the deployed Board Manager cost-telemetry code read columns that
boot migrations had never applied. The fix landed as `0e9dfae` / PR #104, and
`928b5c5` / PR #106 added `npm run migration-registration-smoke`.

Avoidance:

```bash
npm run migration-registration-smoke
```

This smoke fails if any `.sql` file is missing from `server/db/migrate.js`, if
`migrate.js` contains a stale entry with no file, or if the list contains a
duplicate. It now runs at the start of `npm run fly:deploy`.

### Quality-Gate Contract Drift: Submission Blocked As Self-Dealing

Symptom: an autonomous agent can request and accept work, but its evidence or
verification response is rejected with the anti-self-dealing error. That breaks
the agent-as-operator loop even though the system still needs to block terminal
reward, enforcement, and accounting actions.

What happened: the agent quality gate treated every self-requested
`agent_capability_client` task action as self-dealing, including the initial
`task_submission` evidence path. The P0 fix landed as `305fd38` / PR #110 and
was deployed in release v357. `agentSelfDealingDecision()` in
`server/agent-quality-gates.js` now allows self-requested `task_submission` and
`task_verification_response` because both are evidence from the task subject.
Privileged terminal actions remain blocked with `agent_self_dealing_blocked`.

Avoidance:

- Treat quality gates as action-specific contracts, not broad labels. For this
  boundary, "agent may submit its own evidence and answer reviewer follow-up"
  and "agent may not decide reward or accounting outcome" are separate
  assertions.
- Before deploy, run the focused positive/negative smoke:

  ```bash
  npm run agent-quality-gates-smoke
  ```

- After deploy, verify the live code path without mutating task state. A small
  app-image import check is sufficient: `task_submission` and
  `task_verification_response` for a self-requested agent task must return
  `ok: true`, while a privileged terminal action must return `ok: false` /
  `409`.
- Do not verify only the denied path. A guard that blocks the right bad action
  can still be a P0 if it also blocks the required good action.

## Pre-Deploy Checklist

Run from the branch intended for production:

```bash
git status --short --branch
git fetch origin
npm run migration-registration-smoke
npm run format-check
```

For any PR that adds or changes `server/db/migrations/*.sql`:

- Confirm the new file is listed in `server/db/migrate.js`.
- Confirm the filename order matches the intended migration order.
- Read every statement for prod-scale behavior.
- Prefer `CREATE INDEX CONCURRENTLY` for large-table indexes when the migration
  framework supports it; if it cannot run safely in the normal transaction
  wrapper, stop and make the migration plan explicit instead of risking a lock.
- Avoid broad data cleanup in boot migrations; if the cleanup is operator work,
  ship a guarded dry-run/execute script instead.

For model/cadence changes:

- Check `fly.toml` defaults.
- Check Fly secrets for `TASKNODE_BOARD_MANAGER_*`; secrets override
  `fly.toml`.
- Remember the 120-vs-300 cadence gotcha: changing
  `TASKNODE_BOARD_MANAGER_CADENCE_SECONDS` in `fly.toml` does not take effect if
  a Fly secret pins the old value.

Inspect current relevant secrets without printing sensitive values where
possible:

```bash
fly secrets list -a tasknodeofficial-dev
```

For agent quality-gate changes:

- Run `npm run agent-quality-gates-smoke`.
- Confirm every changed action has both an allowed and blocked test case.
- Confirm the smoke covers the production action strings used by
  `server/task-submission.js` and adjacent task routes.
- For self-requested agent work, the required contract is: initial
  `task_submission` and `task_verification_response` are allowed; terminal
  reward/control actions remain blocked.
- For Orc/Core Contributor operating loops, confirm the trusted-agent tier still
  has a rate ceiling but uses operator-scale defaults. The smoke must prove a
  standard machine agent is rate-limited at the normal ceiling and a trusted
  Grashnuk-style wallet receives the elevated tier plus a visible `resetAt`
  timestamp when blocked.

## Post-Deploy Verification

A single 200 from one curl is not sufficient. Verify cold and concurrent access,
all process groups, and the feature/config that changed.

Basic health:

```bash
curl -fsS https://tasknode.postfiat.org/health
fly status -a tasknodeofficial-dev
npm run fly:background-guard
```

Cold and concurrent probes:

```bash
curl -fsS -o /dev/null -w 'cold /health %{http_code} %{time_total}s\n' \
  https://tasknode.postfiat.org/health

seq 1 10 | xargs -P10 -I{} \
  curl -fsS -o /dev/null -w 'concurrent {} %{http_code} %{time_total}s\n' \
  https://tasknode.postfiat.org/health
```

For app-surface checks, use the endpoint that changed. Examples:

```bash
curl -fsS https://tasknode.postfiat.org/api/system/status >/tmp/tasknode-system-status.json
curl -fsS https://tasknode.postfiat.org/api/directory/leaderboard >/tmp/tasknode-directory.json
```

For agent quality-gate changes, prefer a no-mutation deployed-image check over
creating live task evidence purely for verification. Example result to require:

```json
{
  "submission": {
    "ok": true,
    "reason": "self_requested_submission_allowed_independent_review_required"
  },
  "verification": {
    "ok": true,
    "reason": "self_requested_verification_response_allowed_independent_reward_required"
  },
  "rewardDecision": {
    "ok": false,
    "error": "agent_self_dealing_blocked"
  }
}
```

Process checks:

```bash
fly status -a tasknodeofficial-dev
fly logs -a tasknodeofficial-dev
```

Expected:

- `app` has a started machine and `/health` is green.
- Every `worker-*` group has a started machine with `restart=always`.
- `board-manager` has a started machine with `restart=always`.
- The newly deployed endpoint, config, migration, or UI behavior is visible on
  production.
- For Board Manager model/cadence changes, watch at least one scheduled run or
  `board-manager:ops status` output to confirm the effective provider/model and
  cadence are the intended values.

Board Manager status:

```bash
fly ssh console -a tasknodeofficial-dev -C \
  "sh -lc 'cd /app && npm run board-manager:ops -- status'"
```

If post-deploy health fails, rollback to the prior known-good image before
investigating. Do not leave production in a partially booting state while
debugging.

## Board Manager Environment Gotcha

`TASKNODE_BOARD_MANAGER_*` values can come from both `fly.toml` and Fly secrets.
Fly secrets win. This matters for:

- `TASKNODE_BOARD_MANAGER_PROVIDER`
- `TASKNODE_BOARD_MANAGER_MODEL`
- `TASKNODE_BOARD_MANAGER_CADENCE_SECONDS`
- `TASKNODE_BOARD_MANAGER_MAX_ACTIONS_PER_HOUR`
- `TASKNODE_BOARD_MANAGER_SECRETARY_*`

Changing the default in `fly.toml` is not enough when a secret exists. To change
the live cadence or model, update the Fly secret intentionally, then verify the
Board Manager process sees it:

```bash
fly secrets set TASKNODE_BOARD_MANAGER_CADENCE_SECONDS=120 -a tasknodeofficial-dev
fly ssh console -a tasknodeofficial-dev -C \
  "sh -lc 'cd /app && npm run board-manager:ops -- status'"
```

Use the same rule for model/provider switches. Confirm the live process, not
only the repository config.

## Fast Triage Decision Tree

1. Deploy failed before image release: inspect build output; no rollback needed.
2. App boots but `worker` or `board-manager` is stopped: run
   `npm run fly:background-guard`; if it fails, inspect process logs.
3. Process exits during boot with a database error: suspect migration failure.
   Check whether the new SQL was registered and whether a statement timed out.
4. New code expects a missing column/table: run `npm run
   migration-registration-smoke` locally and inspect `server/db/migrate.js`.
5. Prod is 502/503 or process groups flap: rollback with the previous image tag,
   then debug on a branch.
6. Board Manager cadence/model does not match the repo: inspect Fly secrets; a
   secret likely overrides `fly.toml`.
7. Agent cannot submit evidence or answer reviewer follow-up after deploy:
   check the quality-gate action contract. `task_submission`,
   `task_verification_response`, and terminal reward/control actions must not
   share the same self-dealing outcome.
