# PFTL Cache Retention

The PFTL Cache Retention worker prunes safe cache maintenance noise while
preserving transaction, pointer, task, wallet, and audit evidence. It is a health
and storage-control job, not a correctness repair path.

System Status row: `pftl_cache_retention`

## Runtime Boundary

- Source table: `pftl_cache_maintenance_runs`.
- Related worker code: PFTL cache health/retention maintenance scripts.
- Related docs: PFTL Transaction Cache.

## Status Derivation

Green means the retention worker has a fresh completed maintenance run.

Amber means the retention run is lagging.

Red means the worker is enabled but stale beyond the retention threshold or the
latest maintenance run failed.

## Debug And Repair

Run the retention smoke:

```bash
npm run db:pftl-cache-health-retention-smoke
```

Inspect `pftl_cache_maintenance_runs` and retention environment flags. Retention
should delete completed reducer noise only. Do not delete transaction, wallet,
pointer, or task projection evidence to make the status row green.
