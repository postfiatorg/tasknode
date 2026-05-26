# Board Manager

Status: deprecated implemented v0 plan. Current product truth lives in `Surfaces -> Hive`, `Architecture -> AI Providers`, `Architecture -> Deployment`, and `Architecture -> Board Manager`.

This plan supersedes the earlier idea that Hive should be driven by a set of independent cron-style workers. Hive should be managed by a single Board Manager execution loop that decides when to update context, research, create projects, archive projects, refresh project documents, route tasks, or do nothing.

Historical professionalism diagnosis: [Hive Board Professionalism Diagnosis](./hive-board-professionalism-diagnosis.md). The current review standard for active board semantics, fake count prevention, reversible archives, and resurrection behavior lives in `Surfaces -> Hive` and `Architecture -> Board Manager`.

## Product Role

The Board Manager manages the Hive page and Hive interactions across the Post Fiat Task Node app.

It is a high-reasoning decision worker with a bounded action registry. The default provider is OpenRouter `qwen/qwen3.7-max`; OpenAI `gpt-5.5-pro` is an override route, not the default. It is not a chat bot, not a public user, and not a frontend component. It is the system operator for the network board.

The current default decision path uses direct DeepSeek API `deepseek-v4-pro` as a secretary packet builder before Qwen. DeepSeek reads the full deterministic Hive source packet and writes a compact Board Triage packet into `board_manager_secretary_packets`. Qwen then chooses one validated Board Manager action from that compact packet. This keeps Qwen decisions much cheaper while preserving a human-auditable source digest and packet digest.

The Board Manager should answer:

1. What does the network know right now?
2. What projects are real enough to put on the Hive board?
3. What information is missing?
4. Which users should be asked for follow-up context?
5. Which network tasks should be proposed, to whom, and for what reward?
6. Which evidence packets or project states need review?

## Execution Model

The Board Manager should be single-threaded in v1.

It should not run on every Fly instance. The app needs a lease or ownership boundary so only one manager acts at a time.

Planned ownership model:

- `board_manager_leases` has one active lease row for the global board manager.
- A process can claim the lease only when it is expired or explicitly released.
- The lease records `manager_id`, `owner_instance`, `scope`, `claimed_at`, `heartbeat_at`, and `expires_at`.
- Each run records a durable `board_manager_runs` row with source packet digest, selected action, outcome, and errors.
- Each completed run also records a micro summary artifact in `board_manager_runs.micro_summary_json` and `board_manager_runs.micro_summary_text`.
- The first scope is `global_hive`.
- Later scopes can be project-specific, for example `project:pft_distribution_v3`, if the network becomes too large for one global manager.

The default v1 posture is conservative. Most ticks should do nothing unless there is stale state, new validated input, a blocked project, pending evidence, or a clear task allocation opportunity.

## Board Action Pressure

The Board Manager source packet now includes `boardActionPressure`, a deterministic health summary built before the model chooses an action. This exists because an active board can look superficially stable while actually being stalled.

The pressure signal treats these conditions as action-required:

- an active project has no live project task rows;
- an active project has no live contributor rows;
- an active project has no outstanding Network Task and no pending Network Task generation;
- a project-linked Network Task was refused, cancelled, rejected, expired, failed, or rerouted without a replacement or closure decision;
- the Hive Secretary report is stale.

Planned counts are not live work and must not be rendered as task rows, routed PFT, or allocated operators. Motion requires corresponding task refs, allocation rows, contributors, pending generation jobs, or outstanding Network Tasks.

When `boardActionPressure.summary.requiresAction` is true, `do_nothing` is not a valid Board Manager outcome unless a recent run is already handling the same project and the decision reason names that in-flight action. Empty active projects should move toward one of four outcomes: initiate a Network Task, assign a contributor, ask a specific user for the smallest missing decision input, or archive the project when it cannot be managed now.

`eligibleCandidateCount` in this health block means candidates available after current outstanding and pending Network Tasks are accounted for. Personal tasks and engineering tasks are not capacity blockers; they are only routing context. If a contributor is unavailable, `boardActionPressure.candidateCapacity.activeNetworkTaskCapacityBlockers` names the outstanding Network Task or pending generation job consuming that contributor's capacity. The Board Manager should not keep assigning the same contributor while they already have a live Network Task unless it explicitly chooses an over-capacity exception. If a stale follow-up run races with a just-created allocation, the action hook records `network_task_candidate_at_capacity` as a skipped result instead of retrying the same invalid mutation.

## Production Architecture Plan

The current `npm run board-manager:loop -- --execute` path is a local development harness. It is useful for proving decisions and action hooks, but it is not the production architecture. Production should not depend on tmux, an SSH session, a manually watched shell, or every web instance running the manager.

The production target is a Fly-managed worker process with a Postgres lease and durable job queue. The first production-shaped implementation now exists.

Implemented process split:

- `web`: serves the API and app. It may enqueue Board Manager jobs, but it does not run background workers when `TASKNODE_PROCESS_ROLE=web`.
- `worker`: runs ordinary app workers such as task generation, task review, PFTL cache sync, Hive Secretary, and network-task generation when `TASKNODE_PROCESS_ROLE=worker`.
- `board-manager`: runs only the Board Manager scheduler/executor through `npm run start:board-manager`.

`server/process-role.js` owns the role policy. `server/index.js` now starts HTTP and ordinary workers according to `TASKNODE_PROCESS_ROLE` / `FLY_PROCESS_GROUP`, preserving the local default `all` role while allowing Fly to split `web` and `worker`.

Fly deployment target:

- `fly.toml` defines process groups for `app`, `worker`, and `board-manager`;
- `start:board-manager` sets `TASKNODE_BOARD_MANAGER_ENABLED=true` for the dedicated process;
- the production image provides the selected Board Manager provider credentials to the `board-manager` process group;
- run one `board-manager` machine by default with Fly process scaling;
- allow a second standby machine later, relying on the Postgres lease to prevent duplicate actions;
- keep provider keys in Fly secrets, not in Postgres;
- write all decisions, action results, and summaries to Postgres so the Hive UI remains the audit surface.

## Production Scheduler

The Board Manager needs durable trigger records, not a shell sleep loop.

Implemented tables:

- `board_manager_scopes`: enabled scopes such as `global_hive`, cadence, pause flag, max actions per hour, and next due timestamp.
- `board_manager_jobs`: durable trigger queue with `scope`, `trigger`, `reason`, `idempotency_key`, `run_after`, `attempt_count`, `claimed_at`, `completed_at`, and `failed_at`.
- `board_manager_leases`: existing lease table, hardened with heartbeat and owner instance tracking.
- `board_manager_runs`: existing run table, retained as the durable decision log.
- `board_manager_action_results`: existing action-result table, retained as the durable mutation/audit log.

Migration `server/db/migrations/042_board_manager_scheduler.sql` creates `board_manager_scopes` and `board_manager_jobs` and seeds the `global_hive` scope.

Job sources:

- periodic scope tick;
- new validated Hive chat entry;
- stale Hive Secretary report;
- stale or missing project product document;
- project has unresolved status or no next action;
- pending Network Task allocation window;
- pending evidence/review work that the Board Manager is allowed to inspect;
- manual operator trigger.

Every job should carry an idempotency key. Repeated triggers for the same state change should coalesce instead of generating duplicate runs.

Implemented worker loop:

1. poll for due `board_manager_jobs`;
2. claim one job with an atomic Postgres transaction;
3. claim the scope lease or defer the job if another manager owns it;
4. build the source packet;
5. call the configured Board Manager decision provider with the compact source packet;
6. validate the selected action against `schemas/board-manager-action.schema.json`;
7. execute at most one supported action hook;
8. write `board_manager_runs`, `board_manager_action_results`, and the micro summary;
9. schedule the next tick from scope cadence and action outcome;
10. release or heartbeat the lease.

The worker entrypoint is `scripts/board-manager-worker.mjs`. It uses `enqueueDueBoardManagerTicks`, `claimBoardManagerJob`, and the existing `scripts/board-manager-model-exec.mjs` one-shot executor. It does not duplicate the model decision logic.

The scheduler repository is `server/repositories/board-manager-scheduler.js`. The source-packet/run repository remains `server/repositories/board-manager.js`.

Backoff rules:

- `do_nothing`: schedule the next periodic tick using the normal scope cadence, not an aggressive tight loop.
- mutation succeeded: schedule a shorter follow-up check so the manager can observe the resulting state.
- recoverable failure: retry with exponential backoff and a bounded attempt count.
- validation failure: record the run as rejected, do not execute an action, and enqueue an operator-visible failure.
- stuck lease: a later worker may claim only after `expires_at` passes.

## Scaling Model

V1 should be logically single-threaded with one scope: `global_hive`.

The design should still allow production failover:

- multiple Fly machines can run the `board-manager` process;
- only the machine holding the lease for `global_hive` can execute;
- all other machines remain idle or process other scopes later;
- action hooks must be idempotent so a retry cannot duplicate a user message, project, or Network Task.
- `board_manager_scopes.max_actions_per_hour` is enforced before the worker claims another job. The default active budget is 60 model-selected mutations per hour for `global_hive`, allowing manual follow-up jobs without leaving normal activity blocked. Completed non-dry-run actions other than `do_nothing` count against the cap. Internal audit cards such as `daily_airdrop` do not count against this budget because they are worker reports, not Board Manager decisions. When the cap is reached the worker logs `action_rate_limited` and leaves due jobs untouched until the rolling hour clears.
- Running jobs older than `TASKNODE_BOARD_MANAGER_STALE_JOB_SECONDS` are recovered by the worker before each claim. The default is 900 seconds. Recovery moves the stale row back to `deferred` for retry, or to `failed` if it already exhausted attempts, so a killed Docker/Fly process cannot leave Hive permanently stuck on an abandoned claim.

