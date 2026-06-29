# Board Manager Planning Loop Report Spec

Generated: 2026-06-28

## Goal

Add a global Board Manager Planning Report that reads the Hive Intelligence
Report, live board state, live task feeds, Board Secretary memos, recent
rewards, board comments, and Project Leader context, then writes a tight
portfolio-level board plan every 3 hours.

This report is not the per-board GLM Secretary memo and it is not the retired
legacy Board Manager action loop. It is the strategic planning layer that ranks
boards by whether they are worth continuing, adding, or archiving in service of
PFT network value.

The report must answer:

- which boards have clear desired outcomes and end-state progression;
- which boards have believable KPIs and budgets;
- which boards can be sequenced with current operator resources;
- which boards have high upside relative to downside;
- which board-level actions should be considered now.

The final action set is limited to:

- `ADD_BOARD`
- `ARCHIVE_BOARD`
- `UNARCHIVE_BOARD`

The report may also explain why existing boards should stay active, but "keep"
is not an executable action. Archiving is a high-intensity action and must be
recommended on a risk-averse basis only.
Unarchiving is the reversal path when a current workstream is better served by
restoring a relevant archived board than adding a duplicate board.

## Current System Findings

### Live production posture

Current production flags in `fly.toml` keep mutating board managers disabled:

```txt
TASKNODE_HIVE_DECISION_AGENT_ENABLED=false
TASKNODE_HIVE_DECISION_AGENT_ACTIVE=false
TASKNODE_BOARD_MANAGER_ENABLED=false
TASKNODE_BOARD_MANAGER_EXECUTION_ENABLED=false
TASKNODE_LEGACY_BOARD_MANAGER_ENABLED=false
```

`npm run start:board-manager` currently points at
`scripts/board-manager-disabled.mjs`, which logs that the legacy Board Manager
and Hive Decision Agent action loops are retired. This means the new report can
be added safely as advisory/reporting infrastructure first.

The current per-board secretary remains live:

```txt
TASKNODE_HIVE_BOARD_SECRETARY_ENABLED=true
TASKNODE_HIVE_BOARD_SECRETARY_MODEL=z-ai/glm-5.2
TASKNODE_HIVE_BOARD_SECRETARY_CADENCE_SECONDS=900
```

That worker writes Project Status memos every 15 minutes and must continue to
run.

### Existing decision surfaces

There are two historical board decision systems:

- Legacy Board Manager:
  - prompt: `prompts/hive/board_manager_v1.md`
  - source/action repository: `server/repositories/board-manager.js`
  - scripts: `scripts/board-manager-worker.mjs`,
    `scripts/board-manager-loop.mjs`,
    `scripts/board-manager-model-exec.mjs`
  - storage: `board_manager_runs`, `board_manager_jobs`,
    `board_manager_action_results`, `board_manager_followups`
- Hive Decision Agent:
  - prompt: `prompts/hive/hive_decision_agent_v1.md`
  - source repository: `server/repositories/hive-decision-agent.js`
  - worker: `server/hive-decision-agent-worker.js`
  - action adapter: `server/hive-decision-agent-actions.js`
  - storage: `hive_decision_runs`

The Hive Decision Agent source packet already has useful ingredients:

- current Hive reports;
- live outstanding Network Tasks;
- recent terminal Network Tasks;
- pending Network Task generation jobs;
- dynamic projects;
- recent board discussions;
- badge/capacity candidates;
- dedup guardrails.

But the output is one strict JSON action. That is the wrong shape for the new
request. The new Board Manager Planning Report should be a Markdown report in
`hive_reports`, not a one-action mutation run.

### Existing report surfaces

Before this plan, `server/repositories/hive-reports.js` defined seven report
types:

- `hive_intelligence`, every 6 hours;
- `rewarded_task`, every 20 minutes;
- `operative`, every 24 hours;
- `kol`, daily;
- `development`, every 24 hours;
- `qa`, every 24 hours;
- `executive`, every 24 hours.

The right integration path is to add an eighth report type:

```txt
board_manager_planning
```

Cadence:

```txt
3 hours
```

Default model path:

```txt
provider: OpenRouter
model: z-ai/glm-5.2
reasoning effort: high
default visible output budget: 14,000 tokens
```

Use the existing Hive Reports storage, API, and Reports & generations UI rather
than adding another action-run table.

### Hive board rendering and archived boards

The main Hive board reads `GET /api/hive/projects` every 10 seconds while the
route is mounted. The server route is cached for a short TTL and returns an
active board document with a cheap per-viewer `nextTask` overlay.

