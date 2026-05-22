# Board Manager

Status: v0 persistent Codex Exec agent implemented with first action hooks

This plan supersedes the earlier idea that Hive should be driven by a set of independent cron-style workers. Hive should be managed by a single Board Manager execution loop that decides when to update context, research, create projects, archive projects, refresh project documents, route tasks, or do nothing.

## Product Role

The Board Manager manages the Hive page and Hive interactions across the Post Fiat Task Node app.

It is a Codex Exec function with a bounded action registry. It is not a chat bot, not a public user, and not a frontend component. It is the system operator for the network board.

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
- `board_manager_sessions` stores the persistent Codex session id for each scope.
- Each tick resumes that session with `codex exec resume <session_id>` unless an operator explicitly starts a fresh session.
- The first scope is `global_hive`.
- Later scopes can be project-specific, for example `project:pft_distribution_v3`, if the network becomes too large for one global manager.

The default v1 posture is conservative. Most ticks should do nothing unless there is stale state, new validated input, a blocked project, pending evidence, or a clear task allocation opportunity.

## V0 Codex Exec Harness

Implemented v0 pieces:

- `server/repositories/board-manager.js` builds the current Hive source packet and validates the returned action.
- `server/repositories/board-manager.js` formats a Hive Mind Agent feed from `board_manager_runs` and `board_manager_action_results`.
- `schemas/board-manager-action.schema.json` constrains the Codex Exec output, including action-specific `project`, `contributor`, `message_text`, and `archive_reason` payload fields.
- `scripts/board-manager-codex-exec.mjs` runs Codex Exec with `gpt-5.5` and `model_reasoning_effort = xhigh`, creating or resuming the persistent session for the Board Manager scope.
- `server/board-manager-actions.js` executes the first supported actions.
- `server/db/migrations/033_board_manager_v0.sql` adds lease, run, and action-result tables.
- `server/db/migrations/034_lock_operator_archived_hive_projects.sql` locks operator-archived Hive projects so the project planner cannot silently reactivate rejected cards.
- `server/db/migrations/035_board_manager_action_hooks.sql` adds user-visible Board Manager messages.
- `server/db/migrations/036_board_manager_persistent_sessions.sql` adds persistent Codex session tracking.
- `npm run board-manager:codex -- --trigger <name>` runs one dry-run Board Manager decision.
- `npm run board-manager:codex -- --trigger <name> --execute` runs one Board Manager decision and executes supported action hooks.
- `npm run board-manager:codex -- --trigger <name> --fresh-session` starts a new persistent Codex session for the scope.
- `npm run board-manager:codex -- --packet-only` prints the source packet without calling Codex.

The default remains dry-run for app mutations. It is not ephemeral. The Codex conversation persists, and execution of app hooks still requires the explicit `--execute` flag.

Implemented action hooks:

- `do_nothing`: records an action result with no mutation.
- `message_user`: writes an assistant response into the user's original Hive Input chat conversation and records a delivery audit row in `board_manager_user_messages`.
- `refresh_hive_secretary`: queues a Hive Secretary job from the current validated Hive Context packet.
- `create_project`: creates or updates an active `network_projects` row from `payload.project`.
- `archive_project`: archives the project and applies an operator archive lock. This is the delete-project hook; hard delete is intentionally not available.
- `assign_contributor`: upserts a project contributor row using the project id and wallet address in `payload.contributor`.

Hive page visibility:

- The collapsed `Hive Context` section contains a `Hive Mind Agent` tab.
- The tab shows recent Board Manager runs as a feed, including `do_nothing` and runs with no recorded selected action.
- Internal smoke/test runs remain queryable for verification but are filtered out of the normal Hive Mind Agent feed.

Not yet implemented action hooks:

- `update_board_context`
- `research`
- `update_project`
- `refresh_project_document`
- `remove_contributor`
- `initiate_network_task`
- `review_evidence_packet`

## Trigger Policy

The Board Manager should be triggered by logical timing and state changes, not by every frontend page view.

Initial triggers:

- periodic tick, likely every 15 to 60 minutes;
- new validated-wallet Hive Input;
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
- pending evidence packets;
- Network Diagnostic Reports for eligible users;
- user availability and network-task settings;
- recent Board Manager runs and actions;
- reward budget and rate-limit policy;
- allowed action registry.

The packet should avoid raw private data unless the action requires it. Public profile summaries and Network Diagnostic Reports are better routing inputs than raw chat memory.

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

- validated Hive Inputs add durable network context;
- the manager needs to preserve a decision, unresolved question, or operating assumption.

Output:

- concise update text;
- source input references;
- reason for the update.

### `refresh_hive_secretary`

Update the Hive Secretary report if it is stale or missing.

Use when:

- new validated Hive Input exists;
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

