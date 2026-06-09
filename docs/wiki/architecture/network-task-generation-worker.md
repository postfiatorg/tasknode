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
- Board Manager action: `initiate_network_task`.
- Repair path: `scripts/network-task-recovery.mjs`.

## Contributor-Facing Clarity Boundary

Board Manager owns routing, not final task prose. Its
`payload.network_task.project_need_summary` still has to be concrete enough for a
contributor: name the app surface, document, code path, data state, or artifact
to inspect and the output to produce. Internal shorthand such as P0 standards,
acceptance gates, contract enforcement, deterministic state visibility,
acknowledgment requirements, compliance audit, product priority audit, or
canonical context alignment is not a valid task need by itself.

The Network Task Generation worker forwards the current project document as
structured `network_task.project_document` context. It must not inject taskgen
instructions or contributor-facing prompt prose in code. The network task
generator prompt in `prompts/task_engine/taskgen_network_v1.md` owns the
language rules: translate routing shorthand into plain-English contributor work,
and if the need is still broad, produce a bounded diagnostic artifact rather
than an abstract governance audit.

Network tasks are also a conformance surface for collaboration. They coordinate
contributors who may not know each other across machine-maintained projects.
Each generated assignment should advance Post Fiat, Task Node, the shared data
lake, or collective capital formation while staying small enough for one
contributor to complete and prove. Sybil resistance comes from concrete
artifacts, before/after evidence, source-backed judgment, app/project
inspection, and reviewable provenance, not from wallet addresses alone.

## Packet Lineage

Board Manager is the Hive decision worker. It reads Hive context, active project
state, project documents, task/reward state, eligible Network Diagnostic
Reports, candidate availability, reward policy, and recent run history. For
Network Tasks it chooses `initiate_network_task`, which selects a project,
candidate, task class, reward band, cadence reason, project need, and routing
reason. It does not author the final task title, steps, verification policy, or
evidence requirement.

The packet chain is:

1. Board Manager emits `payload.network_task` with candidate ids, task class,
   reward min/max, `project_need_summary`, `routing_reason`, and cadence fields.
2. `server/repositories/network-tasks.js` records that intent in
   `network_task_allocations` and creates a `network_task_generation_jobs` row
   with the source payload, digest, candidate, project, task class, reward band,
   and prompt version.
3. `server/network-task-generation-worker.js` builds a normal encrypted
   `pf.task.request_bundle.v1`, sets the request source to `network_task`, and
   appends a `network_task` block with schema
   `pf.hive.network_task_request.v1`.
4. `server/task-generation-worker.js` decrypts the request bundle, projects it
   into `pf.taskgen.input.v1`, and selects
   `prompts/task_engine/taskgen_network_v1.md` when the `network_task` block or
   network/alpha task class is present.
5. The model returns strict `pf.taskgen.output.v1`; the worker embeds that body
   in encrypted `pf.task.offer.v1`, anchors it with a signed PFTL pointer, and
   the reducer projects it into the normal Tasks UX.

The generator should interpret `project_need_summary` as the closest request,
`routing_reason` as contributor-fit context, `project_document` as the operating
picture, policy/reward fields as hard constraints, and the contributor's
context/memory/chat as adaptation signals. Normal generated tasks should not
explain this packet chain unless the assignment itself is about documenting or
debugging Network Task generation.

## Status Derivation

Green means generation jobs are completing and no queued or running job is
stale.

Amber means recent `failed` or `link_failed` generation jobs exist.

Red means a queued or running generation job is stale.

## Recovery And Double-Publish Guards

Job processing is restart-safe and idempotent at three layers:

- Stale-running reclaim. Each queue pass first calls
  `reclaimStaleNetworkTaskGenerationJobs`, which routes `running` jobs whose
  `locked_at` is older than `TASKNODE_NETWORK_TASK_GENERATION_STALE_MINUTES`
  (default 5 minutes) through the normal failure path. Jobs retry as `queued`
  until `attempt_count` reaches 3, then converge to `failed` and fail the
  allocation and intent, so a killed worker cannot leave a project wedged in
  pending generation or hold candidate capacity.
- Existing-request reuse. Before pinning or upserting, the worker reads the
  deterministic task request for the job. If that request already advanced
  (`generating`, `proposed`, `cancelled`, or a `generated_task_id` is set), the
  retry marks the job generated from the existing request instead of resetting
  the request to `queued`, which would let the task engine publish a second
  `pf.task.offer.v1` for the same job.
- Claim and failure guards. `claimTaskGenerationRequests` never claims a
  request whose `generated_task_id` is set, even if its status regressed, and
  `markNetworkTaskGenerationJobFailed` only flips jobs that are still
  `running`, so a late failure cannot re-queue a job that already generated.

`npm run network-task-generation-recovery-smoke` proves these guards against a
configured database.

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
