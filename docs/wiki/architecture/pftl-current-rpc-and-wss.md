# PFTL Current RPC And WSS

The current PFTL RPC and WSS configuration backs live balance reads, transaction
submission, current ledger polling, websocket watcher updates, and hot wallet
sync.

System Status row: `pftl_current_rpc`

## Runtime Boundary

- RPC config: `PFTL_RPC_URL` and `PFTL_RPC_URL_FALLBACKS`.
- WSS config: `PFTL_WSS_URL`.
- Dependent status row: `pftl_hot_sync`.
- Related docs: PFTL Usage and PFTL Transaction Cache.

## Status Derivation

Green means current endpoints are configured and hot sync is green.

Amber means endpoints exist but hot sync is amber.

Red means required current endpoints are missing or hot sync is red.

## Debug And Repair

Check Fly secrets and current-cache smoke:

```bash
fly secrets list -a tasknodeofficial-dev
npm run pftl-cache-smoke
```

Confirm current RPC and WSS secrets are present in the app and worker process
groups. A current RPC problem affects wallet balance reads, task submissions,
reward submissions, and hot sync polling.
