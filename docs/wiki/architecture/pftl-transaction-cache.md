# PFTL Transaction Cache

## Decision

Task Node Official should add a Postgres-native PFTL transaction mirror for every wallet the app is responsible for tracking: linked user wallets, task authority wallets, allocation reward wallets, treasury wallets, and service wallets that publish pointer activity.

The cache is not canonical. PFTL remains canonical for wallet activity, pointer memos, task lifecycle events, and rewards. The cache exists so app reads do not depend on live `account_tx` scans, shallow RPC history, or archive RPC latency.

## Latest Operations Slice

This section describes the archive-completeness, monitoring, and retention work added in commit `8fe5ec7`.

Before this slice, the cache had a good live path:

```text
PFTL WSS / hot account_tx
  -> pftl_transactions
  -> pftl_wallet_transactions
  -> pftl_pointer_memos
  -> pftl_cache_reducer_events
  -> context/task projections
```

That was enough for fresh activity, but not enough to operate the system reliably. Three gaps remained:

| Gap | Why it mattered | What changed |
| --- | --- | --- |
| Archive completeness | A wallet can have useful historical context/task pointers older than the hot cache window. Starting every archive scan from page one is wasteful and can fail mid-run. | `syncPftlWalletArchive` now resumes from the real opaque `account_tx` marker and checkpoints progress in `pftl_sync_wallets.archive_marker`. |
| Operator monitoring | We needed one place to see whether WSS, hot polling, archive backfill, reducer queue, and retention are healthy. | `/api/pftl/cache/health` reports tracked wallet counts, stale wallets, archive status, reducer queue depth, watcher state, row counts, recent sync errors, and maintenance runs. |
| Retention | Reducer events are a work queue and should not grow forever, but raw transaction and pointer rows are replay substrate. | `startPftlCacheRetentionWorker` prunes only old completed reducer events by default. Raw transaction pruning is disabled unless explicitly enabled. |

The operational architecture is now:

```text
Live path:
  validated PFTL tx
    -> cache rows
    -> reducer events
    -> context/task/wallet projections

Archive path:
  active sync wallet
    -> archive account_tx page
    -> cache rows
    -> reducer events
    -> archive_marker checkpoint
    -> repeat until complete

Monitoring path:
  operator health endpoint
    -> sync wallet freshness
    -> archive completeness
    -> watcher status
    -> reducer queue depth
    -> recent errors and retention runs

Retention path:
  old completed reducer events
    -> delete after retention age
  raw tx / wallet tx / pointer memos
    -> retained by default for replayability
```

This is still a cache. If the Postgres mirror is lost, the intended repair is to replay PFTL `account_tx` plus IPFS payload hydration, not to treat the lost Postgres rows as canonical state.

## PFTasks Reference

PFTasks already implemented the correct backend shape for messaging and wallet history:

| PFTasks object | Purpose | Reference |
| --- | --- | --- |
| `wallet_sync_targets` | Wallet watchlist plus sync status, priority, last seen tx hash, last seen ledger, and error state. | `pftasks/api/migrations/026_tx_sync_engine.sql`, `027_wallet_sync_state.sql`, `065_messages_synced_at.sql` |
| `tx_cache` | Global transaction table keyed by tx hash, storing full tx JSON and meta JSON. | `pftasks/api/src/services/tx_sync_service.js` |
| `wallet_tx_index` | Per-wallet transaction index keyed by wallet plus tx hash, with direction and counterparty. | `pftasks/api/src/services/tx_sync_service.js` |
| `tx_sync_hot` | Recent `account_tx` pull after activity is detected. | `pftasks/worker/src/jobs/tx_sync_hot.js` |
| `tx_sync_full` | Paginated historical backfill with markers. | `pftasks/worker/src/jobs/tx_sync_full.js` |
| WSS watcher | Subscribes to watched wallets and enqueues hot sync on validated tx events. | `pftasks/worker/src/lib/tx_sync_ws.js` |
| Polling watcher | Uses `account_info.PreviousTxnID` as a fallback change detector. | `pftasks/worker/src/lib/tx_sync_scheduler.js` |
| `pftl_memo_pointers` | Ledger-scoped pointer memo index. | `pftasks/api/migrations/002_chain_indexer.sql`, `pftasks/worker/src/jobs/chain_indexer.js` |

