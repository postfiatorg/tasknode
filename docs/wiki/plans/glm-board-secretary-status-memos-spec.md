# GLM Board Secretary Status Memos Spec

Generated: 2026-06-28

## Goal

Replace the existing Hive board action manager with a per-board GLM 5.2 secretary that writes clear Project Status memos every 15 minutes. The new system is advisory and status-focused. It does not create tasks, cancel tasks, message users, mutate rewards, mark work resolved, or make custody/accounting decisions.

The memo should make each board easier to operate:

- explain what the project is;
- explain why the project advances PFT token value;
- identify who appears to be running point based on contributions;
- identify what operator types are needed next;
- recommend 2-3 concrete next tactics;
- state the overall board strategy;
- give the task management agent a concise recommendation about what is needed to move objectives forward.

## What Gets Shut Off

### Existing Board Manager action loop

Disable every existing board agent path that can select or execute action registry mutations:

- legacy Board Manager scripts:
  - `scripts/board-manager-worker.mjs`
  - `scripts/board-manager-loop.mjs`
  - `scripts/board-manager-model-exec.mjs`
- current `board-manager` Fly process behavior remains the disabled manual
  compatibility entrypoint (`scripts/board-manager-disabled.mjs`)
- the former Hive Decision Agent executor/provider/worker/action adapter and
  launchers were removed; historical run/read-model data remains read-only

Required production flags:

```txt
TASKNODE_BOARD_MANAGER_ENABLED=false
TASKNODE_BOARD_MANAGER_EXECUTION_ENABLED=false
TASKNODE_LEGACY_BOARD_MANAGER_ENABLED=false
Decision Agent enable/active flags are no longer runtime controls.
```

The implementation should make these paths fail closed by default. If an operator tries to run a legacy Board Manager path without an explicit legacy override, it should exit before a provider call or action execution.

### Existing GPT 5.5 Pro board jobs

Shut off GPT 5.5 Pro in the Hive/board operations lane:

- remove GPT 5.5 Pro as a Board Manager fallback default;
- prevent OpenAI/GPT 5.5 Pro board jobs from being enqueued by old Board Manager scripts;
- mark existing pending/deferred `board_manager_jobs` as `cancelled` with a shutdown reason;
- leave historical `board_manager_runs`, `hive_decision_runs`, action results, and user-message rows read-only for audit.

Scope note: this spec targets Hive board/operator jobs. It does not remove the user-facing chat model picker unless a separate product decision says Frontier chat should also be disabled.

## Replacement System

### New runtime

Add a new worker:

- script: `scripts/hive-board-secretary-worker.mjs`
- server module: `server/hive-board-secretary-worker.js`
- repository module: `server/repositories/hive-board-secretary.js`
- prompt: `prompts/hive/glm_board_secretary_status_memo_v1.md`
- model provider: OpenRouter
- model: `z-ai/glm-5.2`
- cadence: every 15 minutes for every active board/project

Recommended production flags:

```txt
TASKNODE_HIVE_BOARD_SECRETARY_ENABLED=true
TASKNODE_HIVE_BOARD_SECRETARY_PROVIDER=openrouter
TASKNODE_HIVE_BOARD_SECRETARY_MODEL=z-ai/glm-5.2
TASKNODE_HIVE_BOARD_SECRETARY_CADENCE_SECONDS=900
TASKNODE_HIVE_BOARD_SECRETARY_PROJECT_LIMIT=100
TASKNODE_HIVE_BOARD_SECRETARY_CONCURRENCY=1
TASKNODE_HIVE_BOARD_SECRETARY_DB_STATEMENT_TIMEOUT_MS=60000
```

The worker should use a Postgres lease so only one process generates memos for a project at a time.

### Process placement

Preferred deployment shape:

- remove or stop the old `board-manager` process group;
- add a new `board-secretary` process group, or run the worker inside `worker-hive` if Fly process count needs to stay smaller;
- do not reuse the old `board-manager` process name for the new writer unless the UI labels are also changed, because the new service is not a manager and does not execute actions.

## Source Packet

Each GLM secretary run receives one board-scoped packet. The packet is assembled deterministically from database state. The model receives compact facts, not raw evidence dumps.

