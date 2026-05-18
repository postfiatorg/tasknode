# PFTL Transaction Cache Milestone

## Objective

Build a Postgres-native PFTL transaction cache so Task Node Official can query linked wallet history, task pointer events, context pointer events, rewards, and future wallet-native messages without repeatedly scanning `account_tx` in request paths.

PFTL remains canonical. Postgres is a fast, repairable mirror and projection substrate.

## Why This Milestone Exists

The current app still has several direct PFTL history readers:

- Wallet activity calls `account_tx` through `server/pftl-transactions.js`.
- Historical context restore calls archive `account_tx` through `server/context-history-rpc.js`.
- Task replay imports currently come from Python receipts and `task_projections`, not a standing wallet transaction index.
- Future message/agent surfaces will need fast memo and MessageKey discovery.

That will not scale. It also makes UX correctness depend on whichever RPC node a surface happens to hit. PFTasks solved this class of problem with a DB-backed transaction mirror; this milestone ports the useful architecture while avoiding the PFTasks request-path sync problems.

## Reference Boundary

Use PFTasks as the implementation reference:

- `pftasks/api/migrations/026_tx_sync_engine.sql`
- `pftasks/api/migrations/027_wallet_sync_state.sql`
- `pftasks/api/migrations/065_messages_synced_at.sql`
- `pftasks/api/src/services/tx_sync_service.js`
- `pftasks/worker/src/lib/tx_sync_scheduler.js`
- `pftasks/worker/src/lib/tx_sync_ws.js`
- `pftasks/worker/src/jobs/tx_sync_hot.js`
- `pftasks/worker/src/jobs/tx_sync_full.js`
- `pftasks/api/migrations/002_chain_indexer.sql`
- `pftasks/worker/src/jobs/chain_indexer.js`

Do not use the deleted `pftasknode` repository as the source for this milestone.

## Target Product Behavior

When a wallet is linked, created, relinked, or assigned as a Task Node system wallet, the backend registers it for sync. Background workers keep its transaction history warm. App surfaces read the cache first.

Expected user-facing outcomes:

- Wallet activity feed loads from Postgres quickly.
- Historical context restore can show indexed pointer history without a fresh archive scan every time.
- Task projections can be rebuilt from cached pointer memos plus encrypted IPFS payloads.
- RPC outages show as stale/syncing cache state, not blank or fake product data.
- Deleting projection rows remains repairable by replaying PFTL history.

## Current Implementation Status

Initial backend slice implemented:

- Cache migration: `server/db/migrations/007_pftl_transaction_cache.sql`.
- Watcher/reducer migration: `server/db/migrations/008_pftl_cache_watcher.sql`.
- Reducer dedupe migration: `server/db/migrations/009_pftl_cache_reducer_dedupe_key.sql`.
- Cache repository: `server/repositories/pftl-cache.js`.
- Sync helper and optional polling worker: `server/pftl-cache-sync.js`.
- Native WSS watcher: `server/pftl-cache-watcher.js`.
- Reducer worker: `server/pftl-cache-reducer.js`.
- Cache endpoint: `GET /api/pftl/cache/account-tx`.
- Wallet activity feed: cache-first read with direct PFTL fallback during rollout.
- Wallet lifecycle: link/create registers a sync target; delink marks it inactive.
- Local/docker/fly config enables the WSS watcher, polling repair worker, and reducer worker.
- Deterministic 10-wallet stress script: `npm run db:pftl-cache-watcher-stress`.
- Reducer smoke script: `npm run db:pftl-cache-reducer-smoke`.
- Archive resume smoke script: `npm run db:pftl-cache-archive-smoke`.
- Health/retention smoke script: `npm run db:pftl-cache-health-retention-smoke`.
- Operator health endpoint: `GET /api/pftl/cache/health`.
- Archive backfill worker: `PFTL_CACHE_ARCHIVE_WORKER_ENABLED=true`.
- Conservative retention worker: `PFTL_CACHE_RETENTION_WORKER_ENABLED=true`.

Still open:

- Context restore migration to cache-first pointer reads.
- Full replay recovery tooling from cache rows after deleting projections.
- Raw transaction cold-storage policy for public scale.

## Proposed Tables

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
  status
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
  reducer_kind
  pointer_kind nullable
  cid nullable
  task_id nullable
  context_id nullable
  memo_index nullable
  status
  payload_json