PFTasks consumers include messaging, contacts, MessageKey discovery, profile graphs, context backfill, wallet transaction lists, and audit tools. The main lesson is that wallet history should be a shared backend substrate, not something each product surface pulls independently from RPC.

## What Not To Copy

PFTasks also shows what to avoid:

- Do not run full `account_tx`, IPFS fetch, and decrypt work in normal API request paths.
- Do not maintain duplicated API and worker transaction sync implementations.
- Do not let transaction cache retention be unbounded without a storage policy.
- Do not rely only on WSS; use polling as a correctness backstop.
- Do not make Postgres the task truth. It is a rebuildable projection over PFTL/IPFS.

## Current Task Node Official State

Task Node Official currently has partial pieces:

- Wallet activity reads through `server/pftl-transactions.js`, which now attempts the Postgres PFTL cache first and falls back to historical `account_tx` during rollout.
- Historical context restore reads through `server/context-history-rpc.js`, which scans archive `account_tx` and then stores context pointer metadata.
- Task projections exist in `server/db/migrations/006_task_projections.sql`, but replay imports currently come from receipts rather than a standing wallet transaction mirror.
- The first general transaction cache tables live in `server/db/migrations/007_pftl_transaction_cache.sql`.
- Cache repository and sync helpers live in `server/repositories/pftl-cache.js`, `server/pftl-cache-sync.js`, and `server/pftl-cache-watcher.js`.

That means multiple surfaces still compete for RPC history:

- Wallet activity feed.
- Historical context restore.
- Task replay/indexing.
- Future on-chain chat or agent messaging.
- MessageKey and pointer discovery.

## Proposed Schema

Use Task Node Official names rather than copying PFTasks names blindly. The shape should remain close enough that an `account_tx`-compatible response can be reconstructed.

```text
pftl_sync_wallets
  wallet_address primary key
  account_id nullable
  role user | authority | allocation | treasury | service | contact
  owner_wallet_address nullable
  status active | paused | inactive | error
  priority integer
  last_seen_tx_hash nullable
  last_seen_ledger nullable
  last_checked_at nullable
  last_hot_sync_at nullable
  last_archive_sync_at nullable
  archive_marker jsonb nullable
  last_archive_ledger nullable
  last_error nullable
  created_at
  updated_at

pftl_transactions
  tx_hash primary key
  ledger_index bigint nullable
  tx_type text nullable
  validated boolean
  account text nullable
  destination text nullable
  transaction_result text nullable
  close_time timestamptz nullable
  tx_json jsonb not null
  meta_json jsonb nullable
  first_seen_at
  updated_at

pftl_wallet_transactions
  wallet_address
  tx_hash references pftl_transactions(tx_hash)
  direction inbound | outbound | self | affected
  counterparty_wallet nullable
  delivered_drops text nullable
  fee_drops text nullable
  first_seen_at
  primary key(wallet_address, tx_hash)

pftl_pointer_memos
  tx_hash references pftl_transactions(tx_hash)
  memo_index integer
  wallet_address nullable
  memo_type text
  memo_format text
  pointer_kind text nullable
  schema_version text nullable
  cid text nullable
  task_id text nullable
  request_id text nullable
  context_id text nullable
  thread_id text nullable
  memo_data_hex text not null
  decoded_json jsonb not null default '{}'
  created_at
  unique(tx_hash, memo_index)

pftl_cache_watcher_state
  id primary key
  endpoint_url
  status idle | connecting | connected | reconnecting | failed
  subscribed_wallet_count
  last_ledger_index
  last_event_tx_hash
  last_event_at
  last_error
  metadata_json

pftl_cache_reducer_events
  id primary key
  dedupe_key unique
  wallet_address
  account_id
  tx_hash
  ledger_index
  reducer_kind wallet_balance_refresh | context_pointer_hydrate | task_projection_replay
  pointer_kind nullable
  cid nullable
  task_id nullable
  context_id nullable
  memo_index nullable
  status pending | processing | completed | failed
  payload_json
```