- a user submitted Hive Input but the project or action is unclear;
- the missing information is best resolved by the user;
- the user is already involved in that conversation or project.

Messages should be short and specific. They should ask for the minimum information required to advance the project.

Current implementation resolves the target from the Hive Context input repository:

- `target_type = hive_context_entry` uses that exact `hive_context_entries.id`.
- The entry supplies `account_id`, display name, and `source_conversation_id`.
- The action hook appends the response as an assistant message in that account-owned chat conversation.
- The response is tagged with chat metadata `kind = hive_manager_response`.
- `board_manager_user_messages` remains the delivery audit table; it is not the primary user-facing response surface.

The Hive Mind Agent tab shows that the action happened. The user sees the actual response in Chat, in the conversation where the Hive Input was submitted.

Repair path:

- `npm run board-manager-message-repair` lists older `message_user` audit rows that have no delivered `chat_messages` row.
- `npm run board-manager-message-repair -- --apply` appends those responses into the latest source Hive Input conversation for the same account before the message was created, then writes `metadata_json.chat_message_id` and `metadata_json.conversation_id` back to `board_manager_user_messages`.
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

Operator-archived projects are locked. If a project row carries an archive marker, the active-project helper must keep it archived and skip reactivation unless a future explicit operator action removes that lock.

### `refresh_project_document`

Generate or refresh the expandable product document for one project.

The product document should answer:

- how the project realistically benefits the network;
- what success looks like;
- current status;
- who is working on it and why;
- what is blocked or unclear.

This action owns the agent-managed Project Status blob shown inside a Hive project About section. The static project description stays in `network_projects.about`; the changing execution briefing belongs in a versioned product document row so the agent can update status without overwriting project identity.

Planned model:

- OpenRouter `deepseek/deepseek-v4-pro`
- ZDR-capable provider
- prompt file `prompts/hive/hive_project_product_doc_v1.md`

Detailed implementation plan: `docs/wiki/plans/agent-managed-about-panels.md`.

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

Create a project-linked Network Task assignment for a specific user or candidate set.

Use when:

- the project need is concrete;
- the evidence surface is supported by the app;
- reward is within policy;
- the selected user has a wallet and can receive PFT;
- the route can be explained by the Network Diagnostic Report.

This action should create a durable allocation and publish a PFTL task offer only through the normal task engine. It should not create a separate task lifecycle.

### `review_evidence_packet`

Review pending task evidence or verification evidence.

Use when:

- a project-linked task has submitted evidence;
- review is pending;
- the reward decision can be made or a follow-up verification request is required.

This action should use the existing task review and reward path. It should not create Hive-specific reward logic.

## Deprecated Planning Model

The old planning model was:

1. Hive Input queues Hive Secretary.
2. Hive Secretary queues Hive Active Projects.
3. Active Projects directly mutates `network_projects`.
4. Product docs refresh on their own cadence.

That model is now deprecated as the strategic design. Those workers remain useful implementation primitives, but they should be invoked by the Board Manager policy rather than treated as independent decision makers.

The Board Manager owns the timing and action choice. Hive Secretary, Active Projects, Product Documents, task allocation, and review become tools or action handlers.

## Data Model

Planned tables:

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

### `board_manager_context_docs`

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

## Prompt And Skill Boundary

The Board Manager needs an operating prompt or skill-like instruction set that lists the action registry, source packet shape, and constraints.

This should live in the repository, not only in an external Codex profile.

Planned files:

- `prompts/hive/board_manager_v1.md`: model-facing Board Manager operating prompt.
- `docs/wiki/plans/board-manager.md`: human-readable product and architecture plan.
- later, if Codex Exec uses local skills directly, a repo-specific skill can mirror the same action registry.

The prompt should never contain one-off examples as rules. Concrete examples are test evidence. The action registry and code validation are the product boundary.

## Safety Rules

- One global Board Manager may hold the lease at a time in v1.
- The model can choose an action, but code must validate that the action is allowed.
- Project creation must use durable project names, not "scoping" cards.
- Reward assignment must pass deterministic reward caps and funding policy.
- Task assignment must use the normal PFTL task lifecycle.
- Evidence review must use the existing task review/reward engine.
- Web research should update context or product docs before it changes projects or tasks.
- User follow-up messages must be specific, minimal, and tied to a Hive Input or project.
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

- Implement `create_project`, `update_project`, `archive_project`, and `refresh_project_document`. Create and archive are implemented; update and product docs remain open.
- Add project id visibility and expandable product docs in Hive UI.

Done when the Board Manager can create a durable project and attach a readable product document.

### Phase 5: Allocation And Review Actions

- Implement contributor assignment. Done for direct project contributor assignment.
- Implement project-linked Network Task initiation.
- Implement evidence review through the existing task engine.

Done when the Board Manager can move from network context to project to task to review without creating a second task lifecycle.
