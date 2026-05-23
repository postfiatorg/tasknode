# PFTL Transaction Cache

## Purpose

The PFTL transaction cache is a Postgres mirror of wallet activity used by Task Node Official. PFTL remains canonical. Postgres exists so Wallet, Context, Tasks, and operator tooling can read transaction and pointer state quickly without doing request-time ledger scans.

The cache stores enough transaction identity to rebuild app projections from PFTL and IPFS:

- raw transaction JSON and metadata;
- per-wallet transaction indexes;
- decoded pointer memos and wallet observation rows;
- reducer events for wallet, context, and task projections;
- sync checkpoints and health state.

## Current System

The current system has six cooperating components:

| Component | Code | What it does |
| --- | --- | --- |
| Wallet registry | `pftl_sync_wallets`, `registerPftlSyncWallet` | Tracks every wallet the app should keep warm. |
| Live watcher | `server/pftl-cache-watcher.js` | Subscribes to validated PFTL wallet activity and writes cache rows immediately. |
| Polling repair | `startPftlCacheWorker` in `server/pftl-cache-sync.js` | Uses `account_info.PreviousTxnID` to detect missed activity, then hot-syncs recent `account_tx` only when needed. |
| Historical backfill | `startPftlArchiveWorker` in `server/pftl-cache-sync.js` | Slowly paginates historical `account_tx` using checkpoint markers. |
| Reducer | `server/pftl-cache-reducer.js` | Turns cached pointer rows into context history and task projections. |
| Operations | `server/pftl-cache-maintenance.js`, `server/repositories/pftl-cache-operations.js` | Exposes operator health and prunes old completed reducer events. |

## Data Flow

Validated transaction flow:

```text
PFTL validated transaction
  -> pftl_transactions
  -> pftl_wallet_transactions
  -> pftl_pointer_memos
  -> pftl_pointer_observations
  -> pftl_cache_reducer_events
  -> context_history_pointers / task_projections / wallet refresh state
```

Historical backfill flow:

```text
pftl_sync_wallets active wallet
  -> account_tx page from historical RPC
  -> cache rows and reducer events
  -> pftl_sync_wallets.archive_marker checkpoint
  -> repeat on the next worker tick until complete
```

Read flow:

```text
app surface
  -> Postgres cache read
  -> visible sync state if cache is empty, stale, or still backfilling
```

Normal app reads do not call historical `account_tx` directly. The wallet transaction endpoint reads the cache and returns sync state.

## Tables

| Table | Role |
| --- | --- |
| `pftl_sync_wallets` | Wallet watchlist, owner account, wallet role, hot sync state, historical backfill checkpoint, and last error. |
| `pftl_transactions` | Global transaction mirror keyed by tx hash with raw tx JSON, metadata, ledger index, type, result, accounts, and close time. |
| `pftl_wallet_transactions` | Per-wallet index mapping tracked wallets to global tx rows with direction, counterparty, amount, fee, ledger, and close time. |
| `pftl_pointer_memos` | Global decoded `pf.ptr/v4` memo facts keyed by transaction hash and memo index. This row says what the pointer is; it does not decide which wallet owns it. |
| `pftl_pointer_observations` | Wallet/account bridge for pointer visibility. One global pointer memo can have many observation rows when the user wallet, authority wallet, or allocation wallet all observe the same transaction. |
| `pftl_cache_watcher_state` | Current WSS watcher state, endpoint, subscribed wallet count, latest ledger/event, and errors. |
| `pftl_cache_reducer_events` | Idempotent reducer queue for wallet balance refresh, context pointer hydration, and task projection replay. |
| `pftl_cache_maintenance_runs` | Retention and maintenance summaries for operator diagnostics. |
| `context_history_pointers` | Context projection rows produced from cached `CONTEXT` pointer memos. |
| `pftl_task_pointer_events`, `task_events`, `task_projections` | Task projection rows produced from cached task pointer memos plus IPFS payloads. |

## Wallet Reads

`/api/wallet/transactions` is cache-only.

Implementation:

- route: `server/index.js`
- formatter: `server/pftl-transactions.js`
- cache read: `readCachedAccountTx` in `server/pftl-cache-sync.js`
- repository read: `listCachedAccountTx` in `server/repositories/pftl-cache.js`

Behavior:

1. The route requires a signed-in account with a linked wallet.
2. The backend registers the wallet in `pftl_sync_wallets`.
3. The backend reads cached rows from `pftl_wallet_transactions` joined to `pftl_transactions`.
4. If the cache is empty and `syncIfEmpty` is enabled, it performs a hot sync and returns the cache state.
5. The response includes `sync.status`, `lastHotSyncAt`, `lastArchiveSyncAt`, `lastError`, and any sync attempt result.

The endpoint does not hide cache failures behind a second direct ledger read. If the cache is unavailable or still syncing, the response should say so.

## Historical Backfill

The historical backfill worker fills old wallet activity without blocking the app.

Config:

| Env var | Default in local/Fly config | Meaning |
| --- | --- | --- |
| `PFTL_CACHE_ARCHIVE_WORKER_ENABLED` | `true` | Starts the background historical backfill worker. |
| `PFTL_CACHE_ARCHIVE_WORKER_INTERVAL_MS` | `300000` | Worker tick interval. |
| `PFTL_CACHE_ARCHIVE_BATCH_LIMIT` | `1` | Wallets processed per tick. |
| `PFTL_CACHE_ARCHIVE_MAX_PAGES` | `1` | `account_tx` pages processed per wallet per tick. |
| `PFTL_CACHE_ARCHIVE_ACCOUNT_TX_LIMIT` | `200` | Page size for historical `account_tx`. |

Checkpoint:

```json
{
  "complete": false,
  "marker": {},
  "scannedTransactions": 200,
  "pages": 1,
  "updatedAt": "ISO-8601"
}
```

The `marker` is the opaque PFTL `account_tx` resume token. The app stores it and sends it back to PFTL; it does not parse it as app state. When backfill completes, `complete` becomes `true` and `marker` is cleared.

Backfill writes are idempotent by tx hash, wallet plus tx hash, pointer memo key, and reducer dedupe key. Reprocessing a page is safe.

## Reducer

Reducer events decouple chain indexing from app projections.

| Reducer kind | Input | Output |
| --- | --- | --- |
| `wallet_balance_refresh` | Any tracked wallet transaction | Marks wallet activity state current for downstream reads. |
| `context_pointer_hydrate` | `CONTEXT` pointer memo row | Writes `context_history_pointers`. |
| `task_projection_replay` | `TASK`, `TASK_UPDATE`, `TASK_SUBMISSION`, or `REWARD` pointer memo row | Hydrates IPFS, decrypts service-readable payloads, writes task event/projection rows. |

Reducer event dedupe is explicit in `pftl_cache_reducer_events.dedupe_key`. Hot sync, live WSS, and historical backfill all enqueue the same reducer event shapes.

For task projection replay, a reducer event starts from one task pointer and rebuilds the projection for that task. When the pointer carries a task ID, the reducer hydrates cached pointers for that same task ID plus the seed CID that caused the replay across the active wallets registered to the same account. The account/wallet scope is resolved through `pftl_pointer_observations`, not `pftl_pointer_memos.wallet_address`.

This matters because one task lifecycle can include user-wallet submissions and authority-wallet verification or reward events. The reducer does not hydrate every historical task pointer with a blank task ID for the wallet, and the cache enqueue path no longer creates task projection work for task-style pointers that have no task ID. That prevents unrelated wallet-history pointers from becoming stale or failed task projections.

The reducer also refuses to promote garbage into `task_projections`. A raw pointer memo can stay in the PFTL cache, but a normalized task projection requires a recognized Task Node payload schema and a readable task contract. Orphan historical `TASK_SUBMISSION` pointers with blank schema, blank title, blank description, and no offer are skipped instead of becoming `unknown` tasks. Migration `025_prune_orphan_task_projection_garbage.sql` removes previously imported blank unknown projections and their blank-schema normalized task event rows.

