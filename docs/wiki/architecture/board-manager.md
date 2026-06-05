# Board Manager

The Board Manager is the leased Hive decision worker. It reads the compact Hive
source packet, asks the configured decision model for one action, validates that
action against the registry, and writes durable run/action evidence before any
board mutation is considered complete.

System Status row: `board_manager`

## Runtime Boundary

- Process: Fly `board-manager` process group.
- Entrypoint: `npm run start:board-manager`.
- Primary scripts: `scripts/board-manager-worker.mjs`,
  `scripts/board-manager-model-exec.mjs`, and
  `scripts/board-manager-ops.mjs`.
- Source tables: `board_manager_scopes`, `board_manager_runs`,
  `board_manager_jobs`, `board_manager_leases`, and
  `board_manager_action_results`.
- User-message delivery table: `board_manager_user_messages`.
- Open follow-up table: `board_manager_followups`.
- Network Task intent table: `network_task_intents`.
- Current Hive action results are rendered in the Hive surface as inspectable
  agent activity.

## Status Derivation

Green means the `global_hive` scope is enabled and the latest completed run is
fresh for the configured cadence. A fresh running run is also green.

Amber means failed Board Manager jobs were updated inside the recent failure
window. Historical failed jobs remain in counts for audit but do not keep the
row amber forever.

Red means the scope is missing, paused, disabled, stale beyond cadence, the
latest run failed, or a running run is stale.

## Debug And Repair

Start with the scheduler and Fly process state:

```bash
npm run board-manager:ops -- status
npm run fly:board-guard
fly status -a tasknodeofficial-dev
```

If the scope is paused, resume it deliberately:

```bash
npm run board-manager:ops -- resume --reason "operator recovery"
npm run board-manager:ops -- enqueue --reason "operator recovery run"
```

Inspect `board_manager_jobs.last_error`, `board_manager_runs.error`, provider
secrets, and action-hook errors before retrying. Do not manually mutate Hive
project rows while the Board Manager scope is enabled unless the repair is a
bounded data fix with a recorded reason.

If a user receives repeated Hive messages, inspect recent `message_user` runs,
`board_manager_user_messages`, and `board_manager_followups` first. A delivered
message must create one open follow-up keyed by account and, when known,
project. New Hive input from that account marks open follow-ups answered. The
action hook should skip duplicate responses to the same Hive Context entry and
should skip account/project messages while an open follow-up is waiting for the
user. A repeated-message burst means the follow-up row was missing, expired
incorrectly, or the Board Manager found a materially new blocker.

Task-action Hive messages also require a runtime `message_precondition`.
Any Board Manager `message_user` action that asks a user to accept, decline,
review, verify, unblock, or otherwise act on a Network Task must name the
related task id or allocation id plus the task/allocation statuses that must
still be true at send time. The action hook rebuilds the account live state
immediately before delivery. If the task was refused, rewarded, cancelled,
expired, replaced by another allocation, below the user's recorded reservation
rate, or already has an open follow-up that contradicts the message, the
message is skipped and an audit result records the stale precondition. This is
the guard that prevents "please accept this task" nudges from being delivered
after the user already refused or completed the task.

If the board creates duplicate project cards, inspect the create result. The
`create_project` hook checks active and archived project rows before inserting.
When a matching archived row exists, the correct action is `restore_project`
unless an operator archive lock is present. When a matching active row exists,
the correct action is to refresh the project document, assign a contributor, or
initiate a Network Task under that existing project.

If the board generates repetitive Network Tasks, inspect `network_task_intents`
before the generation jobs. Intent idempotency is semantic: project, candidate,
task class, normalized project need, and reward band. A repeated Board Manager
run should return `network_task_semantic_intent_exists` instead of enqueueing a
second job for the same work.

If the board keeps choosing `do_nothing` while a user appears eligible for
Network Tasks, inspect `boardActionPressure` before trusting a project document
or older follow-up summary. `eligibleCandidateCount > 0` means at least one
candidate is live after outstanding tasks and pending generation jobs are
accounted for. Other users' stale tasks, orphaned allocations, generated-but-
unlinked jobs, and open follow-ups do not globally block that candidate. Recent
refusals are routing feedback, not a current capacity status, unless the live
packet includes an explicit availability constraint. A recent stopped task with
no newer replacement task or generation job should create action pressure even
when the project still has older work open.

Capacity matching is wallet-aware. A Network Task with a concrete candidate
wallet consumes capacity for that wallet, not forever for every future wallet
the same account links. If an account delinks `rOld` and links `rNew`, an active
task on `rOld` remains auditable but must not make `rNew` unavailable for
routing. Pending work without a candidate wallet is the fallback account-level
blocker until the wallet is known.