The app already has `pftl_task_pointer_events`, `task_events`, and `task_projections`. Those should become task-specific reductions fed by `pftl_pointer_memos` plus hydrated IPFS payloads.

## Sync Strategy

The production design should have two lanes.

Fast lane:

1. Add wallets to `pftl_sync_wallets` when a wallet is linked, relinked, created, assigned as an allocation wallet, assigned as an authority wallet, or used by a service.
2. WSS watcher subscribes to active wallets in shards using the PFTL `accounts` stream.
3. On validated activity, it upserts the transaction immediately, links affected watched wallets, decodes pointer memos, and creates reducer events.
4. The same reducer events are created by `account_tx` hot sync so reconnect/backfill repair uses the same downstream path as live WSS events.
5. The reducer worker consumes `pftl_cache_reducer_events`: context pointers become context history rows, task pointers hydrate/decrypt IPFS payloads with the Task Node service key and rebuild task projections, and wallet balance refresh events mark the wallet feed stale/complete without blocking reads.
6. API reads from Postgres first. If stale, it may enqueue sync work and return a visible syncing status.

The state-change trigger is native account activity, not balance polling. `accounts_proposed` can be added later for optimistic UI, but canonical cache updates use validated transactions only.
The polling repair worker first checks `account_info.PreviousTxnID`; if it matches the cached checkpoint, it marks the wallet checked without running `account_tx`.

Archive lane:

1. Full history jobs paginate `account_tx` against the archive RPC using opaque markers.
2. Archive jobs run in the background and checkpoint marker progress in `pftl_sync_wallets.archive_marker`.
3. Context history, task replay, and audit pages use archive-complete rows when available.
4. If archive history is incomplete, the UX should say that sync is in progress rather than silently showing incomplete state.

Archive completeness is tracked per wallet. The checkpoint shape is:

```json
{
  "complete": false,
  "marker": {},
  "scannedTransactions": 200,
  "pages": 1,
  "updatedAt": "ISO-8601"
}
```

When `complete` becomes `true`, `marker` is cleared. The marker is the opaque PFTL/XRPL `account_tx` marker and must be treated as a resume token, not parsed app state.

### Archive Worker Details

The archive worker is intentionally slow and resumable. It does not run inside user request paths.

| Config | Default | Meaning |
| --- | --- | --- |
| `PFTL_CACHE_ARCHIVE_WORKER_ENABLED` | `true` in local Docker/Fly config | Starts the background archive worker in `server/index.js`. |
| `PFTL_CACHE_ARCHIVE_WORKER_INTERVAL_MS` | `300000` | Worker tick interval. |
| `PFTL_CACHE_ARCHIVE_BATCH_LIMIT` | `1` | Number of wallets to archive per tick. Kept low to avoid hammering archive RPC. |
| `PFTL_CACHE_ARCHIVE_MAX_PAGES` | `1` | Number of `account_tx` pages per wallet per tick. |
| `PFTL_CACHE_ARCHIVE_ACCOUNT_TX_LIMIT` | `200` | Page size for archive `account_tx`. |

On each tick:

1. `listPftlWalletsDueForArchiveSync` selects active wallets whose archive marker is not complete and whose archive sync is stale.
2. `syncPftlWalletArchive` reads the last `archive_marker.marker`.
3. `fetchHistoricalAccountTransactions` calls archive `account_tx` with that marker.
4. `storePftlAccountTransactions` upserts global tx rows, wallet index rows, and pointer memo rows.
5. `enqueuePftlReducerEventsForTransaction` queues the same reducer events used by hot sync.
6. `recordPftlArchiveCheckpoint` saves the next marker or marks the wallet complete.

If a process dies after a page is stored but before the archive completes, the next tick resumes from the checkpoint. Reprocessing a page is safe because transaction, wallet index, pointer memo, and reducer event writes are idempotent.

## API Compatibility