Later scaling can add project-scoped managers:

- `global_hive` keeps network-level context and decides which project scopes need work;
- `project:<project_id>` scopes refresh project documents, contributor assignments, and Network Task allocations for one project;
- each scope has its own lease, session, cadence, and rate limits.

Do not add project-scoped managers until the single `global_hive` manager is stable in production.

## Context Control

The Board Manager should remain state-aware without relying on an ever-growing model session.

Rules:

- The default Qwen decision source is a compact DeepSeek secretary packet when `DEEPSEEK_API_KEY` is configured and `TASKNODE_BOARD_MANAGER_SECRETARY_ENABLED` is not `false`.
- `--no-secretary` on `scripts/board-manager-model-exec.mjs` forces the old full-source packet for debugging and comparison.
- Secretary packet reuse is keyed by a semantic source digest. Generated timestamps, trigger labels, freshness age counters, source-text generated lines, and no-op run churn do not force a new DeepSeek call. Material board state changes still do.
- Each run includes compact Board Manager micro summaries rather than full prior source packets.
- The source packet is compacted before the model sees it. Project rows, task request rows, task projection rows, Network Task content, eligible user profiles, and recent Board Manager runs are bounded and summarized so stale history cannot blow up the decision context.
- Eligible user context comes from `network_task_profiles`, generated asynchronously by the DeepSeek Flash ZDR memory route, rather than raw context documents or chat history.
- The packet must continue to include the compact Network Task content snapshot, project documents, Hive Secretary summary, recent validated Hive chat entries, eligible contributor profiles, and recent Board Manager summaries.
- Raw private user data should stay out of the packet unless the selected action requires it and the user has provided it through a validated Hive path.

## Operator Controls

The production system needs explicit controls so the manager is observable and stoppable without SSHing into tmux.

Required controls:

- pause or resume a scope;
- enqueue a manual dry-run;
- enqueue a manual execute run;
- inspect current lease owner, heartbeat, and expiry;
- inspect queued/running/failed jobs;
- force-expire a stale lease after confirming no worker is alive;
- view last successful run, last failed run, and last selected action;
- view recent micro summaries in the Hive Mind Agent feed.

Implemented script controls:

- `npm run board-manager:ops -- status`
- `npm run board-manager:ops -- enqueue --reason "Manual check"`
- `npm run board-manager:ops -- pause`
- `npm run board-manager:ops -- resume`
- `npm run board-manager:ops -- ensure-scope`

These are script-level controls today. They should later become a small internal operator page.

## Observability

Every production run needs enough data for a human to answer what happened.

Log fields:

- `scope`
- `job_id`
- `run_id`
- `lease_id`
- `session_id`
- `trigger`
- `source_packet_digest`
- `selected_action`
- `target_type`
- `target_id`
- `execution_status`

UI/audit fields:

- selected action;
- plain-English decision reason;
- action result;
- whether the action mutated state;
- next planned check;
- error summary if validation or execution failed.

The Hive Mind Agent tab is the product-facing audit surface. It should show `do_nothing` decisions with reasons, not hide them as absence of activity.

## Implementation Burndown

1. Done: add process-role gates so web/API instances cannot run ordinary background workers.
2. Done: add durable `board_manager_scopes` and `board_manager_jobs` tables.
3. Done: add `scripts/board-manager-worker.mjs` as the production-safe worker entrypoint.
4. Done: make the worker claim jobs through Postgres transactions and run the existing one-shot executor, which still claims the Board Manager lease.
5. Partial: add job idempotency keys and active-job coalescing. Action-hook-level idempotency should still be tightened for each mutating hook before multi-machine production scale.
6. Done: add `scripts/board-manager-scheduler-smoke.mjs` for process-role policy, job idempotency, and two-worker job claiming.
7. Pending: add packet-size reporting by source-packet section before each run.
8. Partial: add operator scripts for status, enqueue, pause, resume, and ensure-scope. Stale lease recovery should be added before unattended production operation.
9. Done: update Fly process configuration for `app`, `worker`, and `board-manager`.
10. Pending: run local Docker with two board-manager workers and confirm lease exclusion against the full configured-provider decision path.
11. Pending: deploy to Fly with one `board-manager` process and confirm a manual trigger writes exactly one run.
12. Pending: enable periodic production cadence only after manual trigger, failover, and idempotency tests pass.

Done means:

- no tmux or manual shell is required for production Board Manager operation;
- web instances do not run Board Manager work;
- a crashed manager recovers through lease expiry and durable jobs;
- duplicate Fly machines cannot duplicate actions;
- every action and `do_nothing` decision is auditable in Postgres and visible through the Hive Mind Agent feed;
- Network Task lifecycle state still comes from PFTL/task projections, not from the Board Manager.

## V0 Decision Harness

Implemented v0 pieces:

- `server/repositories/board-manager.js` builds the current Hive source packet and validates the returned action.
- `server/repositories/board-manager.js` formats a Hive Mind Agent feed from `board_manager_runs` and `board_manager_action_results`.
- `server/board-manager-decision-provider.js` calls OpenRouter Chat Completions with `qwen/qwen3.7-max`, `reasoning.effort = high`, structured JSON output, `provider.data_collection = "deny"`, and `usage.include = true` by default.
- `server/board-manager-secretary-packets.js` calls direct DeepSeek API `deepseek-v4-pro`, normalizes the JSON Board Triage packet, persists it, and reuses it when the semantic source digest has not changed.
- The same provider boundary can call OpenAI Responses with `gpt-5.5-pro`, `reasoning.effort = high`, structured JSON output, and `store = false` when `TASKNODE_BOARD_MANAGER_PROVIDER=openai`.
- `schemas/board-manager-action.schema.json` constrains the model output, including action-specific `project`, `contributor`, `network_task`, `message_text`, and `archive_reason` payload fields.
- `scripts/board-manager-model-exec.mjs` runs one Board Manager decision through the configured provider and records the selected action.
- `scripts/board-manager-codex-exec.mjs` remains available as a manual repo-aware operator path, not the production Board Manager default.
- `server/board-manager-actions.js` executes the first supported actions, including project-document refresh.
- `server/db/migrations/033_board_manager_v0.sql` adds lease, run, and action-result tables.
- `server/db/migrations/034_lock_operator_archived_hive_projects.sql` locks operator-archived Hive projects so the project planner cannot silently reactivate rejected cards.
- `server/db/migrations/035_board_manager_action_hooks.sql` adds user-visible Board Manager messages.
- `server/db/migrations/036_board_manager_persistent_sessions.sql` remains for historical Codex operator sessions; the default provider decision path is stateless and uses run summaries for continuity.
- `server/db/migrations/038_network_project_product_docs.sql` adds current/superseded product documents for Hive projects.
- `server/db/migrations/039_network_task_allocations.sql` adds Network Task allocation and generation job tables.
- `server/db/migrations/041_board_manager_run_micro_summaries.sql` adds the durable per-run micro summary artifact.
- `server/db/migrations/042_board_manager_scheduler.sql` adds the durable scheduler scope/job tables.
- `server/db/migrations/043_board_manager_secretary_packets.sql` adds reusable DeepSeek secretary packets for Board Manager decisions.
- `npm run board-manager:model -- --trigger <name>` runs one dry-run Board Manager decision.
- `npm run board-manager:model -- --trigger <name> --execute` runs one Board Manager decision and executes supported action hooks.
- `npm run board-manager:model -- --packet-only` prints the source packet without calling the model provider.
- `npm run board-manager:model -- --trigger <name> --no-secretary` runs the old full-source decision path.
- `npm run board-manager:loop -- --execute` runs the continuous local Board Manager loop for development.
- `npm run board-manager:worker -- --execute` runs the durable job-driven Board Manager worker.
- `npm run board-manager:ops -- status` shows the scope, lease, and recent jobs.
- local Docker has a dedicated `board-manager` service in `docker-compose.dev.yml`; it runs the durable worker continuously and is separate from the API/web containers. It reads `TASKNODE_BOARD_MANAGER_CADENCE_SECONDS` and defaults to 900 seconds for periodic Board Manager ticks in local and Fly environments. It reads `TASKNODE_BOARD_MANAGER_MAX_ACTIONS_PER_HOUR` and defaults to 60 useful board mutations per rolling hour. It also reads `TASKNODE_BOARD_MANAGER_STALE_JOB_SECONDS` and defaults to 900 seconds before recovering an abandoned running job.

The default remains dry-run for app mutations. Execution of app hooks still requires the explicit `--execute` flag.

At the end of each recorded run, the app now writes a small Board Manager Run Summary artifact. It contains the run id, trigger, selected action, target, result, reason, next steps, source packet digest, session mode, and a compact list of action results. This is the durable artifact future runs should read instead of replaying full historical `decision_json`, `action_payload_json`, and action-result payloads.

The source packet still preserves enough run history for continuity, but it passes recent Board Manager runs as micro summaries. User routing context is compacted through `network_task_profiles`, generated asynchronously by the DeepSeek Flash ZDR memory route. This prevents each decision call from receiving full user context documents, chat history, or raw memory bundles.

The local continuous loop is implemented by `scripts/board-manager-loop.mjs`. It repeatedly invokes the one-shot executor instead of duplicating Board Manager logic. Each tick still claims the normal lease, records a run row, writes the micro summary, and executes only supported action hooks. If the selected action is `do_nothing`, the loop waits two minutes by default before the next tick. If the selected action mutates the board, it waits only the shorter action delay so the manager can observe the resulting state. This local harness is not the Fly production architecture; production should use the durable scheduler and process split described above.

The Board Manager does not manage task lifecycle status. It may decide that a project should route work to a contributor, but after the task offer exists, status comes from signed PFTL task events and the `task_projections` read model. Hive project task refs and allocation rows mirror that projection for display and routing load; they are not a second source of truth.