Packet schema name:

```txt
pf.hive.board_secretary.source.v1
```

### A. Existing task state

Include board/project-linked Network Task state from `network_project_task_refs`, `task_projections`, and generation job rows.

For active or outstanding tasks, include:

- task id;
- request id if present;
- title;
- status: `proposed`, `accepted`, `submitted`, `verification_requested`, `verification_response_submitted`, or `reward_decided`;
- assignee account, handle, and wallet when public;
- required/operating badge when known;
- reward offer;
- updated timestamp;
- project need summary;
- submission requirement summary;
- short task proposal/body excerpt.

For rewarded or paid tasks, include only:

- original proposal summary;
- task id;
- contributor;
- reward amount;
- reward timestamp;
- reward tx hash and CID when present;
- short reward/reviewer comment summary;
- final status.

Do not include full evidence blobs, full verification responses, raw attachments, long private task text, or huge historical reducer payloads for rewarded tasks.

Recommended truncation caps:

- active task proposal/body excerpt: 1,200 chars;
- active submission or verification excerpt: 700 chars;
- rewarded task proposal summary: 700 chars;
- rewarded task reward/comment summary: 500 chars;
- max active tasks per board: 40;
- max recent terminal/rewarded tasks per board: 40;
- always include counts showing how many rows were omitted.

### B and D. Board Comments

Use the board comment stream as the canonical source for both "comment board" and "Board Comments".

Source:

- `hive_context_entries` rows where `metadata_json.kind = hive_project_comment`;
- project id from `metadata_json.projectComment.projectId`;
- current comments already surfaced on Hive project cards.

Include:

- comment id;
- author display name, handle, account id;
- body excerpt;
- created timestamp;
- whether the author has Project Leader, Core Contributor, QA Worker, KOL, or Expert badges.

Recommended caps:

- latest 30 comments per board;
- 1,000 chars per comment;
- comments ordered newest first.

### C. Eligible contributors and public network descriptions

Include contributors who have verified eligibility badges and enough public profile context to be useful for routing discussion.

Sources:

- `account_network_badges`;
- Network Task capacity and eligibility helpers;
- latest completed `profile_public_snapshots`;
- the same public profile description shape used by the Live Task Packet.

Include:

- account id;
- public handle/display name;
- current wallet if public;
- verified badges;
- capacity status and blockers;
- public profile role title;
- 2 sentence profile summary;
- skills;
- best-fit organization/work description;
- current outstanding Network Task count;
- last rewarded Network Task summaries, capped at 5.

Do not include private provider identities, hidden aliases, seeds, local keys, private wallet history, or non-public profile fields.

### E. Hive Context messages from Project Leaders

Include Project Leader context messages relevant to the board.

Sources:

- `hive_context_entries`;
- `account_network_badges` where `badge_id = project_leader` and `status = verified`;
- project matching by project id, project title, task ids, board comment metadata, or explicit project references.

Include:

- entry id;
- author;
- body excerpt;
- created timestamp;
- linked project/task references if found.

Recommended caps:

- latest 50 relevant Project Leader entries per board;
- 1,200 chars per entry;
- include a separate count of omitted Project Leader messages.

## Memo Output

The GLM output should be Markdown, not JSON for the user-facing artifact. The stored row may keep normalized metadata separately for audit, but the displayed memo is a readable Markdown document.

Required memo template:

```md
# Project Status: <board title>

## What This Project Is
- <2-3 sentence explanation>

## Why This Advances PFT Value
- <token-value explanation>

## Current Point People
- <handle/account>: <why this person appears to be running point>

## Operators Needed
- <operator type>: <why needed now>

## Next Tactics
- <tactic 1>
- <tactic 2>
- <tactic 3 if justified>

## Overall Strategy
- <strategy>

## Recommendation For Task Management Agent
- <concise recommendation>
```

Quality rules:

- be bullet pointed and easy to scan;
- cite task ids, comment ids, and contributor handles when possible;
- do not include generated timestamps, model names, source packet digests,
  prompt versions, usage details, or other debugging/audit metadata in the
  user-facing memo body;
