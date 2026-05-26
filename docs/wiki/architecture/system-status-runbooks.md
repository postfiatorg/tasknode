# System Status Runbooks

This page is the operator runbook for every row rendered by `GET /api/system/status`.
The status page is read-only: it reports scheduler, queue, worker, and RPC health,
but it does not repair state by itself.

Historical terminal failures can remain in row counts for audit. They should not
keep a row amber forever. Current health is derived from recent failures, queue
age, freshness, enabled flags, required config, and durable worker evidence.

## Shared Operator Checks

Start with these checks before editing data:

```bash
curl -fsS https://tasknodeofficial-dev.fly.dev/api/system/status
fly status -a tasknodeofficial-dev
npm run fly:background-guard
```

For Fly dev database inspection, use the data bridge:

```bash
npm run fly-dev:data:env
```

Then load `.env.tasknodeofficial-fly-dev-data`, set `DATABASE_URL` from
`TASKNODE_DATABASE_URL`, and run focused SQL or repository scripts.

## Hive Mind Board Agent

Status row: `board_manager`

Source: `board_manager_scopes`, `board_manager_runs`, `board_manager_jobs`, and
`board_manager_leases`.

Green means the `global_hive` scope is enabled and the latest completed run is
fresh for the configured cadence. A fresh running run is also green.

Amber means there are failed Board Manager jobs updated inside the recent failure
window. Historical failed jobs remain in counts but do not keep the row amber.

Red means the scope is missing, paused, disabled, stale beyond cadence, the
latest run failed, or a running run is stale.

Fix:

```bash
npm run board-manager:ops -- status
npm run board-manager:ops -- resume --reason "operator recovery"
npm run board-manager:ops -- enqueue --reason "operator recovery run"
npm run fly:board-guard
```

If the worker is up but jobs do not complete, inspect `board_manager_jobs` and
`board_manager_runs.error` before retrying. Do not manually mutate Hive project
rows while the Board Manager scope is enabled.

## Board Manager Secretary Packet

Status row: `board_manager_secretary_packets`

Source: `board_manager_secretary_packets`.

Green means the latest packet row exists and is `current`.

Amber is not used for this row today.

Red means the latest packet row is `failed`.

Fix:

```bash
npm run board-manager-secretary-packet-smoke
npm run board-manager:model -- --no-execute
```

Confirm `DEEPSEEK_API_KEY` is configured when secretary packets are enabled.
If the packet source changed but the row stays failed, inspect `error` on the
latest packet and rerun one Board Manager model tick after the provider issue is
fixed.

## Hive Secretary Worker

Status row: `hive_secretary`

Source: `hive_secretary_jobs` and `hive_secretary_reports`.

Green means a completed Secretary report exists within the worker freshness
window and no due queue item is stale.

Amber means there are recent failed Secretary jobs.

Red means due pending/processing work has been stale for too long or no report
has ever completed when the worker is enabled.

Fix:

```bash
npm run hive-context-smoke
npm run fly:background-guard
```

Inspect `hive_secretary_jobs` for the oldest due row and `last_error`. Fix the
provider/config error first, then let the worker claim the row or requeue the job
with a new `next_attempt_at` only after the root cause is understood.

## Hive Active Projects Helper

Status row: `hive_active_projects`

Source: `hive_project_planning_jobs` and `hive_project_generations`.

Green means the latest project generation is fresh and no due project-planning
job is stale.

Amber means recent project-planning jobs failed.

Red means the project-planning queue is stale or the enabled helper has no
completed generation.

Fix:

```bash
npm run hive-project-planning-smoke
npm run hive-project-rollup-repair
```

If rows are stale, inspect `hive_project_planning_jobs.last_error`. If generated
project rollups are wrong but worker health is green, repair rollups instead of
forcing a new planning generation.

## Network Task Generation Worker

Status row: `network_task_generation`

Source: `network_task_generation_jobs`.

Green means generation jobs are completing and no queued/running job is stale.

Amber means recent failed or `link_failed` generation jobs exist.

Red means a queued or running generation job is stale.

Fix:

```bash
npm run network-task-recovery
npm run network-task-recovery-smoke
```

Inspect failed rows for `last_error`. If the linked task request was generated
but allocation linking failed, reconcile through `network-task-recovery` rather
than creating duplicate requests.

## Task Generation Worker

Status row: `task_generation`

Source: `task_requests`.

