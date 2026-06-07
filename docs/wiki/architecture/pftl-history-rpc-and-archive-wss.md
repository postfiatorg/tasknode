# PFTL History RPC And Archive WSS

The history PFTL RPC and archive WSS configuration backs historical wallet
backfill, context restore, and any account transaction lookup that cannot be
answered from the current-ledger hot path.

System Status row: `pftl_history_rpc`

## Runtime Boundary

- RPC config: `PFTL_HISTORY_RPC_URL` and history fallbacks when explicitly
  configured.
- If no history-specific RPC is configured, the helper falls back to the app's
  current `PFTL_RPC_URL` and `PFTL_RPC_URL_FALLBACKS`. Local operator tools such
  as Deathmarch depend on this so recent rewards are read from the live PFTL
  node instead of silently drifting to stale archive defaults.
- Archive WSS config: `PFTL_HISTORY_WSS_URL` when explicitly configured. If it
  is absent, the helper may use the app's current `PFTL_WSS_URL` before RPC
  fallback.
- Dependent status row: `pftl_archive_sync`.
- Related docs: PFTL Usage and PFTL Transaction Cache.

## Status Derivation

Green means archive endpoints are configured and archive sync is green.

Amber means endpoints exist but archive sync is amber.

Red means history endpoints are missing or archive sync is red.

## Debug And Repair

Check Fly secrets and archive-cache smoke:

```bash
fly secrets list -a tasknodeofficial-dev
npm run db:pftl-cache-archive-smoke
```

History RPC failures affect context restore, old wallet transaction history,
archive backfill, and local wallet-history tools. If recent on-chain actions are
missing from an operator tool, first confirm which endpoints `historyRpcConfig`
selected before editing archive markers.