Expose a cache read that can return a native `account_tx`-like shape:

```text
GET /api/pftl/cache/account-tx?wallet=r...&limit=100&before_ledger=...
```

Response shape should include:

```json
{
  "ok": true,
  "source": "pftl_cache",
  "walletAddress": "r...",
  "transactions": [
    {
      "tx": {},
      "meta": {},
      "validated": true,
      "hash": "..."
    }
  ],
  "sync": {
    "status": "ready|syncing|stale|archive_incomplete",
    "lastHotSyncAt": "ISO-8601",
    "lastArchiveSyncAt": "ISO-8601"
  }
}
```

This lets Python replay tools, task reducers, wallet feeds, and future message sync code query one substrate instead of each surface reimplementing `account_tx`.

## Product Consumers

| Surface | Cache usage |
| --- | --- |
| Wallet | Activity feed reads `pftl_wallet_transactions` joined to `pftl_transactions`; balance can still read live `account_info` because it is cheap and current. |
| Context | Historical context restore reads `pftl_pointer_memos` for `CONTEXT` pointers and hydrates/decrypts only selected CIDs. |
| Tasks | Replay workers read task pointer rows, hydrate IPFS, reduce into `task_events`, and rebuild `task_projections`. |
| Chat / Agents | Future wallet-native messages can read pointer memos and message payload CIDs without request-path RPC scans. |
| Help / Audit | Debug pages can show sync state, archive completeness, and raw tx hashes without touching RPC. |

## Operational Rules

- Cache writes must be idempotent by `tx_hash` and `(wallet_address, tx_hash)`.
- Pointer memo rows must preserve raw `memo_data_hex` even if decode fails.
- Worker jobs should use per-wallet throttling and avoid duplicate pending hot-sync jobs.
- WSS is latency optimization; polling is the reliability backstop.
- Archive RPC should be used for historical completeness; the local rapid RPC is acceptable for hot path and balance reads.
- Request handlers should not block on archive sync.
- Deleting cache rows must be repairable by replaying PFTL history.
- Retention is conservative: completed reducer events can be pruned after their projections are written, but raw wallet transactions and pointer memos stay retained unless an explicit cold-storage policy is enabled.
- On Fly dev, the watcher runs inside the app process while the machine is awake; startup backfill repairs missed activity after sleep. A public production deployment should run this as an always-on worker or keep at least one machine running.

## Operator Monitoring

Operators can query:

```text
GET /api/pftl/cache/health
```

The endpoint requires a signed-in account listed in `TASKNODE_OPERATOR_ACCOUNT_IDS` or `TASKNODE_ADMIN_ACCOUNT_IDS`. Local development allows signed-in access unless `PFTL_CACHE_OPERATOR_ALLOW_LOCAL=false`.

The response reports:

- tracked wallet counts, stale hot-sync counts, archive-complete and archive-incomplete counts;
- reducer queue depth by status;
- WSS watcher state, last ledger, subscribed wallet count, and recent errors;
- transaction, wallet-transaction, and pointer memo row counts;
- recent maintenance runs such as retention.

Useful fields:

| Field | How to read it |
| --- | --- |
| `wallets.hot_stale` | Active wallets that need hot repair. If this grows, WSS/polling is falling behind or RPC is unavailable. |
| `wallets.archive_incomplete` | Active wallets that still need historical archive backfill. This is expected to be nonzero during rollout. |
| `wallets.archive_stale` | Archive-incomplete wallets that have not made archive progress within the configured threshold. |
| `wallets.error_count` | Wallets with a recorded sync error. Check `recentErrors`. |
| `reducerQueue.pending` | Work still waiting to reduce into wallet/context/task projections. |
| `reducerQueue.failed` | Reducer failures that need repair. |
| `watchers[].status` | WSS watcher status. `connected` is expected when the app process is awake. |
| `watchers[].subscribed_wallet_count` | Number of active wallets subscribed by the watcher. |
| `maintenanceRuns[]` | Recent retention or maintenance summaries. |

This endpoint is for operators. Normal users should not need to know what WSS, archive RPC, or reducer queues are.