Green means the worker has no stale published/queued/generating requests and no
recent failed request rows.

Amber means recently failed task request rows exist.

Red means a published, queued, or generating request is older than the queue
stale threshold.

Fix:

```bash
npm run task-lifecycle-smoke
npm run task-replay-repair -- --task-id=<task_id> --apply
```

Check `task_requests.last_error`, wallet seeds, encryption identity, IPFS, and
PFTL submission config. Do not turn a failed request into a fake projected task;
the task offer must come from a signed `pf.task.offer.v1` pointer.

## Task Review And Reward Worker

Status row: `task_review`

Source: `task_projections`.

Green means submitted and verification-response-submitted tasks are not stale and
the worker has recently progressed review/reward states.

Amber is not used for this row today.

Red means submitted or verification-response-submitted projections have been
waiting beyond the review threshold.

Fix:

```bash
npm run task-replay-repair -- --task-id=<task_id> --apply
npm run data-architecture-audit
```

If the projection is behind chain state, repair replay first. If the projection
is current but review is stalled, inspect task-review worker logs, provider
config, reward seed config, and latest `task_events`.

## PFTL Hot Wallet Sync

Status row: `pftl_hot_sync`

Source: `pftl_sync_wallets`.

Green means recent hot sync or checked timestamps exist and no active wallet is
severely stale.

Amber means one or more active wallets are severely stale.

Red means the worker is enabled but has no hot sync data or the latest hot sync
is beyond the stale threshold.

Fix:

```bash
npm run db:pftl-cache-smoke
npm run pftl-cache-watcher-smoke
```

Confirm `PFTL_CACHE_WORKER_ENABLED=true` and current PFTL RPC endpoints are
configured. If only unchanged wallets are aging, verify `markPftlSyncWalletChecked`
updates `last_hot_sync_at`.

## PFTL Archive Wallet Sync

Status row: `pftl_archive_sync`

Source: `pftl_sync_wallets.archive_marker` and `last_archive_sync_at`.

Green means the archive worker is enabled and every active wallet is marked
archive complete, or the latest archive sync is fresh while backfill remains in
progress.

Amber means active wallets still need archive backfill and are lagging.

Red means archive sync is stale or enabled with no usable archive evidence.

Fix:

```bash
npm run db:pftl-cache-archive-smoke
```

Inspect `pftl_sync_wallets.archive_marker`, `last_archive_sync_at`, and
`last_error`. Fix history RPC config before clearing markers. Do not mark a
wallet complete unless the archive worker actually reached the end of `account_tx`.

## PFTL WSS Watcher

Status row: `pftl_wss_watcher`

Source: `pftl_cache_watcher_state`.

Green means the watcher heartbeat/checkpoint is current.

Amber means the watcher is lagging.

Red means the watcher is enabled but stale or missing.

Fix:

```bash
npm run db:pftl-cache-watcher-stress
npm run fly:background-guard
```

Inspect websocket URL, TLS settings, reconnect logs, and watcher state. If WSS is
down but polling sync is green, the app may still be usable; keep this row amber
or red until WSS resumes.

## PFTL Cache Reducer

Status row: `pftl_cache_reducer`

Source: `pftl_cache_reducer_events`.

Green means completed reducer events are fresh, no pending/processing event is
stale, and no reducer failures were updated recently.

Amber is not used for current reducer failures because fresh projection failures
are correctness failures.

Red means recent reducer failures exist or the reducer queue is stale.

Fix:

```bash
npm run data-architecture-audit
npm run pftl-reducer-requeue -- --id=<event_id> --apply
npm run task-replay-repair -- --task-id=<task_id> --apply
```

Use audit output to distinguish historical ignored rows from current projection
drift. Requeue one reducer event at a time unless a bounded script proves the
failure class is repaired.

## PFTL Cache Retention

Status row: `pftl_cache_retention`

Source: `pftl_cache_maintenance_runs`.

Green means the retention worker has a fresh completed maintenance run.

Amber means the retention run is lagging.

Red means the worker is enabled but stale beyond the retention threshold or
latest maintenance failed.

Fix:

```bash
npm run db:pftl-cache-health-retention-smoke
```

Inspect `pftl_cache_maintenance_runs` and retention env flags. Retention should
delete completed reducer noise only; do not delete transaction, wallet, pointer,
or task projection evidence to make the row green.

## PFTL Current RPC And WSS

Status row: `pftl_current_rpc`