```

## Phase 1: Schema And Repository

Work:

- Add migration for the four cache tables.
- Add repository functions for wallet registration, transaction upsert, wallet index upsert, pointer memo upsert, and cache reads.
- Decode `pf.ptr` / `v4` memos into `pftl_pointer_memos` while preserving raw `memo_data_hex` when decode fails.
- Add an account-tx-like cache read helper.

Acceptance criteria:

- Running migrations creates the cache tables and indexes.
- Upserting the same transaction twice is idempotent.
- One transaction can be indexed for multiple wallets.
- Pointer memo decode failures preserve raw memo data and do not fail the whole tx.

## Phase 2: Sync Workers

Work:

- Add `pftl_tx_sync_hot` worker job for recent `account_tx` pulls.
- Add `pftl_tx_sync_archive` worker job for paginated archive backfill.
- Add WSS watcher that subscribes to active wallets in shards and enqueues hot sync on validated activity.
- Store the validated WSS transaction immediately and enqueue the same reducer events used by hot sync.
- Add polling repair using `account_info.PreviousTxnID` before falling back to `account_tx`.
- Add duplicate-job suppression and per-wallet cooldown.
- Add reducer worker for `wallet_balance_refresh`, `context_pointer_hydrate`, and `task_projection_replay`.

Acceptance criteria:

- A linked wallet receives a hot sync job when a new validated transaction lands.
- Polling catches changes if WSS is unavailable.
- Archive sync checkpoints markers and can resume.
- Worker failures update `last_error` without corrupting existing cache rows.

## Phase 3: Wallet Activity Feed

Work:

- Move `/api/wallet/transactions` from direct `account_tx` to cache-first reads.
- On force refresh, enqueue hot sync and return current cache with sync state.
- Preserve the current wallet feed response shape where practical.

Acceptance criteria:

- Wallet page renders cached transactions with PFT amounts, direction, counterparty, pointer labels, and tx hashes.
- If cache is empty, the API returns `syncing` or `archive_incomplete` rather than a misleading empty success.
- Request path does not block on archive history.

## Phase 4: Context History

Work:

- Make context historical restore read `pftl_pointer_memos` first for `CONTEXT` pointers.
- Use direct archive `account_tx` only as a backfill trigger, not the primary page-load path.
- Preserve existing wallet unlock/decrypt boundaries for previews and restore.

Acceptance criteria:

- Historical context versions populate from cached pointer rows.
- Delinking a wallet hides wallet-derived history but does not delete current native context.
- Missing archive sync shows a clear sync status.

## Phase 5: Task Replay Integration

Work:

- Feed task replay from `pftl_pointer_memos` instead of only imported Python receipts.
- Hydrate task CIDs from IPFS.
- Decrypt service-readable payloads.
- Reduce events into `task_events` and `task_projections`.

Acceptance criteria:

- Deleting task projection rows and rerunning replay rebuilds tasks from cached PFTL pointers plus IPFS.
- Missing CIDs or decrypt failures produce visible `sync_status`, not fake task cards.
- Reward transactions remain traceable to allocation wallet tx hashes.

## Phase 6: Monitoring And Retention

Work:

- Add sync health queries for total tracked wallets, fresh/stale wallets, reducer depth, watcher state, archive completeness, and recent maintenance runs.
- Add operator diagnostics for recent sync errors through `GET /api/pftl/cache/health`.
- Prune completed reducer events after projections are written and old enough.
- Keep raw transaction rows, wallet index rows, and pointer memos by default; only orphan raw transactions can be pruned behind explicit config.

Acceptance criteria:

- Operator can see whether WSS, polling, hot sync, and archive sync are healthy.
- Large raw transaction storage has a documented retention or cold-storage plan before public scale.

Status:

- Implemented in `server/pftl-cache-maintenance.js`, `server/repositories/pftl-cache.js`, and `server/db/migrations/010_pftl_cache_operations.sql`.
- `PFTL_CACHE_RETENTION_COMPLETED_REDUCER_DAYS` controls completed reducer event retention.
- `PFTL_CACHE_RETENTION_RAW_TX_ENABLED=false` keeps raw transaction pruning disabled by default.
- `npm run db:pftl-cache-health-retention-smoke` proves the health query and scoped retention path.

## Non-Goals

- Do not make Postgres canonical for tasks.
- Do not require wallet unlock for cached wallet activity or context pointer metadata.
- Do not store wallet seeds, private keys, or decrypted historical context bodies.
- Do not block normal API reads on archive sync.
- Do not port PFTasks messaging UX as part of this milestone.

## Test Matrix

| Test | Proof |
| --- | --- |
| Migration smoke | Tables and indexes exist. |
| Fixture upsert | Transaction and wallet index writes are idempotent. |
| Pointer decode smoke | `pf.ptr/v4` memo rows decode into `pftl_pointer_memos`. |
| WSS watcher smoke | Account event matching and endpoint normalization work. |
| 10-wallet watcher stress | Ten wallet-affecting tx events populate tx, wallet index, pointer, and reducer rows idempotently. |
| Reducer smoke | A cached CONTEXT pointer writes context history and an encrypted TASK pointer writes `task_projections`. |
| WSS disabled | Polling/hot sync still repairs cache by account history. |
| Empty cache | API returns syncing/stale status instead of false completeness. |
| Wallet feed cache read | `/api/wallet/transactions` can render without direct RPC. |
| Context pointer restore | Context history reads pointer rows from cache. |
| Task replay rebuild | Task projection rows rebuild after deletion. |
| Archive resume | Archive marker resumes after interruption. |
| Operator health | Health endpoint reports stale wallets, archive completeness, watcher state, reducer queue depth, and recent errors. |
| Retention | Completed reducer events are pruned after policy age while raw transaction rows remain retained by default. |
| Duplicate tx | Repeated hot sync does not duplicate rows. |

## Implementation Order

1. Schema and repository.
2. Hot sync service with unit tests.
3. Cache read endpoint and wallet activity feed migration.
4. WSS watcher plus polling fallback.
5. Archive sync.
6. Context history cache-first migration.
7. Task replay cache integration.
8. Monitoring and retention.

## Done Definition

This milestone is done when a linked wallet can be registered, synced, queried from Postgres, and used by Wallet, Context, and Tasks without direct request-path `account_tx` scans. Cache loss must be recoverable by rerunning sync/replay against PFTL and IPFS.
