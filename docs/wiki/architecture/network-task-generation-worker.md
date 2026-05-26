# Network Task Generation Worker

The Network Task Generation worker turns a Board Manager allocation into a
normal task request and then hands it to the standard task engine. It does not
create a separate lifecycle: generated work must become a signed PFTL task offer
and project into `task_projections`.

System Status row: `network_task_generation`

## Runtime Boundary

- Worker module: `server/network-task-generation-worker.js`.
- Repository module: `server/repositories/network-tasks.js`.
- Source table: `network_task_generation_jobs`.
- Board Manager action: `allocate_network_task`.
- Repair path: `scripts/network-task-recovery.mjs`.

## Status Derivation

Green means generation jobs are completing and no queued or running job is
stale.

Amber means recent `failed` or `link_failed` generation jobs exist.

Red means a queued or running generation job is stale.

## Debug And Repair

Run recovery first; it understands generated requests, allocation links, Hive
mirrors, and task projections:

```bash
npm run network-task-recovery
npm run network-task-recovery-smoke
```

Inspect `network_task_generation_jobs.last_error`, generated request IDs, and
allocation IDs. If the task request was generated but allocation linking failed,
reconcile through recovery instead of creating a duplicate request.
