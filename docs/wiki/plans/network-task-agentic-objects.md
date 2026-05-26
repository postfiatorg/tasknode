# Network Task Agentic Objects

Status: archived design reference, not an active plan. Current implementation truth lives in `Surfaces -> Tasks`, `Surfaces -> Hive`, `Architecture -> Network Task Generation Worker`, `Architecture -> Network Task Recovery`, `Architecture -> Task Lifecycle`, and `Architecture -> Task Review And Reward Worker`.

This page is retained as a design reference. Do not use it as the current Network Task contract.

This document defines how Task Node Network Tasks should behave as persistent agentic objects. It is scoped to the current Task Node architecture: the Board Manager allocates work, the network-task generation worker turns that allocation into a normal PFTL task request, the task engine publishes a signed task offer, and task lifecycle state is replayed from PFTL into Postgres projections for fast app reads.

The goal is not to create a second task system. The goal is to make network-pushed work durable, replayable, explainable, and useful for group vetting and capital routing.

## Core Principle

A Network Task is a normal PFTL task with additional routing context.

The Board Manager may decide that the network should push work to a contributor. It may choose the project, task class, candidate, reward band, and routing reason. It must not own final task state after the task exists.

After the task offer is published, the canonical state comes from signed PFTL task events:

1. `pf.task.offer.v1`
2. `pf.task.update.v1`
3. `pf.task.submission.v1`
4. `pf.task.verification_response.v1`
5. `pf.task.reward_decision.v1`
6. `pf.reward.v1`

Postgres tables make this readable and fast, but they do not replace the chain record.

## Current Anchors

The current live example produced by the Board Manager is:

| Field | Value |
| --- | --- |
| Project | `task_node` |
| Allocation | `netalloc_bf76b68181773f81e94ea92072d6d0ea` |
| Generation job | `nettaskjob_bf76b68181773f81e94ea92072d6d0ea` |
| Request | `req_net_7ede84d61ddbf36545496b7e6b211f80` |
| Task | `task_cbc53fb0cdabb53f1215e73435b37af0` |
| Offer transaction | `CFC622AB44707E5CE4D48E71629758C5A59EE0CBBF48F3561A7910E5233B06EE` |
| Project task ref state | `proposed` |
| Reward offer | `15000 PFT` |

That proves the Board Manager can allocate a network task and the normal task engine can publish it as a PFTL-backed task offer. This spec describes the behavior that must remain true as the system becomes more autonomous.

## Persistent State Model

### Canonical Chain State

The canonical lifecycle state is reconstructed from PFTL task events.

Required canonical fields:

| Field | Source | Purpose |
| --- | --- | --- |
| `task_id` | Task offer payload | Stable task identity. |
| `request_id` | Task request bundle and offer payload | Connects request, allocation, generated offer, and audit trail. |
| `subject_wallet` | PFTL task event payloads | Wallet assigned to the task. |
| `authority_wallet` | PFTL task event payloads | Wallet that issues offers, verification requests, and reward decisions. |
| `status` | Reduced task events | Current task lifecycle state. |
| `title` | Task offer payload | Human-readable task name. |
| `description` | Task offer payload | Work objective. |
| `steps` | Task offer payload metadata | Concrete completion path. |
| `submission_requirement` | Task offer payload | Evidence the user must submit. |
| `verification_policy` | Task offer payload | Expected review type and follow-up behavior. |
| `reward_offer_pft` | Task offer payload | Offered task reward. |
| `reward_actual_pft` | Reward decision or payment event | Actual reward paid or zero reward close. |
| `event_count` | Reducer | Number of indexed task events. |
| `last_event_cid` | Reducer | Latest IPFS proof anchor. |
| `last_event_tx_hash` | Reducer | Latest chain proof anchor. |

Implementation reference: `task_projections`.

### Network Allocation State

Network allocation state exists before the task is generated. It explains why the network is routing work to a contributor.

Required allocation fields:

| Field | Purpose |
| --- | --- |
| `allocation_id` | Stable id for the Board Manager allocation. |
| `project_id` | Hive project that needs the work. |
| `task_class` | `network` or `alpha`. |
| `allocation_status` | Fast mirror of allocation and later task state. |
| `candidate_account_id` | Account selected for the work. |
| `candidate_wallet_address` | Wallet that will receive the task offer. |
| `candidate_profile_digest` | Digest of the Network Diagnostic Report used for routing. |
| `project_need_summary` | What the project needs. |
| `allocation_reason_summary` | Why this contributor was selected. |
| `reward_min_pft` / `reward_max_pft` | Board Manager reward band. |
| `cadence_policy_json` | Accept window, active allocation count, cadence reason. |
| `idempotency_key` | Prevents duplicate allocations for the same decision. |

Implementation reference: `network_task_allocations`.

### Generation Job State

The generation job is the bridge from a Board Manager decision to a normal task request.

Required generation job fields:

| Field | Purpose |
| --- | --- |
| `job_id` | Stable id for the network-task generation job. |
| `allocation_id` | Link to the allocation. |
| `source_payload_digest` | Digest of the exact Board Manager/project/candidate packet used. |
| `source_payload_json` | Structured source packet for replay and debugging. |
| `source_payload_text` | Human-readable source packet for operators. |
| `request_id` | Filled once the worker creates a normal task request. |
| `request_bundle_cid` | Encrypted IPFS request bundle. |
| `task_id` | Filled once the normal task generation worker publishes an offer. |
| `offer_cid` | IPFS CID of the task offer payload. |
| `offer_tx_hash` | PFTL transaction hash of the offer. |
| `status` | `queued`, `running`, `generated`, `published`, `link_failed`, or `failed`. |
| `attempt_count` | Retry tracking. |
| `last_error` | Last worker failure. |
| `idempotency_key` | Prevents duplicate generation jobs. |

Implementation reference: `network_task_generation_jobs`.

### Project Read Model

Hive needs a fast project view that references tasks without inventing their lifecycle.

Required project task fields:

| Field | Purpose |
| --- | --- |
| `project_id` | Hive project. |
| `task_id` | Canonical task id when available. |
| `request_id` | Request id before or after task generation. |
| `title` | Snapshot for fast Hive display. |
| `state` | Mirror of `task_projections.status` after task exists. |
| `assignee_wallet` | Routed wallet. |
| `reward_pft` | Offer or actual reward depending on state. |
| `metadata_json` | Offer CID, tx hash, allocation id, job id, task class, projection sync metadata. |

Implementation reference: `network_project_task_refs`.

## Lifecycle Transitions

Network Tasks have two phases: allocation before task publication, and normal task lifecycle after publication.

### Allocation Phase

```text
candidate -> queued -> generated -> proposed
```

Meaning:

- `candidate`: Board Manager has selected a contributor but no generation job is ready.
- `queued`: generation job exists and is waiting for the network-task worker.
- `generated`: encrypted request bundle and normal `task_requests` row exist.
- `proposed`: authority has published a PFTL task offer and the reducer projected it.

Failure states:

- `failed`: worker failed and no active task should be shown.
- `link_failed`: offer exists but the link from generation job to projection needs repair.
- `expired`: contributor did not accept within the accept window.
- `rerouted`: allocation was abandoned because the network assigned the work elsewhere.

### Task Phase

After `proposed`, Network Tasks use the normal task lifecycle:

```text
proposed -> accepted -> submitted -> verification_requested -> verification_response_submitted -> reward_decided -> rewarded
proposed -> refused
accepted -> cancelled
submitted -> cancelled
verification_requested -> cancelled
```

Plain English behavior:

1. Proposed means the user can accept or refuse.
2. Accepted means the task is on the user's plate.
3. Submitted means initial evidence is indexed and waiting for authority processing.
4. Verification requested means the authority asked for follow-up evidence.
5. Verification response submitted means the user answered the follow-up and awaits review.
6. Reward decided means the authority scored the work.
7. Rewarded means the task is terminal, including zero-reward closes.

`rewarded` does not always mean money moved. A task can close with `0 PFT` when the authority decision rejects the evidence. The reward panel must explain that outcome.

## Agent Roles

### Board Manager