The current Hive board also derives Routing Feed and Allotted Operator rows from `network_project_task_refs` when explicit contributor/activity rows are empty. This keeps the board visible after a live project-linked task exists without letting the Board Manager invent task status. The chain-backed path is `task_projections -> network_project_task_refs -> Hive read model`.

Implemented action hooks:

- `do_nothing`: records an action result with no mutation.
- `message_user`: writes an assistant response into the user's default Hive chat conversation and records a delivery audit row in `board_manager_user_messages`.
- `refresh_hive_secretary`: queues a Hive Secretary job from the current validated Hive Context packet.
- `create_project`: creates or updates an active `network_projects` row from `payload.project`.
- `archive_project`: archives the project as a soft Board Manager archive. Hard delete is intentionally not available. Autonomous archives must be reversible and must not apply the operator archive lock.
- `assign_contributor`: upserts a project contributor row using the project id and wallet address in `payload.contributor`.
- `refresh_project_document`: persists the Board Manager's own `payload.project_document`, supersedes the prior current document, and writes a new `network_project_product_docs` row.
- `initiate_network_task`: creates a project-linked allocation and queued generation job from `payload.network_task`; the worker later hands that job to the normal task-generation engine.
- `daily_airdrop`: internal audit action written by the Daily Airdrop worker after it scores/issues daily drops. The Board Manager model should not select this action; it exists so Hive Mind Agent can display payout runs in the same inspectable feed.

Hive page visibility:

- The collapsed `Hive Context` section contains a `Hive Mind Agent` tab.
- The tab shows recent Board Manager runs as a feed, including `do_nothing` and runs with no recorded selected action.
- Internal smoke/test runs remain queryable for verification but are filtered out of the normal Hive Mind Agent feed.

Not yet implemented action hooks:

- `update_board_context`
- `research`
- `update_project`
- `remove_contributor`
- `review_evidence_packet`

## Trigger Policy

The Board Manager should be triggered by logical timing and state changes, not by every frontend page view.

Initial triggers:

- periodic tick, likely every 15 to 60 minutes;
- new validated-wallet Hive chat entry;
- Hive Secretary report older than the freshness threshold;
- project product document missing or stale;
- project has unclear next steps;
- network task allocation window is open;
- task evidence or verification response is pending system review;
- manual operator trigger for debugging.

The trigger does not decide the work. It only starts a Board Manager run. The manager inspects the current packet and chooses one scoped action or `do_nothing`.

## Source Packet

Each run should build one source packet before the model call.

Inputs:

- current Board Manager context document;
- latest Hive Context entries from validated wallets;
- latest Hive Secretary report and age;
- active, paused, and recently archived network projects;
- project product documents and age;
- project-linked tasks and reward state;
- compact Network Task content snapshot;
- pending evidence packets;
- Network Diagnostic Reports for eligible users;
- user availability and network-task settings;
- recent Board Manager runs and actions;
- recent Board Manager micro summaries;
- reward budget and rate-limit policy;
- allowed action registry.

The packet should avoid raw private data unless the action requires it. Public profile summaries and Network Diagnostic Reports are better routing inputs than raw chat memory.

The implemented packet includes `networkTaskContent`, built by `server/repositories/network-tasks.js::getNetworkTaskContentSnapshot`. This gives the Board Manager enough task substance to make project decisions without reading full forensics. It includes the last five rewarded Network Tasks with descriptions, steps, submission requirements, paid reward, state, and reward summary. It also includes outstanding project-linked Network Tasks, stopped project-linked Network Tasks, and queued/running/generated network-task jobs that do not have a projected task yet.

This matters because the Board Manager should not merely know that a task was rewarded. It needs to know what the task asked for, what state it reached, whether it stopped through refusal/cancel/failure, and what reward outcome occurred before it updates a project document or allocates follow-on work.

## Action Registry

The Board Manager model chooses from a small explicit registry. Code validates the chosen action before executing it.

### `do_nothing`

No board action is needed.

Use when:

- no inputs changed materially;
- recent runs already handled the issue;
- a possible action would be speculative.

### `update_board_context`

Update the Board Manager context document.

Use when:

- validated Hive chat entries add durable network context;
- the manager needs to preserve a decision, unresolved question, or operating assumption.

Output:

- concise update text;
- source input references;
- reason for the update.

### `refresh_hive_secretary`

Update the Hive Secretary report if it is stale or missing.

Use when:

- new validated Hive chat entry exists;
- the report is older than the freshness threshold;
- the Board Manager context changed enough to require a fresh summary.

Current implementation primitive:

- `hive_secretary_jobs`
- `server/hive-secretary-worker.js`
- `prompts/hive/hive_secretary_v1.md`

### `research`

Conduct web search or other research for the board.

Use when:

- a project depends on external facts;
- the manager cannot decide project status from internal state;
- the next useful Network Task should gather information.