For `pf.task.offer.v1`, the reducer preserves the generated task contract in projection metadata, including `title`, `description`, `task_kind`, `steps`, reward offer, submission requirement, verification policy, and deadline fields. The Tasks UI reads `metadata_json.generatedTask.steps` from `task_projections`; it should not replace real offer steps with the submission requirement.

Current task replay recognizes these app-produced payload schemas:

- `pf.task.request.v1` as the user request pointer and bundle anchor.
- `pf.task.offer.v1` as the authority-issued proposed task.
- `pf.task.update.v1` for accepted, refused, cancelled, verification requested, and reward-decision transitions.
- `pf.task.submission.v1` for initial evidence.
- `pf.task.verification_response.v1` for follow-up verification evidence.
- `pf.task.reward_decision.v1` for terminal scoring.
- `pf.reward.v1` for positive PFT payment evidence.

The reducer writes readable forensics fields only when the Task Node service key can decrypt the IPFS payload. CID, transaction hash, ledger, memo index, schema, and digest remain visible even if readable payload hydration fails.

## Operator Health

Operators can inspect cache health here:

```text
GET /api/pftl/cache/health
```

Access:

- production requires `session.accountId` in `TASKNODE_OPERATOR_ACCOUNT_IDS` or `TASKNODE_ADMIN_ACCOUNT_IDS`;
- local development allows signed-in access unless `PFTL_CACHE_OPERATOR_ALLOW_LOCAL=false`.

Response sections:

| Field | Meaning |
| --- | --- |
| `wallets.total` | Total tracked wallets. |
| `wallets.active` | Wallets currently watched/synced. |
| `wallets.hot_stale` | Active wallets whose hot sync is stale. |
| `wallets.archive_complete` | Active wallets with completed historical backfill. |
| `wallets.archive_incomplete` | Active wallets still backfilling. |
| `wallets.archive_stale` | Backfill-incomplete wallets that have not progressed within the threshold. |
| `wallets.error_count` | Wallets with a sync error. |
| `reducerQueue` | Reducer event counts by status. |
| `watchers` | WSS watcher state and latest observed ledger/event. |
| `counts` | Row counts for transactions, wallet transactions, and pointer memos. |
| `recentErrors` | Recent wallet sync failures. |
| `maintenanceRuns` | Recent retention/maintenance runs. |

## Retention

Retention is deliberately conservative.

Default behavior:

- old completed `pftl_cache_reducer_events` rows are deleted after `PFTL_CACHE_RETENTION_COMPLETED_REDUCER_DAYS`;
- `pftl_transactions`, `pftl_wallet_transactions`, and `pftl_pointer_memos` are retained;
- orphan raw transaction pruning is disabled unless `PFTL_CACHE_RETENTION_RAW_TX_ENABLED=true`.

Reason:

- reducer events are queue rows after they complete;
- transaction rows and pointer memo rows are replay evidence.

Deleting completed reducer events does not delete wallet activity, context pointer evidence, task pointer evidence, or rewards.

## Configuration

Enabled in local Docker and Fly config:

```text
PFTL_CACHE_WSS_WATCHER_ENABLED=true
PFTL_CACHE_WORKER_ENABLED=true
PFTL_CACHE_REDUCER_WORKER_ENABLED=true
PFTL_CACHE_ARCHIVE_WORKER_ENABLED=true
PFTL_CACHE_RETENTION_WORKER_ENABLED=true
PFTL_CACHE_RETENTION_RAW_TX_ENABLED=false
```

Hot activity should use the rapid PFTL RPC/WSS. Historical backfill should use the historical RPC/WSS endpoints configured by `PFTL_HISTORY_*`.

## Code Map

