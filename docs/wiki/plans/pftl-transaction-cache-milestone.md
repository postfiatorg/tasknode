# PFTL Transaction Cache Milestone

## Objective

Maintain a Postgres-native PFTL transaction cache for linked user wallets and Task Node system wallets. PFTL remains canonical. The cache is a fast projection layer for Wallet, Context, Tasks, and operator monitoring.

## Current Architecture

The cache has four live ingestion and maintenance loops:

| Loop | Code | Function |
| --- | --- | --- |
| Live watcher | `server/pftl-cache-watcher.js` | Writes validated PFTL wallet activity into cache rows and reducer events. |
| Polling repair | `startPftlCacheWorker` | Checks `account_info.PreviousTxnID`; hot-syncs recent `account_tx` only when the wallet changed. |
| Historical backfill | `startPftlArchiveWorker` | Paginates historical `account_tx` using stored resume markers. |
| Retention | `startPftlCacheRetentionWorker` | Prunes completed reducer events while retaining transaction and pointer evidence. |

The reducer worker consumes `pftl_cache_reducer_events` and updates app projections:

```text
pftl_transactions
  -> pftl_wallet_transactions
  -> pftl_pointer_memos
  -> pftl_cache_reducer_events
  -> context_history_pointers / task_projections
```

## Current Product Behavior

- Wallet link/create registers the wallet in `pftl_sync_wallets`.
- Wallet delink marks the sync wallet inactive.
- `/api/wallet/transactions` reads from Postgres cache rows and returns visible sync status.
- `/api/pftl/cache/account-tx` returns cached `account_tx`-style rows for the signed-in account's linked wallet.
- `/api/pftl/cache/health` returns operator health for watcher, sync, backfill, reducer, and retention state.
- Context and Tasks projections are fed by reducer events from cached pointer memos.

## Current Tables

| Table | Purpose |
| --- | --- |
| `pftl_sync_wallets` | Wallet registry, sync status, checkpoint state, and errors. |
| `pftl_transactions` | Global raw transaction mirror keyed by tx hash. |
| `pftl_wallet_transactions` | Per-wallet transaction index. |
| `pftl_pointer_memos` | Raw and decoded pointer memo rows. |
| `pftl_cache_watcher_state` | WSS watcher status. |
| `pftl_cache_reducer_events` | Idempotent projection queue. |
| `pftl_cache_maintenance_runs` | Retention/maintenance run summaries. |
| `context_history_pointers` | Context projection rows created by reducer events. |
| `pftl_task_pointer_events`, `task_events`, `task_projections` | Task projection rows created by reducer events. |

## Historical Backfill Policy

Historical backfill is slow, resumable, and outside request paths.

Each wallet checkpoint is stored in `pftl_sync_wallets.archive_marker`:

```json
{
  "complete": false,
  "marker": {},
  "scannedTransactions": 200,
  "pages": 1,
  "updatedAt": "ISO-8601"
}
```

The marker is an opaque PFTL `account_tx` resume token. A completed wallet has `"complete": true` and `marker: null`.

Worker defaults:

```text
PFTL_CACHE_ARCHIVE_WORKER_ENABLED=true
PFTL_CACHE_ARCHIVE_WORKER_INTERVAL_MS=300000
PFTL_CACHE_ARCHIVE_BATCH_LIMIT=1
PFTL_CACHE_ARCHIVE_MAX_PAGES=1
PFTL_CACHE_ARCHIVE_ACCOUNT_TX_LIMIT=200
```

## Operator Health

`GET /api/pftl/cache/health` reports:

- tracked wallet counts;
- hot stale wallet count;
- historical backfill complete/incomplete/stale counts;
- reducer queue depth by status;
- WSS watcher state;
- transaction and pointer row counts;
- recent sync errors;
- recent retention/maintenance runs.

Production access requires `TASKNODE_OPERATOR_ACCOUNT_IDS` or `TASKNODE_ADMIN_ACCOUNT_IDS`.

## Retention Policy

The current retention policy deletes old completed reducer queue rows only.

Retained by default:

- `pftl_transactions`
- `pftl_wallet_transactions`
- `pftl_pointer_memos`

Reason: those rows are replay substrate. They preserve enough chain evidence to rebuild context and task projections from PFTL/IPFS.

## Verification

| Script | Coverage |
| --- | --- |
| `npm run pftl-cache-smoke` | Transaction normalization and pointer memo extraction. |
| `npm run pftl-cache-watcher-smoke` | Watcher event matching and polling RPC shape. |
| `npm run db:pftl-cache-smoke` | Postgres transaction, wallet index, and pointer writes. |
| `npm run db:pftl-cache-watcher-stress` | 10-wallet validated event ingestion and idempotency. |
| `npm run db:pftl-cache-reducer-smoke` | Context and task reducer projection writes. |
| `npm run db:pftl-cache-archive-smoke` | Historical marker resume and completion. |
| `npm run db:pftl-cache-health-retention-smoke` | Operator health and scoped completed-event retention. |

## Current Remaining Work

1. Add task replay recovery tooling from cached pointer rows plus IPFS payloads.
2. Define a public-scale cold-storage policy for raw transaction growth.

## Done Definition

The milestone is done when Wallet, Context, and Tasks read from the Postgres cache without request-time historical scans, and projection loss can be repaired from cached pointer rows plus PFTL/IPFS replay.

## Reviewer To Do List

Review implementation against this document (pftl transaction cache milestone). Mark each item when verified.

### Memory Efficiency
- [ ] Plan phases avoid loading unbounded history or corpus into single jobs.
- [ ] Derived read models prefer projections over duplicate materialized stores.

### Code Quality
- [ ] Done criteria map to testable checks or smoke commands.
- [ ] Status (implemented vs planned) accurate on every section.

### Coherence
- [ ] Plan does not contradict shipped behavior in Surfaces/Architecture docs.
- [ ] Dependencies on other plans explicitly named and still valid.

### Bloat
- [ ] Plan scoped to stated phase; future work not implied as shipped.
- [ ] Avoid duplicating full surface doc content; link instead.

### Security
- [ ] New tables/routes in plan include account ownership and encryption notes.
- [ ] Operator-only actions identified with audit requirements.
