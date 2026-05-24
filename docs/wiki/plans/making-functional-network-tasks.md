# Making Functional Network Tasks

Status: first implementation slice live in code; local Docker protocol smoke completed through reward.

This plan supersedes the earlier broad Hive Mind planning for Network Tasks. The Board Manager plan now supersedes the direct-worker cadence described in earlier versions of this document. The current Hive UX remains the starting point for the product ontology, but the Board Manager owns when the system updates context, creates projects, refreshes project documents, assigns contributors, and initiates Network Tasks.

## Product Objective

Hive should answer three questions without making the user inspect raw chain data:

1. What projects is the network actively pushing forward?
2. Which tasks belong to each project, and what state are they in?
3. Which operators are being allocated to network work, and why are they eligible?

The project-detail shape in the `PFT distribution v3` mock is the reference layout: a project board with an About section, contributors, tasks, and scoped activity. The live app should not seed fake operators or fake task rows to make that layout look full. It should show the project spec first, then populate contributors, tasks, and activity only when the Board Manager or project rollup links live project allocation data.

The current correction is that "scoping" is not a project. Scoping can be a phase, a status, or a reason to create information-gathering Network Tasks. It should not appear as the project title. A project title should name the durable workstream, such as `Post Fiat L1`, `Capital Deployment Protocol`, or `Task Node Product`, with `phase_label = Scoping` when the system is still gathering information.

## Network Task Boundary

Network Tasks are system-pushed tasks. They are not manually authored in the Hive UI, and the Board Manager should not write the finished task offer text itself.

The boundary is:

1. The Board Manager decides whether a project needs work pushed to one or more contributors.
2. The Board Manager chooses `initiate_network_task` with the project, candidate user or candidate set, task class, reward band, and routing reason.
3. A network-task generation worker builds the concrete task using the same task generation standards as personal task generation.
4. The concrete task is published through the normal PFTL task lifecycle.
5. The user sees a network-pushed task card in the Tasks UX and can accept or refuse it.

This keeps the agent from inventing a second workflow. The Board Manager is the allocator. The task engine is the author and publisher. PFTL remains the canonical task state.

Task status is not managed by the Board Manager. After a Network Task has a concrete `task_id`, lifecycle state comes only from signed task pointers indexed into `task_projections`. Hive/project tables mirror that projection for fast reads; they do not decide whether a task is proposed, accepted, submitted, verification-requested, rewarded, refused, cancelled, or expired.

Restart recovery now has a concrete operator path. `npm run network-task-recovery` reloads active project-linked Network Tasks from persisted `task_projections`, calls the same projection-to-Hive mirror sync, preserves latest evidence CIDs/transactions from `task_events`, and prints the next valid action. Accepted tasks remain user-owned and wait for evidence. Submitted tasks are eligible for the verification-request worker unless that worker already published. Verification-response-submitted tasks are eligible for reward scoring unless that worker already published. Recovery never emits duplicate accept, evidence, or reward transitions.

## Current Implementation Slice

The implemented slice creates the durable bridge from Board Manager action to the normal task engine:

1. `prompts/hive/board_manager_v1.md` can select `initiate_network_task`.
2. `schemas/board-manager-action.schema.json` validates `payload.network_task`.
3. `server/board-manager-actions.js` executes that action.
4. `server/repositories/network-tasks.js` creates a `network_task_allocations` row and a `network_task_generation_jobs` row.
5. `server/network-task-generation-worker.js`, when enabled, converts the generation job into a normal `task_requests` row with an encrypted request bundle containing `network_task` metadata.
6. `server/task-generation-worker.js` consumes that request through the existing task-generation path and emits the normal encrypted `pf.task.offer.v1` pointer.
7. `server/repositories/network-tasks.js` links the published offer back to `network_project_task_refs`.
8. `server/repositories/tasks.js`, `TaskRow`, and task copy formatting surface the task as `Network Task` or `Alpha Task` when the projection contains project metadata.
9. As later task events are indexed, `server/repositories/tasks.js` calls `syncNetworkTaskProjection`, and Hive reads also call `syncNetworkTaskProjections`. These functions mirror `task_projections.status` into the project task ref and allocation rows. This is a read-model sync, not agent state management.
10. `server/repositories/hive-projects.js` derives the Hive project task row, Routing Feed entry, Allotted Operator row, routed PFT, and assignee profile badge from project task refs when explicit contributor/activity rows are absent.