The Board Manager is the only agent that allocates Network Tasks.

Allowed actions:

- `do_nothing`
- `refresh_hive_secretary`
- `message_user`
- `create_project`
- `archive_project`
- `refresh_project_document`
- `assign_contributor`
- `initiate_network_task`

The Board Manager may:

- read Hive Context inputs from validated wallets;
- read current Hive Secretary reports;
- read active projects and project documents;
- read Network Diagnostic Reports for eligible users;
- read current project-linked task state;
- select a project, candidate, task class, reward band, and routing reason;
- initiate one network task when cadence and capacity allow;
- ask a user for missing context in the original chat conversation;
- update project documents when project status changes.

The Board Manager must not:

- edit final task state after a task is published;
- mark a task rewarded, refused, cancelled, or accepted;
- bypass PFTL task events;
- invent user work or task evidence;
- generate a hidden task outside the normal task engine;
- send tasks to a user without an active wallet;
- exceed cadence and capacity constraints without explicit policy metadata;
- inspect private memory beyond the Network Diagnostic Report unless the action explicitly requires it.

### Network Task Generation Worker

The network-task generation worker turns an allocation into a normal task request bundle.

It may:

- build a request bundle containing project id, task class, routing reason, candidate profile digest, reward band, and project need;
- encrypt the bundle to the Task Node service key;
- pin the encrypted bundle to IPFS;
- create a normal `task_requests` row;
- schedule the normal task generation worker.

It must not:

- score evidence;
- pay rewards;
- directly insert a final task projection;
- generate unsupported evidence requirements;
- create a task without a linked candidate wallet.

### Task Generation Worker

The task generation worker writes the concrete task offer.

It may:

- call the configured task generation provider;
- create title, description, steps, submission requirement, verification policy, deadline, and reward offer;
- publish `pf.task.offer.v1`;
- sync the offer into `task_projections`;
- link the generated offer to `network_project_task_refs`.

It must not:

- ask for evidence the app cannot submit;
- create one-step tasks;
- bypass the reward band for Network Tasks unless explicit policy permits it;
- write project state as if it were task state.

### Review Worker

The review worker handles evidence after the user submits.

It may:

- read encrypted evidence payloads when the Task Node service key can decrypt them;
- ask a follow-up verification request;
- score the verification response;
- publish reward decisions;
- publish PFT reward payment events when reward is positive.

It must not:

- pay rewards without an indexed reward decision;
- silently skip explanation for zero-reward outcomes;
- treat Board Manager allocation as proof of completed work.

## Memory Boundaries

Network Tasks need enough context to route work well without dumping private user history into every agent step.

Default routing inputs:

- Network Diagnostic Report;
- public profile snapshot;
- current outstanding Network Tasks;
- recent refused Network Tasks;
- recent rewarded Network Tasks;
- active project document;
- Hive Secretary report;
- Board Manager recent runs.

Avoid by default:

- raw chat history;
- raw deep memory;
- private context document text;
- unrelated wallet transaction history;
- private files or attachments.

If the Board Manager needs private context, it should message the user for a concise Hive chat update rather than reading more private material silently.

## Downstream Propagation

Completed Network Tasks should update four downstream systems.

### Contributor Trust

Inputs:

- accepted/refused ratio;
- submitted evidence quality;
- reward decision;
- reward amount;
- task class;
- project type;
- verification reason;
- repeated failure or cancellation patterns.

Outputs:

- Network Diagnostic Report refresh;
- public profile skill summary where appropriate;
- contributor allocation cap;
- routing eligibility for future tasks.

Example:

If a contributor completes two protocol-development tasks with high evidence quality and accepts follow-up verification cleanly, future protocol-development tasks can be routed to them with higher confidence and a larger reward band.

### Network Memory

Inputs:

- task title;
- project id;
- task output summary;
- reward decision summary;
- evidence quality;
- verifier feedback.

Outputs:

- project document refresh;
- Hive Secretary context;
- future task generation packet.

Example:

If a task produces a clear state model for agentic network tasks, the Task Node project document should incorporate the model, and future tasks should reference that document instead of asking users to restate the same architecture.

