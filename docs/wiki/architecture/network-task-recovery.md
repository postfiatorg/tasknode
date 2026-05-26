# Network Task Recovery

Network Task recovery is the restart path for project-linked Network Tasks. It reads persisted task state, rebuilds the Hive mirrors, and decides the next valid action without fabricating user actions or duplicate reward events.

The important boundary is simple: task lifecycle state is canonical in `task_projections`, which is rebuilt from signed PFTL task events. Hive project rows and allocation rows are read models. Recovery is allowed to repair those mirrors and resume workers. It is not allowed to accept a task, submit evidence, or pay a reward directly from a stale UI state.

## What Runs

The recovery entrypoint is:

```bash
npm run network-task-recovery
```

For machine-readable output:

```bash
npm run network-task-recovery -- --json
```

The verification smoke is:

```bash
DATABASE_URL=postgres://tasknodeofficial:tasknodeofficial@localhost:5436/tasknodeofficial \
TASKNODE_DATABASE_ENABLED=true \
npm run network-task-recovery-smoke
```

The implementation lives in:

- `server/network-task-recovery.js`
- `scripts/network-task-recovery.mjs`
- `scripts/network-task-recovery-smoke.mjs`

## Recovery Rules

Recovery inspects active Network Task statuses:

- `proposed`
- `accepted`
- `submitted`
- `verification_requested`
- `verification_response_submitted`
- `reward_decided`

For each task it first calls `syncNetworkTaskProjection`. That copies the canonical `task_projections.status` into `network_project_task_refs.state` and `network_task_allocations.allocation_status`. This keeps the Hive board aligned with the task page after restart.

Then it chooses one next action:

| Projection state | Recovery action | Who acts next |
|---|---|---|
| `proposed` | `await_user_accept_or_refuse` | User |
| `accepted` | `await_user_evidence` | User |
| `submitted` | `resume_verification_request_worker` unless already published | Task review worker |
| `verification_requested` | `await_user_verification_evidence` | User |
| `verification_response_submitted` | `resume_reward_scoring_worker` unless already published | Task review worker |
| `reward_decided` | `await_reward_payment_or_projection` | Cache/reducer/chain sync |

## Duplicate Transition Policy

Recovery never signs user transitions. It does not accept, refuse, cancel, or submit evidence for a user.

Recovery also checks worker metadata before asking a worker to continue:

- `metadata_json.workers.verification_request.published = true` means the verification request was already published, so recovery waits for projection instead of publishing another request.
- `metadata_json.workers.reward_scoring.published = true` means the reward decision or reward payment path already published, so recovery waits for projection instead of scoring again.

The task review worker still owns the actual verification and reward publications. Its claim queries are idempotent and stale-claim aware: processing leases can expire and be retried, but published markers are terminal for that worker. Recovery only reconstructs what should happen next and makes the project mirrors accurate.

On Fly, that worker runs in the `worker` process group. If recovery reports
`resume_verification_request_worker` or `resume_reward_scoring_worker`, first
run `npm run fly:worker-guard` and verify `fly status -a tasknodeofficial-dev`
shows an active `worker` machine. Recovery output is a diagnosis and mirror
repair path; it is not a substitute for the review worker being alive.

## Evidence References

Recovery reads the latest persisted evidence event from `task_events` for each active Network Task. Operator logs include the latest evidence CID and transaction hash when present. This proves submitted and review-pending tasks did not lose their evidence references during restart.

Example operator output:

```text
network_task_recovery checked=3 recovered=3 execute_review_queue=false
network_task_recovered task_id=task_network_recovery_accepted project=network_recovery_project state=accepted next=await_user_evidence worker=none will_publish=false mirror=proposed->accepted evidence_cid=none
network_task_recovered task_id=task_network_recovery_submitted project=network_recovery_project state=submitted next=resume_verification_request_worker worker=verification_request will_publish=true mirror=accepted->submitted evidence_cid=Qm... evidence_tx=TX...
network_task_recovered task_id=task_network_recovery_review project=network_recovery_project state=verification_response_submitted next=resume_reward_scoring_worker worker=reward_scoring will_publish=true mirror=verification_requested->verification_response_submitted evidence_cid=Qm... evidence_tx=TX...
```

## Why This Exists

Network Tasks are system-routed but user-executed. A process restart must not leave the Hive board stale, and it must not cause duplicate task transitions. This recovery loop gives operators a direct way to inspect active Network Tasks after restart and confirms whether the next move belongs to the user, the task review worker, or chain projection catch-up.
