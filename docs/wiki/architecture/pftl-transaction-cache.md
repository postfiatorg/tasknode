# PFTL Transaction Cache

## Decision

Task Node Official should add a Postgres-native PFTL transaction mirror for every wallet the app is responsible for tracking: linked user wallets, task authority wallets, allocation reward wallets, treasury wallets, and service wallets that publish pointer activity.

The cache is not canonical. PFTL remains canonical for wallet activity, pointer memos, task lifecycle events, and rewards. The cache exists so app reads do not depend on live `account_tx` scans, shallow RPC history, or archive RPC latency.

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
5. API reads from Postgres first. If stale, it may enqueue sync work and return a visible syncing status.

The state-change trigger is native account activity, not balance polling. `accounts_proposed` can be added later for optimistic UI, but canonical cache updates use validated transactions only.
The polling repair worker first checks `account_info.PreviousTxnID`; if it matches the cached checkpoint, it marks the wallet checked without running `account_tx`.

Archive lane:

1. Full history jobs paginate `account_tx` against the archive RPC using opaque markers.
2. Archive jobs run in the background and checkpoint marker progress.
3. Context history, task replay, and audit pages use archive-complete rows when available.
4. If archive history is incomplete, the UX should say that sync is in progress rather than silently showing incomplete state.

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
- On Fly dev, the watcher runs inside the app process while the machine is awake; startup backfill repairs missed activity after sleep. A public production deployment should run this as an always-on worker or keep at least one machine running.

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
- `server/repositories/pftl-cache.js` maps `account_tx` rows into transaction, wallet index, and pointer memo rows.
- `server/pftl-cache-sync.js` performs cache sync from PFTL `account_tx`, creates reducer events, and exposes an optional polling worker gated by `PFTL_CACHE_WORKER_ENABLED=true`.
- `server/pftl-cache-watcher.js` subscribes to PFTL WSS account activity, stores validated events, records watcher state, and backfills on startup/reconnect/ledger gaps.
- `/api/pftl/cache/account-tx` returns cached `account_tx`-style rows for the signed-in account's linked wallet.
- `/api/wallet/transactions` is cache-first and falls back to direct PFTL history while the cache rolls out.
- Wallet link/create registers the wallet for sync; wallet delink marks it inactive.
- `npm run db:pftl-cache-watcher-stress` runs a deterministic 10-wallet cache stress test.

The archive-completeness policy, context cache-first migration, task replay reducer execution, and retention/monitoring remain milestone work.
