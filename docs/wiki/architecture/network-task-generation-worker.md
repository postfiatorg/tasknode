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
to inspect and the output to produce. The prompt asks the model to translate
abstract project language into a named artifact and action that the contributor
can understand.

The Network Task Generation worker forwards the current project document as
structured `network_task.project_document` context. It must not inject taskgen
instructions or contributor-facing prompt prose in code. The network task
generator prompt in `prompts/task_engine/taskgen_network_v1.md` provides
language guidance. Generated wording is never rejected by a server-side content
rule; once the provider returns mechanically valid task JSON, generation
continues to publication.

Network tasks are also a conformance surface for collaboration. They coordinate
contributors who may not know each other across machine-maintained projects.
Each generated assignment should advance Post Fiat, Task Node, the shared data
lake, or collective capital formation while staying small enough for one
contributor to complete and prove. Sybil resistance comes from concrete
artifacts, before/after evidence, source-backed judgment, app/project
inspection, and reviewable provenance, not from wallet addresses alone.

The current prompt contract is action-first. A Network Task may still ask for a
document when the model believes that is the right artifact, but pure
documentation-only work is low value by default. When prior project-linked work
already documented a problem, the next task should escalate to a concrete
output or delivery surface such as a PR, mock, Discord handoff, review packet,
collaboration, or shipped change. This is a model policy in
`prompts/task_engine/taskgen_network_v1.md`, not a hard-coded rejection rule in
the worker.

## Packet Lineage

Hive Task Manager is the normal Network Task selector. It runs every 5 minutes
on GLM 5.2 with high reasoning, reads Hive reports, board state, current task
state, eligible contributor badges, operator capacity, user memory, refused
tasks, and rewarded tasks, then narrows generation to one active board and one
badge-eligible idle operator. It emits a Board Manager-compatible
`initiate_network_task` payload so the existing allocation and task-generation
path remains canonical. It does not author the final task title, steps,
verification policy, or evidence requirement.

Legacy Board Manager rows may still feed this worker, but new automatic routing
should come through Task Manager selection and guardrails.

The packet chain is:

1. Task Manager emits `payload.network_task` with candidate ids, task class,
   reward min/max, `project_need_summary`, `routing_reason`, cadence fields,
   and model-authored context/audit fields such as `action_output`,
   `delivery_surface`, `referenced_outputs`, `deduped_against`, and
   `escalation_stage`.
2. `server/repositories/network-tasks.js` records that intent in
   `network_task_allocations` and creates a `network_task_generation_jobs` row
   with the source payload, digest, candidate, project, task class, reward band,
   prompt version, operator policy, generation quality policy, prior-output
   corpus, task lineage, Task Manager selection, board packet, operator packet,
   and transparency metadata
   (`server/repositories/network-tasks.js:573`,
   `server/repositories/network-tasks.js:769`).
3. `server/network-task-generation-worker.js` builds a normal encrypted
   `pf.task.request_bundle.v1`, sets the request source to `network_task`, and
   appends a `network_task` block with schema
   `pf.hive.network_task_request.v1`. That block includes
   `operator_standing_policy`, `generation_quality_policy`,
   `prior_output_corpus`, `task_lineage`, `action_output`,
   `delivery_surface`, and related transparency fields
   (`server/network-task-generation-worker.js:51`,
   `server/network-task-generation-worker.js:94`).
4. `server/task-generation-worker.js` decrypts the request bundle, projects it
   into `pf.taskgen.input.v1`, and selects
   `prompts/task_engine/taskgen_network_v1.md` when the `network_task` block or
   network/alpha task class is present.
5. The model returns strict `pf.taskgen.output.v1`; the worker embeds that body
   in encrypted `pf.task.offer.v1`, anchors it with a signed PFTL pointer, and
   the reducer projects it into the normal Tasks UX.

The generator should interpret `project_need_summary` as the closest request,
`routing_reason` as contributor-fit context, `project_document` as the operating
picture, `hive_policy` and prior-output corpus as top-authority context for task
shape, policy/reward fields as hard constraints, and the contributor's
context/memory/chat as adaptation signals. Normal generated tasks should not
explain this packet chain unless the assignment itself is about documenting or
debugging Network Task generation.

The generation intelligence fields are context plumbing only. They do not alter
capacity checks, stale-chain recovery, semantic idempotency, task lifecycle
projection, PFTL signing, encryption, or reward settlement.

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