## Retention Policy

The retention worker is intentionally narrow:

- `pftl_cache_reducer_events` with `status='completed'` and old `processed_at` are pruned after `PFTL_CACHE_RETENTION_COMPLETED_REDUCER_DAYS` days.
- Raw `pftl_transactions`, `pftl_wallet_transactions`, and `pftl_pointer_memos` are not pruned by default.
- Orphan raw transaction pruning exists only behind `PFTL_CACHE_RETENTION_RAW_TX_ENABLED=true` and only touches transactions that have no wallet index rows and no pointer memo rows.

This preserves replayability while keeping the queue table from growing without bound.

The important product decision is that reducer events are operational queue rows, but transaction and pointer rows are replay substrate. Deleting completed reducer events does not remove evidence of a task, context pointer, reward, or wallet transaction. Deleting raw transaction/pointer rows would reduce replayability, so that remains off by default.

## Migration Plan

1. Add `pftl_sync_wallets`, `pftl_transactions`, `pftl_wallet_transactions`, and `pftl_pointer_memos`.
2. Register linked user wallets and system task wallets into `pftl_sync_wallets`.
3. Add a worker hot-sync service and a read-only account-tx cache endpoint.
4. Move Wallet activity feed from direct RPC to cache-first reads.
5. Move context history import to cache-first pointer reads, with archive job fallback.
6. Move task replay/indexing to consume pointer memo rows and write `task_projections`.
7. Add retention/partition policy once volume is known.

## Open Decisions

- Whether to keep full `tx_json` forever in Postgres or move old raw transactions to cold storage after projections are built.
- Whether task authority and allocation wallets should be inserted by static config, a provisioner table, or both.
- Whether archive completeness is tracked per wallet only, or per wallet plus pointer kind.
- Whether the cache endpoint should be public to authenticated users for their linked wallet only, or operator-only at first.

## Initial Implementation

The first implementation slice is live in code:

- `server/db/migrations/007_pftl_transaction_cache.sql` creates the cache schema.
- `server/db/migrations/008_pftl_cache_watcher.sql` creates watcher state and reducer event tables.
- `server/db/migrations/009_pftl_cache_reducer_dedupe_key.sql` makes reducer event dedupe explicit for idempotent repair.
- `server/db/migrations/010_pftl_cache_operations.sql` adds archive/retention indexes and maintenance run records.
- `server/repositories/pftl-cache.js` maps `account_tx` rows into transaction, wallet index, and pointer memo rows.
- `server/repositories/pftl-cache-operations.js` holds operator health and retention queries.
- `server/pftl-cache-sync.js` performs cache sync from PFTL `account_tx`, creates reducer events, exposes the polling worker gated by `PFTL_CACHE_WORKER_ENABLED=true`, and runs resumable archive backfill gated by `PFTL_CACHE_ARCHIVE_WORKER_ENABLED=true`.
- `server/pftl-cache-watcher.js` subscribes to PFTL WSS account activity, stores validated events, records watcher state, and backfills on startup/reconnect/ledger gaps.
- `server/pftl-cache-reducer.js` consumes reducer events and writes context history plus task projections.
- `server/pftl-cache-maintenance.js` exposes operator health and starts the conservative retention worker.
- `/api/pftl/cache/account-tx` returns cached `account_tx`-style rows for the signed-in account's linked wallet.
- `/api/pftl/cache/health` returns operator-only sync, reducer, watcher, archive, and retention status.
- `/api/wallet/transactions` is cache-first and falls back to direct PFTL history while the cache rolls out.
- Wallet link/create registers the wallet for sync; wallet delink marks it inactive.
- `npm run db:pftl-cache-watcher-stress` runs a deterministic 10-wallet cache stress test.
- `npm run db:pftl-cache-reducer-smoke` proves reducer events update context history and task projections.
- `npm run db:pftl-cache-archive-smoke` proves archive markers resume and complete.
- `npm run db:pftl-cache-health-retention-smoke` proves operator health and completed reducer-event retention.

Full context cache-first migration and full task replay recovery tooling remain milestone work.