| Code | Role |
| --- | --- |
| `server/db/migrations/007_pftl_transaction_cache.sql` | Core cache tables. |
| `server/db/migrations/008_pftl_cache_watcher.sql` | Watcher state and reducer event queue. |
| `server/db/migrations/009_pftl_cache_reducer_dedupe_key.sql` | Explicit reducer dedupe key. |
| `server/db/migrations/010_pftl_cache_operations.sql` | Backfill/retention indexes and maintenance run table. |
| `server/db/migrations/023_pftl_pointer_observations.sql` | Pointer observation bridge table and indexes. |
| `server/repositories/pftl-cache.js` | Wallet registration, transaction upsert, pointer memo extraction, cache reads, sync checkpoints. |
| `server/repositories/pftl-cache-operations.js` | Health and retention queries. |
| `server/pftl-cache-sync.js` | Hot sync, historical backfill, polling repair workers. |
| `server/pftl-cache-watcher.js` | WSS watcher and validated event ingestion. |
| `server/pftl-cache-reducer.js` | Projection reducer worker. |
| `server/pftl-cache-maintenance.js` | Operator access and retention worker. |
| `server/pftl-cache-route.js` | Cache API routes. |
| `server/pftl-transactions.js` | Wallet transaction response formatting from cache rows. |
| `scripts/pftl-pointer-observation-backfill.mjs` | Idempotent backfill from wallet transactions plus pointer memos into observation rows. |
| `scripts/data-architecture-audit.mjs` | Cross-boundary audit for pointer observations, reducer failures, task projection drift, billing projection mismatch, and stuck memory jobs. |
| `scripts/task-replay-repair.mjs` | Requeues and rebuilds task projections from cached PFTL pointer observations. |
| `scripts/pftl-reducer-requeue.mjs` | Generic failed reducer requeue tool for context or task cache rows. |

## Verification

```text
npm run pftl-cache-smoke
npm run pftl-cache-watcher-smoke
npm run db:pftl-cache-smoke
npm run db:pftl-cache-watcher-stress
npm run db:pftl-cache-reducer-smoke
npm run db:pftl-cache-archive-smoke
npm run db:pftl-cache-health-retention-smoke
npm run db:pftl-pointer-observation-backfill -- --limit=10000
npm run data-architecture-audit
npm run task-replay-repair -- --task-id=<task_id>
npm run pftl-reducer-requeue -- --id=<reducer_event_id>
```

## Current Operator Rules

- PFTL/IPFS remains canonical. Postgres task projections are disposable read models.
- A pointer memo is global. Wallet/account visibility belongs in `pftl_pointer_observations`.
- `npm run data-architecture-audit` must have no P0 or P1 findings before task/cache changes are called healthy.
- `reducerFailedNoTaskPointerIgnored` counts historical no-task pointer rows that were incorrectly queued before the enqueue policy changed. New no-task-ID task pointers should not create task projection reducer work.
- Use `task-replay-repair` for task-specific projection repair and `pftl-reducer-requeue` for a failed reducer row. Do not repair task state by hand-editing `task_projections`.

## Reviewer To Do List

Review implementation against this document (pftl transaction cache). Mark each item when verified.

### Memory Efficiency
- [ ] Hot paths use bounded queries, checkpoints, or projection tables.
- [ ] Background workers dedupe and lock jobs to prevent duplicate work.
- [ ] Watcher and polling repair use checkpoints; no full wallet history re-fetch every tick.
- [ ] Retention policy drops completed reducer events without deleting tx audit rows.

### Code Quality
- [ ] Architecture claims map to migrations, repositories, and smoke scripts.
- [ ] Failure modes have operator-visible signals or health endpoints.
- [ ] Six cache components (watcher, repair, backfill, reducer, maintenance) each independently testable.
- [ ] `pftl_pointer_observations` bridges multi-wallet task replay.

### Coherence
- [ ] Canonical vs cache boundaries consistent with wiki index.
- [ ] Cross-links to related architecture pages remain accurate.
- [ ] Cache health endpoint reflects worker state documented here.
- [ ] Wallet UI reads cache-only paths as stated.

### Bloat
- [ ] No parallel implementations of the same protocol concern.
- [ ] Retention policies drop queue noise without losing audit tx rows.
- [ ] Reducer dedupe keys prevent duplicate projection work.

### Security
- [ ] Encryption and wallet-role rules enforced at trust boundaries.
- [ ] Secrets and seeds remain server-side or browser-local as designed.
- [ ] Archive vs rapid RPC boundaries respected for history backfill.
- [ ] Cache rows account/wallet scoped; no cross-account tx leakage in feeds.
