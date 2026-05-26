# PFTL History RPC And Archive WSS

The history PFTL RPC and archive WSS configuration backs historical wallet
backfill, context restore, and any account transaction lookup that cannot be
answered from the current-ledger hot path.

System Status row: `pftl_history_rpc`

## Runtime Boundary

- RPC config: `PFTL_HISTORY_RPC_URL` and history fallbacks.
- Archive WSS config: archive websocket settings when configured.
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

History RPC failures affect context restore, old wallet transaction history, and
archive backfill. Fix endpoint config before editing archive markers.