Source: current PFTL RPC/WSS env vars plus `pftl_hot_sync` health.

Green means current endpoints are configured and the hot sync row is green.

Amber means endpoints exist but hot sync is amber.

Red means required current endpoints are missing or hot sync is red.

Fix:

```bash
fly secrets list -a tasknodeofficial-dev
npm run pftl-cache-smoke
```

Check `PFTL_RPC_URL`, `PFTL_RPC_URL_FALLBACKS`, `PFTL_WSS_URL`, and related cache
poll env vars. A current RPC problem affects balance reads, submissions, and hot
sync polling.

## PFTL History RPC And Archive WSS

Status row: `pftl_history_rpc`

Source: history RPC/WSS env vars plus `pftl_archive_sync` health.

Green means archive endpoints are configured and archive sync is green.

Amber means endpoints exist but archive sync is amber.

Red means history endpoints are missing or archive sync is red.

Fix:

```bash
fly secrets list -a tasknodeofficial-dev
npm run db:pftl-cache-archive-smoke
```

Check `PFTL_HISTORY_RPC_URL`, history fallbacks, and archive WSS settings. History
RPC failures affect context restore and historical account transaction backfill.

## Ethereum Deposit RPC

Status row: `ethereum_deposit_rpc`

Source: Ethereum deposit env config.

Green means deposit sync is enabled, an xpub is configured, and an RPC endpoint
is configured or the default public endpoint is usable.

Amber is not used for this request-time row today.

Disabled means the deposit xpub or RPC config is intentionally absent.

Red is reserved for future active failure telemetry.

Fix:

```bash
fly secrets list -a tasknodeofficial-dev
```

Confirm `ETH_DEPOSIT_XPUB`, `ETH_DEPOSIT_RPC_URL` if overriding the default, and
chain id settings. Since this is request-time, reproduce with the top-up sync
route after config changes.

## Turn Memory Worker

Status row: `chat_turn_memory`

Source: `chat_memory_jobs` and `chat_memory_entries`.

Green means turn memory entries are being completed and no due memory job is
stale.

Amber means recently failed memory jobs exist.

Red means due pending/processing jobs are stale.

Fix:

```bash
npm run db:memory-smoke
npm run memory:backfill
```

Inspect `chat_memory_jobs.status`, `locked_at`, `next_attempt_at`, and
`last_error`. Release stale locks only when the worker is stopped or the lock is
older than the recovery threshold.

## Deep Memory Worker

Status row: `deep_memory`

Source: `chat_deep_memory_jobs` and deep memory entries.

Green means deep memory jobs complete and no due pending/processing job is
stale.

Amber means recently failed deep memory jobs exist.

Red means the deep memory queue is stale.

Fix:

```bash
npm run db:memory-smoke
npm run memory:backfill
```

If a row is `processing` with `locked_at IS NULL`, the claim path should recover
it automatically. If it does not, inspect `claimDeepMemoryJobs` before manual
SQL.

## Network Task Profile Worker

Status row: `network_task_profile`

Source: `network_task_profile_jobs` and `network_task_profiles`.

Green means compact routing profiles are completing and the queue is not stale.

Amber means recently failed profile jobs exist.

Red means due profile work is stale or no completed profile exists when enabled.

Fix:

```bash
npm run network-task-profile-smoke
npm run fly:background-guard
```

Inspect profile job source packet errors, DeepSeek/OpenRouter config, and
`network_task_profiles` digest state. Do not route a Network Task from a stale or
invented profile packet.

## Daily Airdrop Worker

Status row: `daily_airdrop_worker`

Source: `profile_daily_airdrop_runs`, `profile_daily_airdrop_issuances`, and
Board Manager audit rows with `selected_action = 'daily_airdrop'`.

Green means the worker is enabled and either a score/issuance run or a zero
candidate worker audit run completed within the daily freshness window.

Amber means the latest successful run is lagging or recent failed run/issuance
records exist.

Red means the latest run failed recently or the worker is stale beyond the hard
threshold.

Fix:

```bash
npm run profile-daily-airdrop-worker -- --json
npm run profile-daily-airdrop-issue -- --account-id=<account_id> --run-id=<run_id>
```

Failed issuance rows are money-path state. If `tx_hash` is empty and
`submitted_at` is null, the row can be retried through the issuance script after
the root cause is fixed. If submission may have happened, reconcile chain/cache
state before retrying so duplicate payouts are not signed.