### Group Vetting Signals

Inputs:

- whether the work was accepted by the authority;
- whether follow-up verification was needed;
- whether other contributors reuse the output;
- whether the output resolves a project blocker.

Outputs:

- project confidence;
- contributor reliability;
- evidence usefulness;
- follow-up task priority.

Example:

A technically correct implementation with poor screenshots may still improve protocol state but lower evidence quality. The system should preserve both facts: useful work happened, but the contributor needs clearer proof packets.

### Capital Routing

Inputs:

- alpha task outputs;
- project outputs that improve signal quality;
- contributor reliability;
- reward-weighted completion history;
- project confidence.

Outputs:

- capital deployment watchlists;
- signal reliability weighting;
- contributor access to higher-value alpha tasks;
- network priority changes.

Example:

If an Alpha Task identifies a market signal and later verification confirms the evidence, that result can increase trust in the contributor's future market-routing work and feed the Capital Deployment Protocol project. If the evidence is weak or unverifiable, the signal should not affect capital routing.

## Failure Cases

| Failure | Correct behavior |
| --- | --- |
| Candidate has no active wallet | Allocation fails before generation. No hidden task. |
| Candidate is at capacity | Board Manager should choose `do_nothing` or another candidate. |
| Generation worker fails | Job becomes `failed` with `last_error`; Hive shows no fake proposed task. |
| Offer published but not linked | Job becomes `link_failed` or repairable; repair path links tx/CID to project ref. |
| User refuses | PFTL `TASK_UPDATE` closes task as `refused`; allocation mirrors `refused`. |
| User ignores proposed task | Accept window expires; allocation mirrors `expired`; project can reroute. |
| Evidence is incomplete | Review worker issues verification request, not reward. |
| Verification evidence remains incomplete | Reward decision can close as `rewarded` with `0 PFT`. |
| Reward decision positive but payment missing | UI shows payment pending; task is not falsely paid. |
| Reducer lag | UI shows indexing state; no manual SQL correction. |

## Example Workflow 1: Successful Network Task

Project: `task_node`

Need: define how network tasks become stateful and agentic without creating a second source of task truth.

1. Hive Context receives validated input saying the Task Node Hive outputs and Network Tasks need to become agentic and stateful.
2. Hive Secretary summarizes that Task Node is the current broken priority.
3. Board Manager reads the project document, candidate Network Diagnostic Report, and project task state.
4. Board Manager selects `initiate_network_task` for `task_node`.
5. The action hook creates:
   - `network_task_allocations` row with status `queued`;
   - `network_task_generation_jobs` row with status `queued`;
   - reward band `10000` to `20000` PFT.
6. The network-task generation worker creates encrypted request bundle `pf.task.request_bundle.v1` and a normal `task_requests` row.
7. The task generation worker publishes `pf.task.offer.v1`.
8. Reducer projects task `task_cbc53fb0cdabb53f1215e73435b37af0` as `proposed`.
9. Hive project task ref mirrors `proposed`, and the Tasks page shows the routed Network Task.
10. User accepts the task by signing `pf.task.update.v1`.
11. User submits a markdown spec as `pf.task.submission.v1`.
12. Review worker decides the evidence is complete enough and publishes `pf.task.reward_decision.v1`.
13. Reward wallet publishes `pf.reward.v1`.
14. `task_projections` becomes `rewarded`; project task ref mirrors `rewarded`; allocation becomes `completed`.
15. Network Diagnostic Report and project document refresh from the completed work.

Result:

- contributor trust increases for protocol/product architecture work;
- Task Node project memory now has a durable spec;
- future Board Manager decisions can allocate implementation work against this spec;
- capital routing is unaffected unless the task output directly improves alpha or deployment decisions.

## Example Workflow 2: Incomplete Evidence With Zero Reward Close

Project: `capital_deployment_protocol`

Need: define how vetted network signals become capital routing inputs.

