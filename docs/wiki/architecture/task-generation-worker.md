# Task Generation Worker

The Task Generation worker claims signed task requests, decrypts the request
bundle, calls the task generation model, publishes a signed `pf.task.offer.v1`
pointer, syncs PFTL, and lets the reducer project the offer into the Tasks UI.

System Status row: `task_generation`

## Runtime Boundary

- Worker module: `server/task-generation-worker.js`.
- Prompts: `prompts/task_engine/taskgen_personal_v1.md` for personal requests and `prompts/task_engine/taskgen_network_v1.md` for Network/Alpha routing packets.
- Source table: `task_requests`.
- Output protocol event: `pf.task.offer.v1`.
- Projection target: `task_projections` through PFTL reducer replay.

## Status Derivation

Green means the worker has no stale `published`, `queued`, or `generating`
requests and no recently failed request rows.

Amber means recently failed task request rows exist.

Red means a published, queued, or generating request is older than the stale
queue threshold.

Network Task allocations are different from user-created task requests. If a
Board Manager-generated request fails before a `pf.task.offer.v1` exists, the
worker closes the allocation/job/intent chain through
`fail_network_task_generation_chain` and marks the task request operator-hidden.
Those failures are audit records, not work the user can act on, so they must not
appear in the Tasks request strip as `Needs attention`.

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

If the automatic Network Task repair did not run, use:

```bash
npm run network-task-allocation-repair -- fail --request-id <request_id> --reason "<reason>" --execute
```

That marks the allocation failed, marks the generation job failed, stales the
semantic intent, and hides the request receipt from the user-facing request
queue.