Research outputs should become Board Manager context or project product document inputs. Research should not directly mutate tasks or rewards.

### `message_user`

Respond to or speak with a specific user who initiated Hive conversation and ask for follow-up information.

Use when:

- a user submitted a Hive chat entry but the project or action is unclear;
- the missing information is best resolved by the user;
- the user is already involved in that conversation or project.

Messages should be short and specific. They should ask for the minimum information required to advance the project.

Current implementation resolves the target from the Hive Context input repository:

- `target_type = hive_context_entry` uses that exact `hive_context_entries.id`.
- The entry supplies `account_id`, display name, and `source_conversation_id`.
- The action hook appends the response as an assistant message in that account-owned chat conversation.
- The response is tagged with chat metadata `kind = hive_manager_response`.
- `board_manager_user_messages` remains the delivery audit table; it is not the primary user-facing response surface.

The Hive Mind Agent tab shows that the action happened. The user sees the actual response in the default Hive chat.

Repair path:

- `npm run board-manager-message-repair` lists older `message_user` audit rows that have no delivered `chat_messages` row.
- `npm run board-manager-message-repair -- --apply` appends those responses into the latest source Hive chat conversation for the same account before the message was created, then writes `metadata_json.chat_message_id` and `metadata_json.conversation_id` back to `board_manager_user_messages`.
- Internal smoke/test runs are excluded from repair by default.

### `create_project`

Create a durable network project.

Use when:

- the network has a real workstream, product, protocol capability, or operating priority;
- the project can be named without making "scoping" the project itself;
- the project has a plausible type from the five Hive project types.

Do not create fake cards to make the Hive page look populated. If the next step is unclear, create information-gathering tasks under the durable project or ask follow-up questions.

### `update_project`

Update a project's summary, status, phase, priority, target task count, target contributors, or route budget.

Use when:

- Hive Secretary or project evidence changes the status;
- a project becomes blocked;
- a project moves from scoping to execution;
- a project should be paused or archived.

### `archive_project`

Remove a project from the active Hive board without destroying its audit trail.

Use when:

- the project was generated incorrectly;
- the project is no longer supported by the Board Manager context;
- the project is a duplicate of a stronger durable project;
- the project is really a phase such as scoping rather than a project.

This action should set `network_projects.status = archived`. It should not hard delete a project in v1.

Operator-archived projects are locked. Board Manager archived projects are not operator-locked by default. If a project row carries explicit operator lock metadata, the active-project helper must keep it archived and skip reactivation unless a future explicit operator action removes that lock. If a project only carries Board Manager `agent_archived` metadata, the planner may resurrect it when live task movement, pending generation, contributor assignment, or current source context supports the same durable project id.

### `refresh_project_document`

Generate or refresh the expandable product document for one project.

The product document should answer:

- how the project realistically benefits the network;
- what success looks like;
- current status;
- who is working on it and why;
- what is blocked or unclear.

This action owns the agent-managed Project Status blob shown inside a Hive project About section. The static project description stays in `network_projects.about`; the changing execution briefing belongs in a versioned product document row so the agent can update status without overwriting project identity. The UI renders this document collapsed by default, with the summary visible and the detailed status, key points, blockers, next actions, and model metadata behind an expand control.

This is a single-agent path for core Hive work. The Board Manager decision model writes the project document inside `payload.project_document` when it chooses `refresh_project_document`. The action hook validates and persists that document. It does not call a second writer model after the Board Manager chooses the action.

Current implementation:

- Action hook: `server/board-manager-actions.js::executeRefreshProjectDocument`
- Source packet and persistence: `server/repositories/hive-project-product-docs.js`
- Decision prompt: `prompts/hive/board_manager_v1.md`
- Decision schema: `schemas/board-manager-action.schema.json`
- Table: `network_project_product_docs`
- UI projection: `GET /api/hive/projects` returns `project.productDocument`, and the Hive project detail About section renders it as `Project Status`.

This action does not create tasks. It creates an operator-readable briefing that later task generation can use as input.

Historical implementation plan: `docs/wiki/plans/agent-managed-about-panels.md`. Current product-document behavior lives in `Surfaces -> Hive`.

### `assign_contributor`

Assign a contributor to a project.

Use when:

- the contributor has an active Network Diagnostic Report;
- the contributor is available for network tasks;
- the project needs match the contributor's capability;
- the assignment can be explained in plain English.

This action should update the project contributor read model. It does not by itself publish a PFTL task.

### `remove_contributor`

Remove or pause a contributor from a project.

Use when:

- the contributor opted out;
- the contributor is overloaded;
- refusal/reward history makes fit poor;
- the project no longer needs that role.

### `initiate_network_task`

Initiate project-linked task generation for a specific user or candidate set.

This is a routing action, not task authorship. The Board Manager decides that the network should push work to a user, but the concrete task is generated by the Network Task generation worker using the same standards as personal task generation.

Use when:

- the project need is concrete;
- the evidence surface is supported by the app;
- reward is within policy;
- the cadence policy allows another network push;
- the selected user has a wallet and can receive PFT;
- the route can be explained by the Network Diagnostic Report.

Task classes:

- `network`: protocol, product, validation, application, and marketing work that advances a Hive project.
- `alpha`: market, trading, alternative-data, and capital-opportunity work that advances an Alpha Generation project.

Default reward policy:

- reward bands are variable and should default to `10,000` to `50,000` PFT per task;
- the exact offer is chosen by the generation worker from project importance, urgency, difficulty, evidence burden, and expected network value;
- the Board Manager may suggest a reward band but should not hard-code the exact task payload.

Current implementation:

- Action hook: `server/board-manager-actions.js::executeInitiateNetworkTask`
- Allocation and job repository: `server/repositories/network-tasks.js`
- Worker: `server/network-task-generation-worker.js`
- Tables: `network_task_allocations`, `network_task_generation_jobs`
- Task engine handoff: `task_requests` and `server/task-generation-worker.js`
- Prompt input: `prompts/task_engine/taskgen_minimal_v1.md` receives a `network_task` block.

This action creates a durable allocation/generation job and publishes a PFTL task offer only through the normal task engine when the gated worker is enabled. It does not create a separate task lifecycle. The user sees the result as a network-pushed task inside the Tasks UX, with Accept and Refuse actions backed by the standard PFTL task update path.

Local Docker status: enabled. `docker-compose.dev.yml` starts `TASKNODE_NETWORK_TASK_GENERATION_WORKER_ENABLED=true` with a 5 second interval and batch size 1. A May 23, 2026 local Docker run created task `task_01af1624fcb74e41d902ca32b126f27d` for project `task_node` through the standard `task_requests` and `pf.task.offer.v1` path, then completed through reward. The project-linked rows were reconciled from `task_projections`: task ref `rewarded`, allocation `completed`.

That same run now populates the Hive project board from live read models: the project task row shows `rewarded`, the routing feed shows the rewarded transition and 10,000 PFT, the allotted operator row shows the assignee wallet, and the assignee badge uses the wallet's profile NFT image when available.

### `review_evidence_packet`

Review pending task evidence or verification evidence.

Use when:

- a project-linked task has submitted evidence;
- review is pending;
- the reward decision can be made or a follow-up verification request is required.

This action should use the existing task review and reward path. It should not create Hive-specific reward logic.

## Deprecated Planning Model

The old planning model was:

1. A Hive chat entry queues Hive Secretary.
2. Hive Secretary queues Hive Active Projects.
3. Active Projects directly mutates `network_projects`.
4. Product docs refresh on their own cadence.

That model is now deprecated as the strategic design. Those workers remain useful implementation primitives, but they should be invoked by the Board Manager policy rather than treated as independent decision makers.

The Board Manager owns the timing and action choice. Hive Secretary, Active Projects, Product Documents, task allocation, and review become tools or action handlers.

## Data Model

Implemented and planned tables:

### `board_manager_leases`

One active lease per manager scope.

Fields:

- `scope`
- `manager_id`
- `owner_instance`
- `status`
- `claimed_at`
- `heartbeat_at`
- `expires_at`
- `metadata_json`

### `board_manager_runs`

Durable run history.

Fields:

- `id`
- `scope`
- `trigger`
- `source_packet_digest`
- `source_packet_json`
- `selected_action`
- `action_payload_json`
- `status`
- `started_at`
- `completed_at`
- `error`

### `board_manager_context_docs` planned

The manager's own context document.

Fields:

- `id`
- `scope`
- `status`
- `body`
- `source_run_id`
- `source_refs_json`
- `created_at`

### `board_manager_action_results`

Audit log for each executed action.

Fields:

- `id`
- `run_id`
- `action`
- `target_type`
- `target_id`
- `result_json`
- `created_at`

### `board_manager_user_messages`

Delivery audit for Board Manager responses to users.

Fields:

- `id`
- `run_id`
- `account_id`
- `display_name`
- `message_text`
- `source_packet_digest`
- `metadata_json.conversation_id`
- `metadata_json.hive_context_entry_id`
- `metadata_json.chat_message_id`

The actual visible response lives in `chat_messages`, not in this table.

### `network_task_allocations`

Project-linked allocation state for system-pushed Network Tasks and Alpha Tasks.

Fields:

- `id`
- `project_id`
- `task_class`
- `allocation_status`
- `task_request_id`
- `generated_task_id`
- `candidate_account_id`
- `candidate_wallet_address`
- `candidate_profile_id`
- `candidate_profile_digest`
- `allocation_reason_summary`
- `project_need_summary`
- `reward_min_pft`
- `reward_max_pft`
- `cadence_policy_json`
- `metadata_json`
- `expires_at`

### `network_task_generation_jobs`

Durable async job that turns a Board Manager allocation into a normal task-generation request.

Fields:

- `id`
- `allocation_id`
- `project_id`
- `task_class`
- `candidate_account_id`
- `candidate_wallet_address`
- `reward_min_pft`
- `reward_max_pft`
- `status`
- `trigger`
- `board_manager_run_id`
- `request_id`
- `source_payload_digest`
- `source_payload_json`
- `source_payload_text`
- `provider`
- `model`
- `prompt_version`
- `request_bundle_cid`
- `generated_task_payload`
- `task_id`
- `offer_cid`
- `offer_tx_hash`
- `attempt_count`
- `next_attempt_at`
- `locked_at`
- `last_error`

## Prompt And Skill Boundary

The Board Manager needs an operating prompt or skill-like instruction set that lists the action registry, source packet shape, and constraints.

This should live in the repository, not only in an external Codex profile.

Implemented files:

- `prompts/hive/board_manager_v1.md`: model-facing Board Manager operating prompt.
- `docs/wiki/architecture/board-manager.md`: current human-readable architecture and operator runbook.
- `docs/wiki/plans/board-manager.md`: retained historical product and architecture plan.
- Repo-specific runtime instructions remain outside this user-facing Help surface.

The prompt should never contain one-off examples as rules. Concrete examples are test evidence. The action registry and code validation are the product boundary.

## Safety Rules

- One global Board Manager may hold the lease at a time in v1.
- The model can choose an action, but code must validate that the action is allowed.
- Project creation must use durable project names, not "scoping" cards.
- Reward assignment must pass deterministic reward caps and funding policy.
- Task assignment must use the normal PFTL task lifecycle.
- Task status must come from `task_projections`, not from a Board Manager action result.
- Evidence review must use the existing task review/reward engine.
- Web research should update context or product docs before it changes projects or tasks.
- User follow-up messages must be specific, minimal, and tied to a Hive chat entry or project.
- Every mutation needs a durable run id and action result id.

## Milestones

### Phase 1: Plan And Prompt

- Add this Board Manager plan to Help.
- Add `prompts/hive/board_manager_v1.md`.
- Define the action registry and source packet shape.
- Update Hive docs so direct worker cadence is deprecated.

Done when the Help docs describe Board Manager as the owner of Hive management.

### Phase 2: Lease And Run Log

- Add `board_manager_leases`.
- Add `board_manager_runs`.
- Add `board_manager_action_results`.
- Implement a dry-run CLI that claims the lease, builds the source packet, selects `do_nothing`, and records the run.

Done when only one manager can run for `global_hive` at a time.

### Phase 3: Context And Secretary Actions

- Implement `update_board_context`.
- Implement `refresh_hive_secretary`. Done.
- Keep current Hive Secretary worker as the action handler. Done for refresh.

Done when a Board Manager run can decide that a Secretary refresh is needed and execute it. Secretary refresh action dispatch is implemented; Board Manager context document updates remain open.

### Phase 4: Project And Product Doc Actions

- Implement `create_project`, `update_project`, `archive_project`, and `refresh_project_document`. Create, archive, and product-document refresh are implemented; update remains open.
- Add project id visibility and expandable product docs in Hive UI. Product documents render as Project Status inside About; explicit project id visibility remains open.

Done when the Board Manager can create a durable project and attach a readable product document.

### Phase 5: Allocation And Review Actions

- Implement contributor assignment. Done for direct project contributor assignment.
- Implement project-linked Network Task initiation. Done for allocation/job queue creation, task-engine handoff, local Docker PFTL offer publication, and projection sync through reward.
- Implement evidence review through the existing task engine.

Done when the Board Manager can move from network context to project to task to review without creating a second task lifecycle.

## Reviewer To Do List

Review implementation against this document (board manager). Mark each item when verified.

### Memory Efficiency
- [ ] Plan phases avoid loading unbounded history or corpus into single jobs.
- [ ] Derived read models prefer projections over duplicate materialized stores.
- [ ] Single global lease prevents parallel decision-worker runs across Fly instances.
- [ ] Compact micro summaries and network task profiles avoid re-sending full history each tick.

### Code Quality
- [ ] Done criteria map to testable checks or smoke commands.
- [ ] Status (implemented vs planned) accurate on every section.
- [ ] Action hooks map 1:1 to `board-manager-actions.js` executors.

### Coherence
- [ ] Plan does not contradict shipped behavior in Surfaces/Architecture docs.
- [ ] Dependencies on other plans explicitly named and still valid.
- [ ] Implemented vs Phase 5 future actions labeled accurately.

### Bloat
- [ ] Plan scoped to stated phase; future work not implied as shipped.
- [ ] Avoid duplicating full surface doc content; link instead.
- [ ] Micro-summaries replace full prior decision reinjection.

### Security
- [ ] New tables/routes in plan include account ownership and encryption notes.
- [ ] Operator-only actions identified with audit requirements.
- [ ] `message_user` audited; Hive chat source entry stored for routing.
- [ ] Dry-run mode cannot mutate production project state unintentionally.