The Board Manager does not write final task titles, steps, verification requirements, or evidence rules. It only records project, candidate, reward band, task class, project need, routing reason, and cadence reason. The task generator still writes the concrete task offer.

What is verified now:

- migration `039_network_task_allocations.sql` applies in local Postgres;
- `npm run board-manager-action-hooks-smoke` with Postgres enabled creates and audits an `initiate_network_task` job, then marks the smoke job failed so live workers do not process fake data;
- the network task worker module imports cleanly;
- local Docker now enables `TASKNODE_NETWORK_TASK_GENERATION_WORKER_ENABLED=true` with a 5 second interval and batch size 1;
- a bounded local Docker live test generated a real project-linked task offer through the normal task engine.

Local Docker live test from May 23, 2026:

- Board Manager run: `boardrun_6e436673-14aa-4568-b7a1-fe2874d4ad7a`
- Allocation: `netalloc_66cc6446-8ff3-4cb3-9049-a23e75e44ba8`
- Generation job: `nettaskjob_2d863a1a-0d57-47c2-9b33-52787ad8d37c`
- Project: `task_node`
- Candidate wallet: `rhwiJxkiTkxTC65MrmLG7WiUkbiCyw2TaE`
- Request: `req_net_c73fe62037a9cf201d51b32bdefa69ca`
- Request bundle CID: `QmadMNu3u8cCxNGX6FJDHRNE2jDrbYAsz6dQvAu9Laz4rE`
- Generated task: `task_01af1624fcb74e41d902ca32b126f27d`
- Offer transaction: `E6C86781C0D53A68F2E7740AA8751E19616B9732489D9EA8C4330A692AC1A931`
- Final projection status after user submission and review: `rewarded`
- Project task ref after projection sync: `rewarded`
- Allocation status after projection sync: `completed`
- Reward offer: `10000 PFT`

The first attempt hit Pinata's 10-key metadata limit. The worker now pins network task request bundles with fewer Pinata key values and keeps the full allocation/request metadata inside the encrypted bundle and Postgres job row.

What is not yet claimed as done:

- allocation expiration, rerouting, persisted contributor/activity materialization, richer project activity history, and operator monitoring are not implemented;
- the Hive mock's large network-push card has not been fully ported. The current Tasks UX has a subtle routed-task row state and a detail-level Hive routed panel when a projected task carries network metadata.

There are two v1 task classes:

| Class | Purpose | Typical projects |
| --- | --- | --- |
| `network` | Protocol, product, validation, application, marketing, and coordination work that advances a Hive project. | Protocol Development, Protocol Applications, Protocol Marketing, Network Validation |
| `alpha` | Market, trading, alternative-data, research, and capital-opportunity work that advances the network's capital edge. | Alpha Generation, Capital Deployment Protocol |

Both classes use the same task lifecycle after publication: proposed, accepted/refused, submitted, verification requested when needed, verification response, reward decision, and reward payment or zero-reward close.

## Cadence And Reward Policy

Network task generation must be cadence controlled. The system should prefer a few high-quality routed tasks over spraying work at every contributor.

Initial policy:

- one Board Manager run may initiate at most one network-task generation action;
- per-account network-pushed task load must respect active task caps and refusal history;
- per-project generation should have a cooldown so one project cannot dominate the board;
- Alpha Tasks may have a separate cadence from general Network Tasks because they may require faster response windows;
- generated tasks should expire if the user does not accept them inside the configured accept window.

Default reward policy:

- default offer range: `10,000` to `50,000` PFT per task;
- exact reward is selected by the task generation worker from project importance, urgency, task difficulty, evidence burden, expected network value, and candidate fit;
- the Board Manager may suggest a reward band but should not embed the final task offer content;
- rewards outside the default range require explicit policy metadata in the generation job.

The high reward range is intentional: Network Tasks should feel like material network allocations, not small personal productivity tasks.

## Project Types

Network projects use a small fixed project-type enum in v1:

| Type | Purpose |
| --- | --- |
| `protocol_marketing` | Narrative, publication, amplification, events, and public distribution. |
| `protocol_development` | Protocol code, wallet flows, PFTL integration, task engine work, infrastructure, and audits. |
| `alpha_generation` | Research tasks that produce market, trading, or intelligence outputs for the network. |
| `protocol_applications` | Applications built on top of the protocol, including tools, agents, onboarding, and member-facing workflows. |
| `network_validation` | Validators, operator reliability, verification, replay, chain forensics, and trust infrastructure. |

These types are not user-facing bureaucracy. They are routing boundaries that help the system decide which operators should see which proposed Network Tasks.

## Core Data Model

Network projects are not canonical chain objects in v1. They are Postgres coordination records that exist before task allocation and later reference canonical PFTL tasks.

### `network_projects`

One row per active network project.

Fields:

- `id`: stable project id, for example `project_pft_distribution_v3`.
- `type`: one of the five project types above.
- `title`
- `summary`
- `objective`
- `status`: `active`, `paused`, `completed`, or `archived`.
- `priority`: integer or enum used for Hive ordering.
- `origin`: `system_generated`, `system_migration`, or `system_backfill`.
- `source_hive_secretary_report_id`: latest Hive Secretary report used as a project input.
- `source_hive_secretary_report_digest`: digest of that report source packet.
- `source_inputs_json`: structured input metadata.
- `created_at`
- `updated_at`

Project IDs must be visible in the Hive UI. Users and agents need to be able to refer to `post_fiat_l1`, `capital_deployment_protocol`, or `pft_distribution_v3` without guessing which card is meant. The project detail header should expose a copyable project id near the title.

### `network_project_product_docs`

Implemented table for the expandable product document linked to each project.

One current product document per project, plus historical rows for audit.

Fields:

- `id`
- `project_id`
- `status`: `current`, `superseded`, or `archived`
- `source_packet_digest`
- `source_packet_json`
- `source_refs_json`
- `board_manager_run_id`
- `provider`: `codex_exec` for Board Manager-authored documents
- `model`: Board Manager run model
- `prompt_version`: `board_manager_v1`
- structured output columns for summary, project status, key points, blockers, and next actions
- `created_at`
- `updated_at`

The product document answers:

- How the project realistically benefits the network.
- What success looks like.
- What the current status of the project is.
- Who is working on it and why.
- What is blocked or unknown.

If the status or next move is unclear, the product document should not invent certainty. It should say what information is missing and recommend information-gathering Network Tasks that would make the project actionable. The Board Manager decides whether to create those tasks, ask a user for follow-up context, research the question, or do nothing.

### `network_project_task_refs`

Associates canonical tasks with a project.

Fields:

- `project_id`
- `task_id`
- `request_id`
- `task_title_snapshot`
- `task_status_snapshot`
- `reward_offer_pft_snapshot`
- `reward_paid_pft_snapshot`
- `linked_at`
- `source`: `system_generated`, `task_request`, `migration`, or `system_backfill`

The authoritative task state still comes from PFTL task events and `task_projections` after allocation. Before allocation, this table can hold apriori project task rows so a project board can exist before concrete tasks are pushed to users. Once `task_id` exists, `state` is a mirror of `task_projections.status`.

The repair path is code-level synchronization, not manual SQL. `syncNetworkTaskProjection({ taskId })` updates this row from the current projection, and `syncNetworkTaskProjections()` reconciles stale rows before Hive reads. The Board Manager never sets terminal task state.

### `network_project_contributors`

Materialized contributor rollup for fast Hive reads. This can be rebuilt from task refs and task projections.

Fields:

- `project_id`
- `account_id`
- `primary_wallet_address`
- `task_count`
- `rewarded_task_count`
- `rewarded_pft_total`
- `last_task_at`
- `role_label`: optional derived label such as `lead`, `contributor`, or `reviewer`.

The current Hive route does not require this table to be populated before showing operators. If explicit contributor rows are absent, `GET /api/hive/projects` derives operator cards from project task refs, assignee wallets, and projection reward state. Persisting those rollups remains an optimization and monitoring task, not the canonical source.

### `network_project_activity`

Optional materialized activity feed for fast Hive reads. It can be rebuilt from project task refs, task projections, allocation rows, and task event history.

