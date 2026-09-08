# Network Task Generation Worker

The Network Task Generation worker turns a routing allocation into a normal
task request and hands it to the shared task engine. Current production prepares
an encrypted IPFS request bundle, then the shared generator writes an offchain
`pf.task.offer.v1` event and `task_projections` row. A generation job alone is
not a visible task. Reviewed September 5, 2026.

System Status row: `network_task_generation`

## Runtime Boundary

- Worker module: `server/network-task-generation-worker.js`.
- Periodic process: Fly `worker-taskgen`.
- Repository facade: `server/repositories/network-tasks.js`; implementation is
  split across `network-task-enqueue.js`, `network-task-generation-jobs.js`,
  `network-task-generation-source.js`, and related repository modules.
- Source table: `network_task_generation_jobs`.
- Board Manager action: `initiate_network_task`.
- Repair path: `scripts/network-task-recovery.mjs`.

## Contributor-Facing Clarity Boundary

Kimi and authorized board command producers own routing, not final task prose. The
`payload.network_task.project_need_summary` still has to be concrete enough for a
contributor: name the app surface, document, code path, data state, or artifact
to inspect and the output to produce. The prompt asks the model to translate
abstract project language into a named artifact and action that the contributor
can understand.

The Network Task Generation worker forwards the current project document as
structured `network_task.project_document` context. It must not inject taskgen
instructions or contributor-facing prompt prose in code. The network task
generator prompt in `prompts/task_engine/taskgen_network_v2.md` provides
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
the selected taskgen prompt, not a hard-coded rejection rule in
the worker.

## Packet Lineage

Kimi K3 selects work in the operator-host Corbanu TUI and executes `bm task
create`. The command emits a Board Manager-compatible `initiate_network_task`
payload into the existing allocation and task-generation path. Kimi owns
routing; the GLM generator writes the final title, steps, verification policy,
and evidence requirement. The obsolete GLM selector and legacy automatic Fly
manager were removed on September 5, 2026. See [board management](board-manager.md).

The packet chain is:

1. The Kimi board command emits `payload.network_task` with candidate ids, task class,
   reward min/max, `project_need_summary`, `routing_reason`, cadence fields,
   and model-authored context/audit fields such as `action_output`,
   `delivery_surface`, `referenced_outputs`, `deduped_against`, and
   `escalation_stage`.
2. `server/repositories/network-task-enqueue.js` records that intent in
   `network_task_allocations` and creates a `network_task_generation_jobs` row
   with the source payload, digest, candidate, project, task class, reward band,
   prompt version, operator policy, generation quality policy, prior-output
   corpus, task lineage, selection metadata, board packet, operator packet,
   and transparency metadata
   in a transaction. Candidate capacity is currently checked before this transaction.
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
   `prompts/task_engine/taskgen_network_v2.md` with the production v2 flag
   when the `network_task` block or network/alpha task class is present. The v1
   prompt is retained for the flag-disabled compatibility path.
5. The model returns `pf.taskgen.output.v1`; the worker validates it and records
   a `pf.task.offer.v1` event and task projection through
   `applyOffchainTaskOffer`. Current generation does not submit an offer pointer
   or wait for reducer replay. Receipt, replay and allocation links then complete.

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

Network preparation uses `locked_at` and stale-job recovery; it does not yet
share the ordinary request queue's attempt-token fencing and heartbeat contract.
A slow preparation attempt and a reclaimer therefore need explicit ownership
qualification before increasing concurrency. Shared taskgen replay is a
separate downstream protection.

Existing recovery guards cover these cases; they do not establish complete
attempt fencing across all overlapping preparation attempts:

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


## Direct intake and intent assessment (new source stage)

Direct mode persists the complete account Context, memory, chat and task snapshot
in the request's PostgreSQL bundle. It avoids encryption-key RPC and IPFS on this
path. The actual project need from Kimi is retained in `userDetailText`; current
linked-wallet resolution prevents offers being created for a stale wallet.

A structured GLM assessment compares that need with the same account's prior
network tasks across boards. It distinguishes duplicate, continuation, independent
and uncertain work, requires real prior IDs and a new output for continuations,
and records its result under the active worker attempt. Duplicate, unclear or
unactionable work waits for review; a stale worker cannot persist its assessment
or request. This validates Kimi's selected work rather than selecting a new task.

The contract/PostgreSQL corpus passes. Live model qualification remains pending
in the September 5 implementation ledger; do not claim production quality from
synthetic provider fixtures alone.
