# PFTL Archive Wallet Sync

The PFTL Archive Wallet Sync backfills historical wallet transactions through
the archive/history RPC path. It is separate from hot sync so long account
history cannot block current wallet reads.

System Status row: `pftl_archive_sync`

## Runtime Boundary

- Source table: `pftl_sync_wallets`.
- Archive fields: `archive_marker` and `last_archive_sync_at`.
- History RPC config: `PFTL_HISTORY_RPC_URL` and related fallbacks.
- Related docs: PFTL Transaction Cache.

## Status Derivation

Green means archive sync is enabled and every active wallet is marked archive
complete, or the latest archive sync is fresh while backfill remains in
progress.

Amber means active wallets still need archive backfill and are lagging.

Red means archive sync is stale or enabled with no usable archive evidence.

## Debug And Repair

Run the archive smoke:

```bash
npm run db:pftl-cache-archive-smoke
```

Inspect `pftl_sync_wallets.archive_marker`, `last_archive_sync_at`, and
`last_error`. Fix history RPC config before clearing markers. Do not mark a
wallet complete unless the archive worker actually reached the end of
`account_tx`.