The current Hive route derives the Routing Feed from live project-linked task refs when this table is empty. The user-facing feed should therefore follow actual task state even before a separate activity materializer exists.

### `network_task_allocations`

Tracks network-pushed tasks before and during user acceptance.

Fields:

- `id`
- `project_id`
- `task_request_id`: empty until the network generation job creates a normal task request row.
- `generated_task_id`: empty until the concrete `pf.task.offer.v1` pointer is published and linked.
- `candidate_account_id`
- `candidate_wallet_address`
- `allocation_status`: `candidate`, `proposed`, `accepted`, `refused`, `expired`, `rerouted`, or `completed`.
- `task_class`: `network` or `alpha`.
- `reward_min_pft`: proposed lower bound for the generation worker.
- `reward_max_pft`: proposed upper bound for the generation worker.
- `candidate_profile_id`
- `candidate_profile_digest`
- `allocation_reason_summary`
- `project_need_summary`
- `cadence_policy_json`
- `metadata_json`
- `expires_at`
- `created_at`
- `updated_at`

This table powers the "network pushed this to you" experience. It must never override chain task state. It explains routing and tracks allocation lifecycle. After task publication, allocation status is derived from the task projection: active states map to `accepted`, `rewarded` maps to `completed`, stopped states map to `refused` or `expired`.

### `network_task_generation_jobs`

Durable async jobs that convert a project need into concrete task offers.

Fields:

- `id`
- `allocation_id`
- `project_id`
- `trigger`: currently `board_manager`
- `board_manager_run_id`
- `task_class`: `network` or `alpha`
- `candidate_account_id`
- `candidate_wallet_address`
- `reward_min_pft`
- `reward_max_pft`
- `source_payload_digest`
- `source_payload_json`
- `source_payload_text`
- `provider`
- `model`
- `prompt_version`
- `status`: `queued`, `running`, `generated`, `published`, or `failed`.
- `request_id`
- `request_bundle_cid`
- `generated_task_payload`
- `task_id`
- `offer_cid`
- `offer_tx_hash`
- `attempt_count`
- `next_attempt_at`
- `locked_at`
- `last_error`
- `created_at`
- `updated_at`

The job source packet should include:

- project row and current product document;
- Hive Secretary report and relevant Hive Context excerpts;
- current project task refs and recent project activity;
- candidate list from live Network Diagnostic Reports;
- the selected candidate's public profile summary and routing-relevant private diagnostic fields;
- current outstanding, refused, and rewarded tasks for that candidate;
- task class and reward band;
- supported evidence surfaces and task-generation policy from the personal task engine.

It should not include raw private memory unless that field is already part of the user's Network Diagnostic Report packet and needed for routing.

## PFTL Boundary

The network project layer is off-chain in v1, but every actual task remains PFTL-native.

New Network Tasks should include project identity in the task request and offer payloads:

- `network_project_id`
- `network_project_type`
- `network_allocation_id`, when the task was pushed to a specific user
- `routing_profile_digest`, when the Network Diagnostic Report was used

This keeps the task replayable from chain pointers while allowing Hive to be a fast Postgres read surface.

Existing tasks can be linked to projects by `network_project_task_refs` without rewriting history. New tasks should carry project metadata from creation.

## Hive Page Read Model

The current Hive page should become a read model over these data types.

### Active Projects

Source:

- `network_projects`
- task counts from `network_projects` and `network_project_task_refs`
- contributor previews from `network_project_contributors` when materialized, otherwise derived from `network_project_task_refs`
- PFT routed from the current project snapshot, later replaced by reward events in `task_projections` / reward projections

Behavior:

- show active projects grouped or labeled by type;
- clicking a project opens the project board;
- show a copyable project id in the project card or detail header;
- `PFT distribution v3` remains the visual reference for project detail cards.
- The seeded project row may expose planned/scoped metrics, but contributor cards, task rows, and routing feed rows must come from real project-linked allocation rows or task refs derived from those allocations.
- projects are read from `GET /api/hive/projects`, not from React mock data.
- do not show generated cards whose project title is a discovery activity such as "scoping". Scoping belongs in `phase_label` or in the product document status.

### Expandable Product Document

Source:

- current `network_projects` row;
- latest Hive Secretary report;
- latest active-project generation;
- project-linked task refs and contributor rollups when they exist;
- current `network_project_product_docs` row written by the Board Manager when it chooses `refresh_project_document`.

Behavior:

- project detail keeps the existing About section as the short readable summary;
- an expandable Product Document section appears inside or directly below About;
- the Product Document renders the five sections listed in the data model;
- the document shows the project id and the generation timestamp;
- if the document says information is missing, the next system action is to generate information-gathering Network Tasks rather than making up contributors or task rows;
- this document is an operator planning artifact, not canonical chain state.

### Routing Feed

Source:

- task state changes from `task_projections`
- allocation status changes from `network_task_allocations`
- reward/refusal/completion events scoped to `network_project_task_refs`
- derived feed rows from live project task refs when explicit `network_project_activity` rows are not present

Behavior:

- show recent project-scoped transitions in plain English;
- include the project name, task name, operator, state, time, and PFT only when those fields make the row easier to scan;
- do not show raw request IDs, task IDs, CIDs, transaction hashes, or indexing placeholders in the feed. Those belong in task forensics or operator logs.

### Allocated Operators

Source:

- latest Network Diagnostic Report per account;
- account-level availability settings;
- active task load from task projections;
- recent reward/refusal history;
- network task allocation rows.
- derived operator rows from live project task refs and assignee wallets when explicit `network_project_contributors` rows are not present.

Behavior:

- show operators available for network work;
- show load and rough fit, not private memory;
- clicking an operator later should route to public profile, not raw diagnostic internals.

### Hive Context And Secretary

Hive Context is the first live input surface for the future system worker. Hive Secretary is the first live synthesis layer over that input.

Source:

- `hive_context_entries`, written from the default `Hive` chat.
- `hive_secretary_reports`, written by the async Hive Secretary worker from validated-wallet entries.

Behavior:

- store signed-in user inputs as a network context document;
- group raw entries by user;
- show the Hive Secretary report first when the Hive Context section is expanded;
- keep raw user inputs behind a second collapsible `Raw inputs` section;
- ignore chat title in the display;
- only validated linked-wallet inputs feed Hive Secretary;
- keep this off-chain in v1.

The Board Manager should consume Hive Secretary as one source of network need, alongside task state, project state, product documents, and Network Diagnostic Reports.

Implemented pieces:

- `POST /api/hive/context` stores a Hive chat entry and queues Hive Secretary when the account has a linked wallet.
- `GET /api/hive/context` returns grouped raw context plus latest Secretary report/job state.
- `server/hive-secretary-worker.js` calls OpenAI `gpt-5.5-pro` through the Responses API.
- `prompts/hive/hive_secretary_v1.md` defines the Secretary output.
- `GET /api/hive/projects` returns Postgres-backed active project records.
- `PFT distribution v3` is seeded as an apriori project row with About text, target metrics, and latest Hive Secretary input reference.
- Mock-only contributors, task rows, and activity rows were removed. Once the allocation worker links real PFTL task activity to a project, the Hive read model derives tasks, contributors/operators, routing feed, and routed PFT from `network_project_task_refs` plus `task_projections`.
- `server/hive-project-worker.js` uses OpenAI `gpt-5.5-pro` through the Responses API to turn the latest Hive Secretary report into the active project set.
- `prompts/hive/hive_active_projects_v1.md` defines the active project output contract.

Current cleanup:

- the generated `task_node_product_scoping`, `post_fiat_l1_scoping`, and `capital_deployment_protocol_scoping` cards are archived by `server/db/migrations/032_archive_rejected_hive_scoping_projects.sql`;
- the prompt now treats scoping as phase/status, not as a durable project name.

Deprecated cadence:

1. A validated-wallet Hive chat entry saves.
2. Hive Secretary queues immediately.
3. Hive Active Projects queues directly after Hive Secretary.
4. Product documents refresh on their own schedule.

This direct cascade is no longer the target architecture. The replacement is the Board Manager:

1. A trigger starts one Board Manager run under the `global_hive` lease.
2. The manager builds a source packet from Hive Context, Hive Secretary, projects, product docs, tasks, diagnostics, pending evidence, and recent manager actions.
3. The manager chooses one scoped action from its action registry.
4. Existing workers such as Hive Secretary, Active Projects, and future Product Document generation become action handlers.
5. The run records its action and result so the next run knows what happened.
6. If a project is unclear, the manager chooses research, user follow-up, context update, or information-gathering Network Tasks rather than creating a fake project card.

