# Task Generation Worker

The Task Generation worker claims signed task requests, decrypts the request
bundle, calls the task generation model, publishes a signed `pf.task.offer.v1`
pointer, syncs PFTL, and lets the reducer project the offer into the Tasks UI.

System Status row: `task_generation`

## Runtime Boundary

- Worker module: `server/task-generation-worker.js`.
- Prompts: `prompts/task_engine/taskgen_personal_v1.md` for personal requests and `prompts/task_engine/taskgen_network_v1.md` for Network/Alpha routing packets.
- Source table: `task_requests`.
- Replay table: `taskgen_replay_cache`.
- Output protocol event: `pf.task.offer.v1`.
- Projection target: `task_projections` through PFTL reducer replay.

## Retry Idempotency

Task generation is not expected to make identical prose from a fresh model call.
It is expected to avoid publishing a different live task for the same generation
input. The worker builds a replay key from request bundle CID/digest, source
payload digest, taskgen input digest, prompt digest, model, task class, and
reward/deadline policy versions. Before calling the provider, it checks
`taskgen_replay_cache`.

- If normalized taskgen output is already stored for the replay key, the worker
  reuses that output and does not call the provider again.
- If an offer CID and tx hash are already stored for the replay key, the worker
  reuses the recorded offer and does not pin or submit a new `pf.task.offer.v1`.
- If source facts, prompt/model, request bundle, or policy versions change, the
  replay key changes and generation can intentionally produce a new task.

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

## Network Taskgen Input Context

For Network/Alpha requests, `projectTaskgenInput` now exposes the Board
Manager's Hive-generation context to the taskgen model:

- `hive_policy.operator_standing_policy`
- `hive_policy.generation_quality_policy`
- `prior_output_corpus`
- `task_lineage`
- `operator_transparency.referenced_outputs`
- `operator_transparency.deduped_against`
- `operator_transparency.escalation_stage`

The fields are populated from the encrypted request bundle's `network_task`
block (`server/task-generation-worker.js:229`). The network taskgen prompt
treats `hive_policy`, the concrete `network_task` packet, prior output corpus,
and task lineage as the highest-authority task-shape inputs
(`prompts/task_engine/taskgen_network_v1.md:70`). Its document-to-action
section instructs the model to avoid documentation-only tasks by default,
reference prior outputs, dedup silently, and move already-documented work toward
PRs, mocks, Discord handoffs, collaboration, reviews, or shipped changes
(`prompts/task_engine/taskgen_network_v1.md:99`).

This is context and prompt policy only. The worker still follows the normal
claim, decrypt, model-call, encrypt, publish, and replay path. It does not add
hard-coded gates, reward caps, wallet bans, deterministic documentation-task
rejection, or alternate lifecycle rules.

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
