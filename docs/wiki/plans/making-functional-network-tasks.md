# Making Functional Network Tasks

Status: planning

This plan supersedes the earlier broad Hive Mind planning for Network Tasks. The Board Manager plan now supersedes the direct-worker cadence described in earlier versions of this document. The current Hive UX remains the starting point for the product ontology, but the Board Manager owns when the system updates context, creates projects, refreshes project documents, assigns contributors, and initiates Network Tasks.

## Product Objective

Hive should answer three questions without making the user inspect raw chain data:

1. What projects is the network actively pushing forward?
2. Which tasks belong to each project, and what state are they in?
3. Which operators are being allocated to network work, and why are they eligible?

The project-detail shape in the `PFT distribution v3` mock is the reference layout: a project board with an About section, contributors, tasks, and scoped activity. The live app should not seed fake operators or fake task rows to make that layout look full. It should show the project spec first, then populate contributors, tasks, and activity only when the Board Manager or project rollup links live project allocation data.

The current correction is that "scoping" is not a project. Scoping can be a phase, a status, or a reason to create information-gathering Network Tasks. It should not appear as the project title. A project title should name the durable workstream, such as `Post Fiat L1`, `Capital Deployment Protocol`, or `Task Node Product`, with `phase_label = Scoping` when the system is still gathering information.

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

Planned table for the expandable product document linked to each project. This is not implemented yet.

One current product document per project, plus historical rows for audit.

Fields:

- `id`
- `project_id`
- `status`: `current`, `superseded`, or `failed`
- `source_hive_secretary_report_id`
- `source_project_generation_id`
- `source_task_refs_digest`
- `provider`: `openrouter`
- `model`: `deepseek/deepseek-v4-pro`
- `prompt_version`: `hive_project_product_doc_v1`
- `output_json`
- `output_text`
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

The authoritative task state still comes from PFTL task events and `task_projections` after allocation. Before allocation, this table can hold apriori project task rows so a project board can exist before concrete tasks are pushed to users. It is still not a second canonical task state machine.

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

### `network_task_allocations`

Tracks network-pushed tasks before and during user acceptance.

Fields:

- `id`
- `project_id`
- `task_id`: nullable until a concrete task offer exists.
- `candidate_account_id`
- `candidate_wallet_address`
- `allocation_status`: `candidate`, `proposed`, `accepted`, `refused`, `expired`, `rerouted`, or `completed`.
- `network_diagnostic_report_id`
- `network_diagnostic_report_digest`
- `allocation_reason_summary`
- `expires_at`
- `created_at`
- `updated_at`

This table powers the "network pushed this to you" experience. It must never override chain task state. It explains routing and tracks allocation lifecycle.

### `network_task_generation_jobs`

Durable async jobs that convert a project need into concrete task offers.

Fields:

- `id`
- `project_id`
- `system_run_id`
- `trigger`: `network_snapshot`, `project_gap`, `allocation_retry`, or `task_state_change`
- `source_payload_digest`
- `provider`
- `model`
- `prompt_version`
- `status`: `queued`, `running`, `generated`, `published`, or `failed`.
- `generated_task_payload`
- `task_id`
- `request_id`
- `offer_cid`
- `offer_tx_hash`
- `error`
- `created_at`
- `updated_at`

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
- contributor previews from `network_project_contributors`
- PFT routed from the current project snapshot, later replaced by reward events in `task_projections` / reward projections

Behavior:

- show active projects grouped or labeled by type;
- clicking a project opens the project board;
- show a copyable project id in the project card or detail header;
- `PFT distribution v3` remains the visual reference for project detail cards.
- The seeded project row may expose planned/scoped metrics, but contributor cards, task rows, and routing feed rows must come from real project-linked allocation rows.
- projects are read from `GET /api/hive/projects`, not from React mock data.
- do not show generated cards whose project title is a discovery activity such as "scoping". Scoping belongs in `phase_label` or in the product document status.

### Expandable Product Document

Source:

- current `network_projects` row;
- latest Hive Secretary report;
- latest active-project generation;
- project-linked task refs and contributor rollups when they exist;
- planned `network_project_product_docs` row generated by DeepSeek V4 Pro with a ZDR provider.

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

Behavior:

- show recent project-scoped transitions in plain English;
- include the project name, task name, operator, state, time, and PFT when relevant;
- do not show raw CIDs or transaction hashes in the feed. Those belong in task forensics.