## Network Diagnostic Report Usage

The Network Diagnostic Report is the eligibility and routing input. It is not the final task assignment by itself.

Routing should use it this way:

1. Hard filters:
   - account exists and is active;
   - network tasks are enabled;
   - wallet can receive PFT rewards;
   - active task load is below account limit;
   - latest diagnostic report is present and not stale.
2. Project fit:
   - compare project type and need against the report's current focus, contribution ability, and company/domain fit.
3. Task fit:
   - match the concrete task need to the report in plain-language terms.
4. Allocation:
   - build a candidate list from eligible Network Diagnostic Reports;
   - include public profile summary and private routing summary, not raw hidden memory, in the allocation packet;
   - create `network_task_allocations` rows for the best candidate accounts;
   - publish a PFTL task offer only when the system is ready to push a concrete task to a user.

The report should explain why a user can do a network task. The task system still decides task content, deadline, reward, and verification requirements.

## Network Task Generation Flow

The expected Board Manager flow is:

1. A Board Manager run claims the global Hive lease.
2. The manager evaluates network state and identifies whether any action is needed.
3. If needed, the manager creates or updates a durable `network_project`, selects an existing active project, refreshes a project document, asks for follow-up, researches, or does nothing.
4. If a concrete task should exist, the Board Manager selects `initiate_network_task`. The action records:
   - project id;
   - task class: `network` or `alpha`;
   - candidate user, candidate set, or allocation criteria;
   - reward band, normally `10,000` to `50,000` PFT;
   - why the route fits the contributor's Network Diagnostic Report;
   - cadence reason, for example project gap, stale project, urgent alpha window, or allocation retry.
5. The network-task generation worker builds a source packet:
   - project title, type, objective, and current status;
   - relevant Hive Context entries;
   - recent task refs already attached to the project;
   - the system-detected network need;
   - candidate Network Diagnostic Reports;
   - current task engine reward and evidence policy.
6. The task generator creates a concrete Network Task proposal for a selected account using the same output discipline as personal task generation.
7. The app publishes a PFTL task request/offer carrying project metadata.
8. The cache/reducer indexes the task into `task_projections`.
9. `network_project_task_refs` links the task to the project.
10. The user's Tasks page shows a proposed Network Task.
11. If accepted, it becomes outstanding. If refused or expired, the projection sync updates the allocation mirror and the worker can reroute in a later version.
12. Submission, verification, reward, zero-reward, or cancellation follows the existing task lifecycle.
13. Hive updates project tasks, contributors, routed PFT, and activity from projections.

A Network Task is created by the system. The Hive page can display the project and the resulting task, but it is not the authoring surface for manually creating Network Tasks.

## User-Facing Network Push

When a Network Task is routed to a user, the Tasks page should show a proposed task card similar to the Hive mock:

- special network-pushed container so it is visually distinct from user-requested personal tasks;
- task class badge: `Network Task` or `Alpha Task`;
- project type badge;
- project link, for example `PFT distribution v3`;
- task title and objective;
- reward;
- deadline or accept timer;
- "Why you" derived from the Network Diagnostic Report and task history;
- refusal consequence in plain English;
- Accept and Refuse actions.

Accept/refuse should publish normal PFTL task updates. The allocation row follows the chain state; it does not create a second source of truth.

## Infrastructure Needed

### Database

Implemented migrations:

- `network_projects`, `network_project_task_refs`, `network_project_contributors`, and `network_project_activity`: `server/db/migrations/029_hive_network_projects.sql`
- Network Task allocation and generation job tables: `server/db/migrations/039_network_task_allocations.sql`

Every table is account/project keyed and should remain rebuildable where possible. Avoid embedding raw memory or raw evidence in Hive tables.

### APIs

Initial endpoints:

- `GET /api/hive/projects`
- `GET /api/hive/projects/:projectId`
- `GET /api/hive/routing-feed`
- `GET /api/hive/operators`

These endpoints should return read models shaped for the existing Hive UX, not raw database rows.

