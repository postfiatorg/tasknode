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
- Cache repository: `server/repositories/pftl-cache.js`.
- Sync helper and optional polling worker: `server/pftl-cache-sync.js`.
- Cache endpoint: `GET /api/pftl/cache/account-tx`.
- Wallet activity feed: cache-first read with direct PFTL fallback during rollout.
- Wallet lifecycle: link/create registers a sync target; delink marks it inactive.

Still open:

- WSS watcher.
- Archive backfill job with long-running checkpoint policy.
- Context restore migration to cache-first pointer reads.
- Task replay migration from `pftl_pointer_memos` into `task_projections`.
- Operator monitoring and retention policy.

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
- Add polling watcher using `account_info.PreviousTxnID` as reliability fallback.
- Add duplicate-job suppression and per-wallet cooldown.

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

- Add sync health queries for total tracked wallets, fresh/stale wallets, job depth, and archive completeness.
- Add operator diagnostics for recent sync errors.
- Decide retention policy for raw `tx_json` and old wallet index rows.

Acceptance criteria:

- Operator can see whether WSS, polling, hot sync, and archive sync are healthy.
- Large raw transaction storage has a documented retention or cold-storage plan before public scale.

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
| WSS disabled | Polling watcher still detects `PreviousTxnID` change. |
| Empty cache | API returns syncing/stale status instead of false completeness. |
| Wallet feed cache read | `/api/wallet/transactions` can render without direct RPC. |
| Context pointer restore | Context history reads pointer rows from cache. |
| Task replay rebuild | Task projection rows rebuild after deletion. |
| Archive resume | Archive marker resumes after interruption. |
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