1. Board Manager sees the project is blocked because the handoff fields from signal to capital decision are unclear.
2. Board Manager initiates an `alpha` task for a contributor with relevant profile history.
3. Network-task generation worker creates the request bundle and the normal task generator publishes a concrete task.
4. User accepts.
5. User submits a vague text note with no schema, no examples, and no evidence of how the handoff would work.
6. Review worker publishes a verification request asking for:
   - specific input fields;
   - one example signal;
   - one example routing decision;
   - one failure case.
7. User responds with another vague note that does not answer the request.
8. Review worker publishes `pf.task.reward_decision.v1` with `reward_pft = 0`.
9. No `pf.reward.v1` payment is expected.
10. `task_projections` becomes terminal `rewarded` with zero actual PFT.
11. Project remains blocked, but the failed evidence is still useful as a group vetting signal.

Result:

- contributor trust for alpha task clarity decreases;
- refusal/cancellation is not inferred because the user did submit;
- task output does not feed capital routing;
- Board Manager can later reroute the project need to another contributor or ask for narrower information.

## Example Workflow 3: Refusal And Reroute

Project: `task_node`

Need: implement a state sync repair for project-linked tasks.

1. Board Manager initiates a Network Task for a contributor.
2. User sees a proposed routed task and refuses it with reason: "Not relevant to my current work."
3. Browser signs `pf.task.update.v1` with transition `refused`.
4. Reducer projects task as `refused`.
5. Network allocation mirrors `refused`.
6. The refusal summary becomes part of the user's routing history.
7. Board Manager may reroute the same project need to a different contributor or wait.

Result:

- no reward is paid;
- no one treats refusal as completed work;
- the network learns that this contributor is currently misaligned with that project need;
- project state remains open until another task resolves it.

## Implementation Review Checklist

Before calling this behavior complete, implementation should prove:

1. A Board Manager run can initiate exactly one Network Task allocation under cadence policy.
2. The generation job produces a normal encrypted task request bundle.
3. The normal task generator publishes `pf.task.offer.v1`.
4. The proposed task appears in the Tasks UX and Hive project task list.
5. Accept, refuse, cancel, submit, verification request, verification response, reward decision, and reward payment all use the normal PFTL lifecycle.
6. Hive task state is a mirror of `task_projections`, not Board Manager-written state.
7. Zero-reward, partial-reward, and full-reward outcomes are visible and explained.
8. Project documents and Network Diagnostic Reports can consume completed task outputs without reading raw private chat history.
9. Duplicate Board Manager decisions are blocked by idempotency keys.
10. Failed generation jobs stay auditable and do not create vapor tasks.

## Open Implementation Decisions

These are not blockers for the current spec, but they need explicit product decisions:

1. Expiration cadence: exact accept window and reroute timing per task class.
2. Contributor caps: whether caps are per account, wallet, project, task class, or all of the above.
3. Project confidence: how many rewarded tasks or contributor confirmations move a project from uncertain to active execution.
4. Capital routing threshold: what evidence quality and reward level is high enough to influence capital decisions.
5. Cross-project reuse: when a completed output can update more than one project document.

## Summary

Network Tasks should feel agentic to the user because the network routes useful work to them. They should remain deterministic to the system because every lifecycle step after publication is a signed PFTL event.

The Board Manager decides what work should be offered. The task engine publishes and reviews the work. The reducer projects state. Hive displays the project context. Memory and profile systems learn from outcomes. Capital routing only consumes verified, rewarded, relevant outputs.

## Reviewer To Do List

Review implementation against this document (network task agentic objects). Mark each item when verified.

### Memory Efficiency
- [ ] Plan phases avoid loading unbounded history or corpus into single jobs.
- [ ] Derived read models prefer projections over duplicate materialized stores.

### Code Quality
- [ ] Done criteria map to testable checks or smoke commands.
- [ ] Status (implemented vs planned) accurate on every section.

### Coherence
- [ ] Plan does not contradict shipped behavior in Surfaces/Architecture docs.
- [ ] Dependencies on other plans explicitly named and still valid.

### Bloat
- [ ] Plan scoped to stated phase; future work not implied as shipped.
- [ ] Avoid duplicating full surface doc content; link instead.

### Security
- [ ] New tables/routes in plan include account ownership and encryption notes.
- [ ] Operator-only actions identified with audit requirements.