`getHiveProjectsDocument()` loads active, paused, and some archived rows from
`network_projects`, but the rendered document filters down to active visible
projects. The frontend renders active project cards only, and project detail
task/activity lists are paginated.

Archived boards should not be added to the main active board payload. That
would make the already expensive Hive board heavier and would risk making
archived rows feel active. Use a separate compact archived-board index endpoint
or collapsed fetch path.

## Planning Loop

The Board Manager prompt should follow a tight planning loop:

1. State the objective: increase Post Fiat/PFT network value through useful
   public boards.
2. Inventory the current boards, resources, budgets, outstanding tasks, recent
   rewards, secretary summaries, board comments, and Project Leader context.
3. Score every active board against the board-quality rubric.
4. Check sequencing: what can actually be done with current operators,
   eligibility badges, capacity, task state, and product risk.
5. Identify board actions:
   - add a new board only when no current or archived board already covers the
     workstream;
   - archive a board only when the archive case clears risk-averse guards.
6. Run a short pre-mortem on each recommended action.
7. Output the final action set and reasoning in plain English.

## Board Quality Rules

Good boards:

- are time-boxed;
- are KPI driven;
- have a budget or reward envelope;
- are continuous enough that operators understand what the board is trying to
  accomplish;
- have an explicit desired outcome;
- have a clear end state in mind at launch;
- move methodically from current state to that end state;
- can be explained to members in simple terms;
- account for limited operator resources;
- connect to an obvious economic lever for PFT.

Bad boards:

- over-scope operators;
- pay PFT for work that does not plausibly increase PFT value;
- do things that do not matter;
- lack a clear end state;
- lack a believable KPI;
- lack a budget or reward envelope;
- create public-facing confusion;
- route attention work before the product/protocol is ready for attention;
- duplicate an existing active or archived board.

Economic levers include:

- increasing useful attention around the network;
- increasing adoption of Task Node or other network products;
- improving deployment of the network treasury;
- improving member quality of life;
- increasing installs and active operatives;
- improving protocol reliability, reward trust, or cashflow.

The report should explicitly say when PFT rewards are being spent on work that
is unlikely to increase PFT value.

## Scoring Rubric

Each active board receives a concise scorecard:

```txt
Board: <project title> (<project id>)
Decision posture: keep / add-adjacent-board-not-needed / archive-candidate
Outcome clarity: High / Moderate / Low
KPI believability: High / Moderate / Low
Budget effectiveness: High / Moderate / Low
Upside vs downside: High / Moderate / Low
Sequencing feasibility: High / Moderate / Low
Overall rank: 1..N
```

Ranking criteria:

- A. clear desired outcome and end-state progression;
- B. believable measured KPI;
- C. definable budget likely to be spent effectively;
- D. high upside relative to downside;
- E. feasible sequencing with current resources.

## Source Packet

Packet schema:

```txt
pf.task_node.board_manager_planning_report_source_packet.v1
```

The packet is assembled deterministically. The model should not assemble its own
data by calling tools.

### A. Latest Hive Intelligence Report

Include the latest `hive_intelligence` report body and metadata. This is the
strategic upstream brief and should be treated as the primary "what matters"
input.

Caps:

- body: 24,000 characters;
- metadata: compact counts only;
- include generated timestamp and report id for audit, but do not expose
  debugging metadata in the final user-facing body.

### B. All Board States

Include all active boards from `network_projects` and the active Hive project
document.

For each active board include:

- project id;
- title;
- type;
- priority;
- status;
- phase;
- about/objective/summary;
- current Secretary memo;
- task row counts;
- in-flight task count;
- terminal/rewarded task count;
- contributors;
- PFT routed;
- pending generation count;
- recent board comments;
- relevant Project Leader context;
- current outstanding tasks;
- recent rewarded tasks.

Empty active boards must be included even if the main Hive UX hides them. The
Board Manager cannot judge whether to move or archive a board it cannot see.

The packet must also include `activeBoardAuthority.activeBoardIds`, derived only
from `boardStates.boards`. Current Board Portfolio and Board Ranking must use
that authority list; archived board indexes, live task feeds, routing
constraints, and Hive Intelligence prose can flag inconsistencies but cannot
create active-board rows.

### C. Live Tasks Feed

Always include live task state, not just cached reports:

- all outstanding Network Tasks: `proposed`, `accepted`, `submitted`,
  `verification_requested`, `verification_response_submitted`,
  `reward_decided`;
- pending Network Task generation jobs;
- recent rewarded/paid Network Tasks;
- recent stopped tasks when they affect board health.

Outstanding tasks should include enough data to understand who is blocked and
what action is next:

- task id;
- project id;
- title;
- status;
- assignee account/handle/wallet when public;
- required badge and operating badge when known;
- reward offer;
- accept-by/deadline when present;
- updated timestamp;
- short proposal or project-need summary.

Rewarded tasks should be compact:

- task id;
- title;
- proposal summary;
- contributor;
- reward amount;
- reward timestamp;
- reward tx/CID when present;
- short reward/reviewer commentary.

Do not include full evidence blobs, uploaded files, raw private evidence, or
full verification packet text for rewarded tasks.

### D. Board Secretary Memos

Include the current `hive_board_secretary_memos` row for every active board.
The Board Manager should use these as board-local status intelligence, not as
commands.

### E. Board Comments

Include project comments from `hive_context_entries` where
`metadata_json.kind = hive_project_comment` or the equivalent stored
`metadata.projectComment.projectId` is present.

Caps:

- latest 30 comments per board;
- 1,000 characters per comment;
- newest first.

### F. Project Leader Hive Context

Include recent Project Leader messages relevant to each board. Match by project
id, project title, task ids, board-comment metadata, or explicit references.

Caps:

- latest 50 relevant Project Leader messages per board;
- 1,200 characters per message.

### G. Contributor And Resource State

Include current verified badge and capacity facts:

- eligible operators grouped by badge;
- current Network Task capacity blockers;
- public profile description card fields from the Live Task Packet;
- last five rewarded Network Tasks per contributor when available;
- current outstanding Network Task counts;
- task routing constraints from the Hive Intelligence source-packet logic.

The report must not infer task eligibility from profile text, prior rewards,
point-person status, or general skill. Badge and capacity facts are the routing
source of truth.

### H. Archived Board Index

Include a compact archived-board index for dedup/restoration context:

- project id;
- title;
- type;
- archived timestamp/reason when present;
- operator archive lock flag;
- task count;
- PFT routed;
- last activity/reward timestamp.

Do not include full archived board details in the default packet.

## Prompt Rules

Prompt text must live in `prompts/hive/reports/`, not in provider or UI source.
The Board Manager Planning report prompt is:

- `prompts/hive/reports/hive_report_writer_system_v1.md`
- `prompts/hive/reports/hive_report_common_v1.md`
- `prompts/hive/reports/board_manager_planning_v1.md`
- `prompts/hive/reports/phase_initial_v1.md`
- `prompts/hive/reports/phase_final_v1.md`
- `prompts/hive/reports/user_message_v1.md`

## User-Facing Report Template

The user-facing report structure is defined by
`prompts/hive/reports/board_manager_planning_v1.md`. Do not duplicate the live
prompt template in this spec.

## Archive Guardrails

The report may recommend `ARCHIVE_BOARD` only when all required checks are true:

- no outstanding Network Tasks on the board;
- no pending Network Task generation jobs;
- no submitted or verification-stage work;
- no meaningful reward, task movement, or board comment in the recent window
  unless that movement supports closure;
- no operator pin or operator archive lock conflict;
- no current Secretary memo showing a concrete next tactic that is still
  relevant;
- no active Project Leader context asking the board to continue;
- the board is duplicate, obsolete, economically weak, or impossible to operate
  with available resources.

Recommended default recent window:

```txt
7 days for rewards/task movement
72 hours for board comments and Project Leader context
```

The action adapter, if built later, must re-check these guards at execution
time. The report alone must not mutate project state.

## Add Board Guardrails

The report may recommend `ADD_BOARD` only when:

- the proposed workstream is not already covered by an active board;
- no matching archived board should be restored instead;
- the desired outcome is explicit;
- the board has a time box;
- the KPI is measurable;
- the budget or reward envelope is defined;
- the first 2-3 tactics can be sequenced with current operators;
- the upside to PFT value is clear enough to justify public board attention.

## Unarchive Board Guardrails

The report may recommend `UNARCHIVE_BOARD` only when:

- an archived board directly matches a current strategic workstream;
- restoring that board avoids a duplicate `ADD_BOARD` recommendation;
- the archived board has no operator archive lock;
- current evidence shows renewed demand, such as live tasks, recent comments,
  Project Leader context, or Hive Intelligence findings;
- the revived board has a clear PFT value lever, KPI, budget envelope, and first
  2-3 tactics.

If an archived board has `operatorArchiveLock=true`, the report must not
recommend unarchiving it unless the source packet contains explicit
founder/operator unlock context.

## Archived Board UX

Do not render archived boards inside the main active board grid.

Recommended UX:

- Keep the main Hive board focused on active projects.
- Add a compact bottom link or collapsed control: `See archived boards`.
- Fetch archived boards separately with pagination.
- Show compact archived rows first.
- Fetch full archived board detail only when a row is expanded.

Recommended API shape:

```txt
GET /api/hive/projects/archived?limit=20&cursor=<cursor>
GET /api/hive/projects/archived/:projectId
```

The compact list should include:

- project id;
- title;
- type;
- archived reason;
- archived timestamp;
- task count;
- PFT routed;
- last activity timestamp;
- restore eligibility indicator.

Do not include full task evidence, full memo history, or full activity rows in
the archived list response.

## Surfaces To Cut Or Deprecate

### Legacy Board Manager mutation loop

Keep disabled by default:

- `scripts/board-manager-worker.mjs`
- `scripts/board-manager-loop.mjs`
- `scripts/board-manager-model-exec.mjs`
- `prompts/hive/board_manager_v1.md`
- `server/repositories/board-manager.js` mutation paths

These remain audit/repair references, not the new planning report runtime.

### Hive Decision Agent direct mutation loop

Keep disabled while the planning report is introduced:

- `server/hive-decision-agent-worker.js`
- `server/hive-decision-agent-actions.js`
- `prompts/hive/hive_decision_agent_v1.md`

If this lane is reused later, it should become a guarded executor that consumes
the latest Board Manager Planning Report action candidates. It should not
independently decide board portfolio actions from the old "latest six reports"
prompt.

### Old GPT 5.5 Pro board jobs

Do not re-enable GPT 5.5 Pro board/project jobs for this lane. The planning
report should use the Hive Reports provider path with GLM 5.2. Existing
historical rows stay available for audit only.

### Stale docs and UI labels

Update or mark stale during implementation:

- `docs/wiki/architecture/board-manager.md`, which still describes an active
  Fly `board-manager` process even though production points it at the disabled
  script;
- `docs/wiki/surfaces/hive.md`, to list the new eighth report and clarify the
  difference between Secretary memos, Hive Intelligence, Board Manager Planning
  Report, and any future executor;
- `src/features/hive/HiveBrainView.jsx`, to show the report in Reports &
  generations and avoid framing it as an immediate mutation agent;
- `prompts/hive/hive_decision_agent_v1.md`, if kept, to stop saying it reads
  only the latest six reports.

## Implementation Plan

### Phase 1: report-only

Add:

- `board_manager_planning` to `hiveReportTypes`;
- `buildBoardManagerPlanningReportSourcePacket()`;
- report prompt files in `prompts/hive/reports/`;
- mock report output for smokes;
- Hive Brain report tab/card;
- docs updates.

No board mutations. No archived-board UX yet except documentation.

### Phase 2: source packet hardening

Add focused tests that prove:

- latest Hive Intelligence report is included;
- live outstanding tasks are always included;
- Board Secretary memos are included;
- recent rewarded tasks are compacted;
- board comments and Project Leader context are included;
- archived board index is compact and bounded;
- badge/capacity routing constraints are present.

### Phase 3: archived board browsing

Add separate archived board endpoints and a collapsed Hive UX entry. Keep the
main active board payload unchanged.

### Phase 4: guarded action adapter

Only after report quality is proven, add an executor that reads the latest
Board Manager Planning Report and can convert `ADD_BOARD`, `ARCHIVE_BOARD`, or
`UNARCHIVE_BOARD` candidates into guarded actions.

The adapter must:

- re-read live board state;
- re-check all add/archive/unarchive guardrails;
- respect operator archive locks;
- require a confidence/evidence threshold;
- record an auditable result row;
- fail closed on ambiguous recommendations.

Do not enable automatic execution until a separate operator decision.

## Verification Plan

Docs-only verification for this spec:

```txt
npm run format-check
git diff --check
```

Implementation verification later:

- report source-packet smoke;
- Hive report worker mock smoke for `board_manager_planning`;
- report markdown renderer smoke;
- archive guardrail fixture;
- add-board dedup fixture;
- Hive Brain UI build/lint;
- production forced generation of one Board Manager Planning Report;
- production check that legacy Board Manager and Hive Decision Agent action
  flags remain disabled.

## Non-Goals

- Do not re-enable legacy Board Manager execution.
- Do not re-enable Hive Decision Agent active mode.
- Do not replace the 15-minute per-board GLM Secretary.
- Do not auto-archive boards from the report worker.
- Do not render archived boards inline with active boards.
- Do not add raw source JSON or provider metadata to user-facing report bodies.
- Do not let profile prose override badge/capacity routing constraints.
