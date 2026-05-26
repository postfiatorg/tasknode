# Task Generation Worker

The Task Generation worker claims signed task requests, decrypts the request
bundle, calls the task generation model, publishes a signed `pf.task.offer.v1`
pointer, syncs PFTL, and lets the reducer project the offer into the Tasks UI.

System Status row: `task_generation`

## Runtime Boundary

- Worker module: `server/task-generation-worker.js`.
- Prompt: `prompts/task_engine/taskgen_minimal_v1.md`.
- Source table: `task_requests`.
- Output protocol event: `pf.task.offer.v1`.
- Projection target: `task_projections` through PFTL reducer replay.

## Status Derivation

Green means the worker has no stale `published`, `queued`, or `generating`
requests and no recently failed request rows.

Amber means recently failed task request rows exist.

Red means a published, queued, or generating request is older than the stale
queue threshold.

## Debug And Repair

Use the lifecycle smoke and replay repair:

```bash
npm run task-lifecycle-smoke
npm run task-replay-repair -- --task-id=<task_id> --apply
```

Check `task_requests.last_error`, wallet seed availability, encryption identity,
IPFS pinning, PFTL submission config, and reducer state. Do not turn a failed
request into a fake visible task; visible tasks must come from replayed signed
task offer events.