Task generation runs through durable internal workers invoked by Board Manager actions, not a public frontend route. A future operator control can inspect or pause Board Manager runs, but it should not manually author Network Tasks.

### Workers

Needed workers/action handlers:

- Board Manager executor: claims the global Hive lease, builds the source packet, selects one action, records the run, and dispatches the action handler.
- project rollup handler: rebuilds contributor and project aggregates from task refs and task projections.
- Hive Secretary handler: refreshes the Secretary report when the Board Manager chooses `refresh_hive_secretary`.
- active project handler: creates, updates, pauses, or archives durable project rows when the Board Manager chooses project actions.
- product document handler: refreshes the expandable project document when the Board Manager chooses `refresh_project_document`.
- network allocation handler: currently selects an explicit candidate from the Board Manager payload or falls back to the latest eligible Network Diagnostic Report with an active user wallet; future versions should add availability settings, refusal history, and richer project fit.
- network task generation handler: implemented as `server/network-task-generation-worker.js`. It consumes a Board Manager `initiate_network_task` decision plus allocation rows, creates an encrypted normal task request bundle, and schedules the existing task-generation worker to publish the PFTL offer.
- network cadence handler: enforces per-account, per-project, and per-class throttles before generation jobs publish user-visible offers.
- allocation expiration handler: marks proposed tasks expired and reroutes when needed.
- evidence review handler: reviews project-linked evidence through the existing task review and reward path.

### Prompt Files

Prompts should live in source-controlled prompt files, not inline code.

Existing and planned prompt files:

- `prompts/hive/hive_active_projects_v1.md` exists now.
- `prompts/hive/board_manager_v1.md` exists now as the planned operating prompt for the manager action registry.
- Network Task generation currently reuses `prompts/task_engine/taskgen_minimal_v1.md` with a populated `network_task` block and authoritative reward-band policy. A separate prompt should be added only if reuse creates a concrete product problem.
- `prompts/hive/network_task_allocation_v1.md` remains planned only if candidate selection needs a separate model step. The current selector is deterministic: explicit Board Manager candidate first, otherwise the latest eligible Network Diagnostic Report with an active user wallet.

`board_manager_v1` is the planned policy boundary. It chooses one action per run from a finite registry.

The harness runs this prompt through a persistent Codex Exec session and defaults to dry-run for app mutations:

- command: `npm run board-manager:codex -- --trigger <name>`;
- execution command: `npm run board-manager:codex -- --trigger <name> --execute`;
- fresh-session command: `npm run board-manager:codex -- --trigger <name> --fresh-session`;
- model: `gpt-5.5`;
- reasoning: `xhigh`;
- schema: `schemas/board-manager-action.schema.json`;
- source packet: Hive Context, Hive Secretary state, active/project registry, task state, task requests, and recent Board Manager runs.
- session table: `board_manager_sessions`; subsequent ticks use `codex exec resume <session_id>`.
- implemented hooks: message a user, refresh Hive Secretary, create a project, archive a project, refresh a project document, assign a contributor, and initiate a Network Task generation job.

`hive_active_projects_v1` currently decides which durable projects exist. In the Board Manager architecture it becomes an action helper, not an independent decision loop.

For `refresh_project_document`, the Board Manager writes `payload.project_document` directly. Core Hive artifacts should not call a secondary model unless the Board Manager explicitly chooses a future delegated research or subagent tool.

The generation prompt should consume project context, task history, candidate diagnostic profile, task class, reward band, and task engine policy. It should be conformant with personal task generation. It should not invent evidence types the app cannot submit.

The allocation prompt may help explain fit, but deterministic filters must still enforce availability, load, cadence, reward policy, and wallet state.

## What Not To Build Yet

Do not make projects canonical chain objects in v1.

Do not create a second task lifecycle for Network Tasks.

Do not expose raw Network Diagnostic Reports publicly.

Do not put project assignment logic in frontend components.

Do not let the AI directly route tasks without deterministic availability and load filters.

Do not let the Board Manager author the final task text directly. It initiates generation; the network-task generation worker produces the concrete PFTL task offer.

Do not generate tasks that ask for unsupported evidence such as video unless the app supports that evidence surface.

## Milestones

### Phase 1: Data Ontology And Read Model

