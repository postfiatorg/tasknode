# PFTL Hot Wallet Sync

The PFTL Hot Wallet Sync keeps active wallet balances and recent transactions
current through the current-ledger RPC path. This is the fast wallet cache path
used by balances, recent transaction views, and task submission/reward follow-up.

System Status row: `pftl_hot_sync`

## Runtime Boundary

- Source table: `pftl_sync_wallets`.
- Current RPC config: `PFTL_RPC_URL` and fallbacks.
- Worker/runtime modules: PFTL cache sync and wallet cache helpers.
- Related docs: PFTL Transaction Cache.

## Status Derivation

Green means recent hot sync or checked timestamps exist and no active wallet is
severely stale.

Amber means one or more active wallets are severely stale.

Red means the worker is enabled but has no hot sync data or the latest hot sync
is beyond the stale threshold.

## Debug And Repair

Run cache and watcher smoke checks:

```bash
npm run db:pftl-cache-smoke
npm run pftl-cache-watcher-smoke
```

Confirm `PFTL_CACHE_WORKER_ENABLED=true` and current PFTL RPC endpoints are
configured. If unchanged wallets are aging, verify the checked timestamp path
updates `last_hot_sync_at` or its checked equivalent.
