# PFTL Cache Reducer

The PFTL Cache Reducer turns observed PFTL pointer transactions into product
read models such as task events, task projections, context history, and wallet
transaction details.

System Status row: `pftl_cache_reducer`

## Runtime Boundary

- Source table: `pftl_cache_reducer_events`.
- Projection targets include `task_events`, `task_projections`, context history,
  and cache-specific read models.
- Repair scripts: `scripts/pftl-reducer-requeue.mjs`,
  `scripts/task-replay-repair.mjs`, and `scripts/data-architecture-audit.mjs`.

## Status Derivation

Green means completed reducer events are fresh, no pending or processing event
is stale, and no reducer failures were updated recently.

Amber is not used for current reducer failures because fresh projection failures
are correctness failures.

Red means recent reducer failures exist or the reducer queue is stale.

## Debug And Repair

Audit before requeueing:

```bash
npm run data-architecture-audit
npm run pftl-reducer-requeue -- --id=<event_id> --apply
npm run task-replay-repair -- --task-id=<task_id> --apply
```

Use audit output to distinguish historical ignored rows from current projection
drift. Requeue one reducer event at a time unless a bounded script proves the
failure class is repaired.