- distinguish source-backed facts from missing or conflicting data;
- avoid vague "document the issue" recommendations unless documentation is actually the next value-producing step;
- prefer action, integration, review, routing, testing, or contributor handoff when those are the real next move;
- do not say a task or issue is resolved unless the source state shows a real terminal resolution;
- do not invent contributors, badges, wallets, task ids, project facts, or reward decisions.

## Persistence

Add a new table instead of overloading old Board Manager run tables:

```sql
CREATE TABLE hive_board_secretary_memos (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES network_projects(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'current',
  source_packet_digest text NOT NULL DEFAULT '',
  source_packet_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_counts_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  memo_markdown text NOT NULL DEFAULT '',
  provider text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  prompt_version text NOT NULL DEFAULT '',
  prompt_digest text NOT NULL DEFAULT '',
  usage_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text NOT NULL DEFAULT '',
  generated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz,
  CHECK (status IN ('current', 'superseded', 'failed'))
);
```

Add:

- one current memo per project;
- recent history for audit;
- source digest for exact packet traceability;
- source counts for omitted/truncated rows;
- provider/model/prompt/usage for cost audit.

The old `network_project_product_docs` rows can remain as historical project documents. The Hive board UI should prefer the latest current `hive_board_secretary_memos` row for the Project Status memo once this system is enabled.

## UI Behavior

On each Hive project board:

- show the latest Project Status memo in the existing project status area;
- render Markdown bullets clearly;
- make the memo expandable/collapsible;
- keep generated time, model, source digest, prompt version, and usage as stored
  audit fields, not as visible memo body text;
- keep the original static `About` project text separate from the generated memo;
- show a clear stale state if the latest memo is older than 30 minutes.

The memo should not auto-expand the board comment chat.

## Scheduler Behavior

Every 15 minutes:

1. List all `network_projects` with `status = active`.
2. For each project, build a deterministic source packet.
3. Generate a GLM 5.2 memo.
4. Supersede the old current memo for that project.
5. Insert the new current memo.
6. Record failures per project without blocking other projects.

The worker may process projects sequentially at first. If the board count grows, raise concurrency carefully. The first implementation should prefer reliability and lower provider pressure over speed.

Do not skip a scheduled project forever because its digest is unchanged. It is acceptable to avoid duplicate same-cycle work, but every active project should have a fresh memo at the 15 minute cadence.

## Guardrails

- The new secretary cannot execute `create_task`, `cancel_task`, `cancel_network_task`, `message_user`, `archive_board`, `create_board`, or `refresh_board`.
- The new secretary cannot mutate `task_projections`, PFTL state, rewards, allocations, generation jobs, or user messages.
- The task management agent recommendation is advisory text only.
- Any future task manager must consume the memo as context, not as an executable command.
- If provider output is malformed or empty, store a failed memo row and keep the previous current memo.
- If source data is missing, the memo should say what is missing instead of filling gaps with invented certainty.

## Implementation Steps

1. Add the memo table migration and repository helpers.
2. Add the deterministic board secretary packet builder.
3. Add the GLM 5.2 prompt and provider call wrapper.
4. Add the 15 minute worker with Postgres lease protection.
5. Disable legacy Board Manager and Hive Decision Agent action paths by default.
6. Cancel pending/deferred old `board_manager_jobs` with a shutdown reason.
7. Add Hive board UI rendering for latest memo.
8. Update docs and system status rows.
9. Deploy with the old manager disabled and the new secretary enabled.
10. Verify at least one memo per active board after the first cadence.

## Verification Plan

Required local checks:

- source-packet smoke with fixture task states;
- rewarded-task truncation smoke proving full evidence blobs are not included;
- Project Leader context filter smoke;
- board comments inclusion smoke;
- public profile description inclusion smoke;
- worker dry-run against local or production read replica;
- `npm run format-check`;
- `git diff --check`;
- `npm run lint` if JS is changed.

Required production checks after deploy:

- old Board Manager process/action execution disabled;
- no new GPT 5.5 Pro Hive/board job rows are created;
- GLM 5.2 memo rows exist for every active project;
- each active Hive board displays an expandable Project Status memo;
- one sampled source packet shows rewarded tasks reduced to proposal plus reward summary, not evidence blobs;
- system status shows the board secretary worker as current.