- Create project/task/allocation tables. Done.
- Seed one real active project matching `PFT distribution v3` shape. Done.
- Link task projections to projects through refs. Done for new network tasks.
- Add project metadata fields to new task request/offer payloads. Done for the network-task worker path.
- Replace `src/features/hive/hive-data.js` static data with API data. Done.
- Derive project tasks, operators, routing feed, routed PFT, and profile badges from real project-linked task refs. Done for the current read model.

Done when Hive active projects, project detail tasks, contributors, and routing feed render from Postgres read models.

### Phase 2: Allocation Without Auto-Publish

- Build candidate selection using Network Diagnostic Reports. Partial: explicit Board Manager candidate first, with latest eligible Network Diagnostic Report fallback.
- Store `network_task_allocations` as candidate/queued rows. Done.
- Show proposed routing internally without publishing PFTL offers. Superseded for the current local Docker path, which publishes when the gated worker is enabled.
- Verify operator eligibility and refusal/load handling. Partial: wallet/profile availability exists; full load, refusal, and cadence filters remain open.

Done when the system can explain which users would receive a project task and why, without creating user-visible tasks yet.

### Phase 3: Network-Pushed Task Offers

- Generate one concrete task for one selected user from a project. Done in local Docker.
- Publish a PFTL task offer with project metadata. Done in local Docker.
- Show it in Tasks as a proposed Network Task. Done in local Docker.
- Accept/refuse from the normal task flow. Accept and downstream lifecycle verified; refusal remains the same standard task path.
- Update Hive project board from the resulting task projection. Done through projection sync and derived Hive read model.

Done when a user can accept or refuse a network-pushed task and Hive reflects the state without manual refresh or stale categories.

### Phase 4: Submission, Verification, Reward, And Project Rollup

- Complete the full task lifecycle for project-linked tasks. Done for one local Docker Network Task through reward.
- Roll rewarded tasks into project PFT totals and contributor cards. Done for the derived read model from project task refs; persisted rollup rows remain open.
- Show zero-reward and refused outcomes clearly. Reuses the normal task detail reward/refusal surfaces.
- Keep task forensics as the proof surface for CIDs and transactions. Done through the normal task detail Forensics tab.

Done when the `PFT distribution v3` detail card can be populated with real tasks, contributors, activity, and routed PFT without mock seed rows.

## Acceptance Criteria

- Hive uses the five project types listed in this plan.
- Each project can contain many canonical task refs.
- Each task can be traced back to its project from the Hive UI.
- Contributors are derived from task participation, not manually typed mock rows.
- Routing uses the Network Diagnostic Report plus deterministic availability/load filters.
- Routing distinguishes `network` tasks from `alpha` tasks and applies cadence controls before publication.
- Default project-pushed reward offers come from the `10,000` to `50,000` PFT policy band unless explicit policy metadata says otherwise.
- The user can see why a Network Task was proposed to them.
- Accepting, refusing, submitting, verifying, and rewarding a Network Task use the existing PFTL task lifecycle.
- No Hive read model can make task state disagree with task forensics.

## Reviewer To Do List

Review implementation against this document (making functional network tasks). Mark each item when verified.

### Memory Efficiency
- [ ] Plan phases avoid loading unbounded history or corpus into single jobs.
- [ ] Derived read models prefer projections over duplicate materialized stores.
- [ ] Network generation worker batch size 1; allocation status mirrors projection.

### Code Quality
- [ ] Done criteria map to testable checks or smoke commands.
- [ ] Status (implemented vs planned) accurate on every section.
- [ ] Live smoke IDs in doc still valid or marked historical.

### Coherence
- [ ] Plan does not contradict shipped behavior in Surfaces/Architecture docs.
- [ ] Dependencies on other plans explicitly named and still valid.
- [ ] Board Manager allocates; task-generation worker authors; PFTL owns lifecycle.

### Bloat
- [ ] Plan scoped to stated phase; future work not implied as shipped.
- [ ] Avoid duplicating full surface doc content; link instead.
- [ ] Hive mirrors task state; does not duplicate reducer logic.

### Security
- [ ] New tables/routes in plan include account ownership and encryption notes.
- [ ] Operator-only actions identified with audit requirements.
- [ ] Fake smoke jobs marked failed so live worker skips test data.
