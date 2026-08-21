# PFTL WSS Watcher

The PFTL WSS Watcher listens to current ledger websocket updates and records the
latest watcher checkpoint. It reduces wallet and pointer latency, while the hot
polling path remains the fallback when websocket service is degraded.

System Status row: `pftl_wss_watcher`

## Runtime Boundary

- Source table: `pftl_cache_watcher_state`.
- WSS config: `PFTL_WSS_URL` and related TLS/reconnect settings.
- Worker modules: PFTL cache watcher scripts and runtime watcher helpers.

## Status Derivation

Green means the watcher heartbeat/checkpoint is current.

Amber means the watcher is lagging.

Red means the watcher is enabled but stale or missing.

## Debug And Repair

Run the watcher stress check and Fly worker guard:

```bash
npm run db:pftl-cache-watcher-stress
npm run fly:background-guard
```

Inspect websocket URL, TLS settings, reconnect logs, and watcher state. If WSS
is down but polling sync is green, the app may still be usable, but this row
should remain amber or red until websocket updates resume.