### Allocated Operators

Source:

- latest Network Diagnostic Report per account;
- account-level availability settings;
- active task load from task projections;
- recent reward/refusal history;
- network task allocation rows.

Behavior:

- show operators available for network work;
- show load and rough fit, not private memory;
- clicking an operator later should route to public profile, not raw diagnostic internals.

### Hive Context And Secretary

Hive Context is the first live input surface for the future system worker. Hive Secretary is the first live synthesis layer over that input.

Source:

- `hive_context_entries`, written from Chat `+` menu `Hive Input` mode.
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

- `POST /api/hive/context` stores Hive Input and queues Hive Secretary when the account has a linked wallet.
- `GET /api/hive/context` returns grouped raw context plus latest Secretary report/job state.
- `server/hive-secretary-worker.js` calls OpenAI `gpt-5.5-pro` through the Responses API.
- `prompts/hive/hive_secretary_v1.md` defines the Secretary output.
- `GET /api/hive/projects` returns Postgres-backed active project records.
- `PFT distribution v3` is seeded as an apriori project row with About text, target metrics, and latest Hive Secretary input reference.
- Mock-only contributors, task rows, and activity rows were removed; those sections remain empty until the allocation worker links real PFTL task activity to the project.
- `server/hive-project-worker.js` uses OpenAI `gpt-5.5-pro` through the Responses API to turn the latest Hive Secretary report into the active project set.
- `prompts/hive/hive_active_projects_v1.md` defines the active project output contract.

Current cleanup:

- the generated `task_node_product_scoping`, `post_fiat_l1_scoping`, and `capital_deployment_protocol_scoping` cards are archived by `server/db/migrations/032_archive_rejected_hive_scoping_projects.sql`;
- the prompt now treats scoping as phase/status, not as a durable project name.

Deprecated cadence:

1. A validated-wallet Hive Input saves.
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
   - create `network_task_allocations` rows for the best candidate accounts;
   - publish a PFTL task offer only when the system is ready to push a concrete task to a user.

The report should explain why a user can do a network task. The task system still decides task content, deadline, reward, and verification requirements.

## Network Task Generation Flow

The expected Board Manager flow is:

1. A Board Manager run claims the global Hive lease.
2. The manager evaluates network state and identifies whether any action is needed.
3. If needed, the manager creates or updates a durable `network_project`, selects an existing active project, refreshes a project document, asks for follow-up, researches, or does nothing.
4. If a concrete task should exist, the task generation action builds a source packet:
   - project title, type, objective, and current status;
   - relevant Hive Context entries;
   - recent task refs already attached to the project;
   - the system-detected network need;
   - candidate Network Diagnostic Reports;
   - current task engine reward and evidence policy.
5. The task generator creates a concrete Network Task proposal for a selected account.
6. The app publishes a PFTL task request/offer carrying project metadata.
7. The cache/reducer indexes the task into `task_projections`.
8. `network_project_task_refs` links the task to the project.
9. The user's Tasks page shows a proposed Network Task.
10. If accepted, it becomes outstanding. If refused or expired, allocation status updates and the worker can reroute.
11. Submission, verification, reward, zero-reward, or cancellation follows the existing task lifecycle.
12. Hive updates project tasks, contributors, routed PFT, and activity from projections.

A Network Task is created by the system. The Hive page can display the project and the resulting task, but it is not the authoring surface for manually creating Network Tasks.

## User-Facing Network Push

When a Network Task is routed to a user, the Tasks page should show a proposed task card similar to the Hive mock:

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

Add migrations for:

- `network_projects`
- `network_project_task_refs`
- `network_project_contributors`
- `network_task_allocations`
- `network_task_generation_jobs`

Every table should be account/project keyed and rebuildable where possible. Avoid embedding raw memory or raw evidence in Hive tables.

### APIs

Initial endpoints:

- `GET /api/hive/projects`
- `GET /api/hive/projects/:projectId`
- `GET /api/hive/routing-feed`
- `GET /api/hive/operators`

These endpoints should return read models shaped for the existing Hive UX, not raw database rows.

Task generation should run through durable internal workers invoked by Board Manager actions, not a public frontend route. A future operator control can inspect or pause Board Manager runs, but it should not manually author Network Tasks.

### Workers

Needed workers/action handlers:

- Board Manager executor: claims the global Hive lease, builds the source packet, selects one action, records the run, and dispatches the action handler.
- project rollup handler: rebuilds contributor and project aggregates from task refs and task projections.
- Hive Secretary handler: refreshes the Secretary report when the Board Manager chooses `refresh_hive_secretary`.
- active project handler: creates, updates, pauses, or archives durable project rows when the Board Manager chooses project actions.
- product document handler: refreshes the expandable project document when the Board Manager chooses `refresh_project_document`.
- network allocation handler: selects eligible candidates from Network Diagnostic Reports.
- network task generation handler: creates concrete tasks and publishes PFTL offers.
- allocation expiration handler: marks proposed tasks expired and reroutes when needed.
- evidence review handler: reviews project-linked evidence through the existing task review and reward path.

### Prompt Files

Prompts should live in source-controlled prompt files, not inline code.

Existing and planned prompt files:

- `prompts/hive/hive_active_projects_v1.md` exists now.
- `prompts/hive/board_manager_v1.md` exists now as the planned operating prompt for the manager action registry.
- `prompts/hive/hive_project_product_doc_v1.md` is planned with the product-document worker.
- `prompts/hive/network_task_generation_v1.md` is planned with the network task generation worker.
- `prompts/hive/network_task_allocation_v1.md` is planned with the allocation worker.

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
- implemented hooks: message a user, refresh Hive Secretary, create a project, archive a project, and assign a contributor.

`hive_active_projects_v1` currently decides which durable projects exist. In the Board Manager architecture it becomes an action helper, not an independent decision loop.

`hive_project_product_doc_v1` should use OpenRouter `deepseek/deepseek-v4-pro` with a ZDR-capable provider. It should produce the expandable product document for one project at a time from the project row, latest Secretary report, and project-linked task state.

The generation prompt should consume project context, task history, candidate diagnostic profile, and task engine policy. It should not invent evidence types the app cannot submit.

The allocation prompt may help explain fit, but deterministic filters must still enforce availability, load, and wallet state.

## What Not To Build Yet

Do not make projects canonical chain objects in v1.

Do not create a second task lifecycle for Network Tasks.

Do not expose raw Network Diagnostic Reports publicly.

Do not put project assignment logic in frontend components.

Do not let the AI directly route tasks without deterministic availability and load filters.

Do not generate tasks that ask for unsupported evidence such as video unless the app supports that evidence surface.

## Milestones

### Phase 1: Data Ontology And Read Model

- Create project/task/allocation tables.
- Seed one real active project matching `PFT distribution v3` shape.
- Link existing task projections to a project through refs.
- Add project metadata fields to new task request/offer payloads.
- Replace `src/features/hive/hive-data.js` static data with API data.

Done when Hive active projects, project detail tasks, contributors, and routing feed render from Postgres read models.

### Phase 2: Allocation Without Auto-Publish

- Build candidate selection using Network Diagnostic Reports.
- Store `network_task_allocations` as `candidate` rows.
- Show proposed routing internally without publishing PFTL offers.
- Verify operator eligibility and refusal/load handling.

Done when the system can explain which users would receive a project task and why, without creating user-visible tasks yet.

### Phase 3: Network-Pushed Task Offers

- Generate one concrete task for one selected user from a project.
- Publish a PFTL task offer with project metadata.
- Show it in Tasks as a proposed Network Task.
- Accept/refuse from the normal task flow.
- Update Hive project board from the resulting task projection.

Done when a user can accept or refuse a network-pushed task and Hive reflects the state without manual refresh or stale categories.

### Phase 4: Submission, Verification, Reward, And Project Rollup

- Complete the full task lifecycle for project-linked tasks.
- Roll rewarded tasks into project PFT totals and contributor cards.
- Show zero-reward and refused outcomes clearly.
- Keep task forensics as the proof surface for CIDs and transactions.

Done when the `PFT distribution v3` detail card can be populated with real tasks, contributors, activity, and routed PFT without mock seed rows.

## Acceptance Criteria

- Hive uses the five project types listed in this plan.
- Each project can contain many canonical task refs.
- Each task can be traced back to its project from the Hive UI.
- Contributors are derived from task participation, not manually typed mock rows.
- Routing uses the Network Diagnostic Report plus deterministic availability/load filters.
- The user can see why a Network Task was proposed to them.
- Accepting, refusing, submitting, verifying, and rewarding a Network Task use the existing PFTL task lifecycle.
- No Hive read model can make task state disagree with task forensics.
