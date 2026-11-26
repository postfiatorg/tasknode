# Board Management and the Kimi Runtime

Routing diagnostics: scoped board packets expose recent failed generation jobs with their actual failure reasons, plus each idle contributor's selected default badge. A default badge is a preference alongside the contributor's verified badges; it does not grant code access or override work-type eligibility. Scoped user histories explicitly name their board coverage and exclude legacy boards, so they must not be described as a contributor's lifetime history. Assignment-policy validation returns HTTP 422 with actionable details instead of a generic retryable commit error. Failed generation is distinct from failure to commit an allocation.

Production v706 and the scoped Kimi supervisor were deployed September 5, 2026.
Kimi resumed its existing thread on the optimized operator candidate. Production
credential scope, committed commands, polling and production per-duty outcomes
are verified. The September 6 allocation repair removes the fixed board task
ceiling and adds accepted-task follow-up plus scoped evidence reads.

Kimi K3 in the operator-host Corbanu TUI is the production board/task manager.
The obsolete GLM Hive Task Manager and the legacy automatic Board Manager
launchers were removed on September 5, 2026. Their old enable flags cannot
restart them. The experimental project planner and disabled accounting
harvester were also removed.

## Current owners

| Component | Runtime | Role |
| --- | --- | --- |
| Kimi board manager | Operator-host Corbanu TUI; `kimi-code` / `kimi-k3` | Inspect boards, select work, and execute authorized `bm` commands |
| Network/task generation | Fly `worker-taskgen`; DeepSeek V4.1 Flash | Prepare the request and generate the concrete task |
| Task review publication | Fly `worker-task-review` | Consume Kimi decisions and publish verification/reward transitions |
| Hive support | Fly `worker-hive` | Hive context secretary, board secretary memos, reports, and Kimi activity narrator |

## Shared routing contract

Kimi's `scripts/bm.mjs task create` command reaches the shared action/enqueue
code through `scripts/bm/writes.mjs`. That path records network intents,
allocations and generation jobs. Final task wording comes from
`server/task-generation-worker.js`. See [network generation](network-task-generation-worker.md).

## Five boards and the Wanted list (2026-11-25)

The public boards are Layer 1 (`board_postfiat_l1v2`), Task Node
(`board_tasknode_fixes`), Corbanu Terminal (`board_pf_terminal`), Trading
(`board_capital_markets`) and Media (`board_community_promotion`). Board ids
predate the names. AI Layer 1 Governance is closed to new work; it, Value
Accountability and Reinstatement carry `metadata_json.hive_hidden` and are off
the public Hive page while still running.

`server/board-work-policy.js` is the single table for which board pays for
which work type and what proof a payment needs.

Work starts from the Wanted list (`board_wanted_items`, migration 165,
`server/board-wanted.js`): one row per thing Post Fiat needs, with a source
link, optional work type, reward and preferred owner. An item's state is
derived from the tasks created for it (`open`, `in_progress`, `done`,
`rewrite`, `dropped`). `task create` requires `--wanted <id>` for an open item
on the same board, writes the item's reason and source into the task need, and
links the run to the item; one item has one live task. Two refusals since the
last revision put the item in `rewrite`.

Each open item on an open board is a `wanted_open` duty listing contributors
with free slots, the item's preferred owner first. It is answered `completed`
(the item has a live task) or `blocked` with a reason; `deferred` is refused.
A blocked item is not re-asked for 12 hours. Items in `rewrite` produce a
`wanted_rewrite` duty. The former `routing_due` invitation and the daily
`board_info_stale` summary rewrite were removed; the manager may change only a
board's status and phase. Operator and manager add items with `bm wanted add`.

The Hive page shows each board's Wanted list, a "Shipped" feed of rewarded
work only, and no model-written Project Status memo.

The scheduler also emits explicit follow-ups for seven-day unaccepted proposals,
accepted tasks with seven days without recorded activity, and verification
requests unanswered for three days. Under the existing manager policy, accepted
work can be cancelled after fourteen days without submission or contact. These
are Kimi duties, not unconditional time-based deletions. The manager reads task
detail and contact history, dry-runs, and calls `task cancel --stale-only` with a
reason when cancellation is due. Execution rechecks canonical activity, submitted
evidence, current status and reward state. A concurrent activity/state update
prevents the cancellation. Personal, submitted and rewarded tasks are protected.

`task detail <taskId>` exposes requirements, submission and verification payloads,
and bounded event history only for the agent's authorized board. Private chats and
context documents are not included. Review and verification-request writes refuse
missing/unreadable evidence with `board_task_evidence_unavailable`; the agent must
record a blocked duty instead of rejecting the contributor or consuming another
verification round. External artifact access failures are also blocked reviews.

The submission sequence is initial evidence → manager verification request →
contributor verification response → manager review. Out-of-order review and
verification commands return HTTP 409 with the required lifecycle state and, for
a submitted task, the next verification command. These are state conflicts, not
transient server failures: refresh task detail and take the indicated next step
instead of retrying the same command. Rejected commands roll back their receipt
and cannot create a decision or reward.

Repetition of a rejected command is bounded and visible. Each lifecycle rejection
is recorded in `bm_audit_log` as `lifecycle_rejected` after the rollback; the 409
body carries `lifecycle.taskId`, `taskStatus`, `command`, `nextAction` and
`priorRejections`, and the message states how many times the same command was
already refused in that status. The `bm` CLI keeps the rejection with the saved
command key: an identical command is not resent until a fresh `task detail` shows
the status changed, and is refused locally with the original guidance otherwise.

A pending manager decision wakes its publication worker. Recording a
`verification_request` or `review` decision clears the idle matching worker's
`retry_after` in the same transaction, so the next worker tick publishes it. Active
claims and published work are never touched. Worker claim state separates
`wait_count` (successful passes that found no decision yet) from `retry_count`
(failures); a wait resets the failure streak, so one transient error after a long
wait gets the first-failure backoff instead of the fifteen-minute ceiling.

Grounding sources are remote. Each board packet carries `sources`, one entry per
declared repository (`github_repo`, resolved through `DEFAULT_REPO_MAP` or
`TASKNODE_BOARD_SOURCE_REPO_MAP`), official X account (`x_account`, needs
`X_BEARER_TOKEN`) and website. Snapshots are cached in `board_source_snapshots`
(migration 144) for thirty minutes with `fetched_at`; a failed refresh serves the
previous snapshot as `stale` with the error, and a source that never fetched is
`unavailable`. Degraded sources appear in runtime status. `GITHUB_SOURCE_TOKEN`
is optional (private repositories, higher rate limits). Local checkouts on the
operator host are no longer a precondition for any board. Blockers that only the
operator can clear are recorded once with `operator-action <board> --add … --owner …`
and shown in the packet and status until `--resolve <id> --resolution …`.

The intent classifier's prompt states the JSON contract by key name. Provider
output is normalized through documented key aliases before validation; a
contract failure gets exactly one repair turn with the rejection fed back; a
second failure fails the job non-retryably as `network_task_intent_contract_failed`
with both raw outputs persisted under `generationFailure.rawAttempts`. Board
packets label each failed job with `failure_family` (`provider`, `contract`,
`semantic`) and `classifier_output_preview`; provider and contract failures can be
explicitly retried with `--retry-failed`, semantic holds cannot.

Reward projection still updates project totals, allocations and user
followups. It no longer enqueues the retired `board_manager_jobs` scheduler.
Historical runs and accounting records remain available; old queued planner
and scheduler rows are not presented as live workers or Kimi activity.

## Kimi launch and supervision

`ops/bm-runtime/agents.json` owns the Kimi K3 agent and all six board assignments.
The registry validates duplicate assignments and resolves each board's skill.
Launch, supervisor, reset and status publication use that same registry.

- `bm-launch.sh` requires an expiring scoped API credential, installs workspace
  trust, checks every assigned skill, and resumes the saved terminal thread.
  Its child environment has no database URL. A live terminal rotates only at a
  proven idle boundary; pending work survives restart.
- `supervisor.mjs --watch` polls every ten seconds. It checks process liveness,
  opens/resumes a durable server round, publishes structured operational status,
  and delivers a work order only when the terminal reports it is ready.
- The Corbanu control inbox accepts work through the normal user-turn path.
  Unsent composer text and active work prevent delivery. An accepted inbox file
  proves delivery; only server-side `duty-result` records prove a duty outcome.
- A round requires a specific `completed`, `blocked` or `deferred` result for
  every duty. Completion must agree with current durable state; routing completion
  requires an actual task-creation audit. A journal entry alone is insufficient.
- Partial results reset delivery backoff while retaining a monotonic delivery
  sequence. Three unanswered deliveries alert and retain the pending round.
  Recovery probes then wait 15, 30, 60, 120, 240 and at most 360 minutes between
  deliveries. Every probe requires a fresh ready terminal and an empty inbox.
  Public runtime status reports cooldown, attempt count and next probe time.
  Provider failure cannot permanently disable delivery. Results and command
  receipts remain authoritative; no retry creates a replacement round.
  Identical completed rounds have a fifteen-minute cooldown. Crash recovery
  resumes the saved thread. Daily reset preserves pending/busy work.
- Allocation health is published with every runtime status: tasks created,
  accounts offered, live allocations, per-board failure families, and
  submissions waiting on the manager. Only an unanswered submission or a
  decision that cannot publish is a warning or critical state.
- A processed round is not a resolved task. The supervisor keeps
  `<alias>.blockers.json` and tracks progress duties (`review_due`,
  `verification_due`, `hive_chat_escalation`) that were reported anything but
  completed in consecutive processed rounds, keyed by type, board and task. Routing invitations are never tracked. These
  duties disappear as soon as the required decision or reply exists, so recurrence
  means the task did not advance. Two consecutive rounds log
  `duty_blocked_across_rounds`, append to `ALERTS.log`, publish a
  `Stalled:` line and per-duty round counts in runtime status, and add an
  escalation directive to the next work order naming each stalled duty, its last
  reason, and the rule that a repeated identical command cannot change task
  state. Routing, staleness and board-info duties recur legitimately and are not
  tracked. The streak clears when the duty completes or leaves the duty set.
- Candidate discovery returns the entire eligible idle pool on every round,
  in stable account order, without a rewarded-history top-100 or a top-12 cut.
  Board restrictions filter that complete pool. Discovery errors fail the read
  instead of reporting an empty healthy board. All candidates are surfaced,
  including newcomers; actual assignment still requires source-grounded work,
  badge/work-type fit, wallet resolution, locked capacity and budget checks.
- `bm-install-cron.sh` installs one user systemd supervisor and an idle-only daily
  reset timer, replacing the compatibility wake timer. Its preflight verifies the scoped
  API and installed ready terminal before changing schedules. Failed startup keeps
  the existing schedule and stops the new service.

Production uses `/home/pfrpc/pf-boards/bin/corbanu`, an operator candidate built
from the PF-44 source, with its matching code-mode host. The launcher suppresses
interactive update prompts and pins the terminal home. The public Corbanu release
channel is unchanged. The prior wake timer/service, transcript entrypoint and
compatibility wake adapter have been removed after successful supervisor startup.
The same Kimi thread survived the normal old-process exit and candidate resume.

The scoped CLI provides local `help`/`--help` without loading a credential, and
names `round-status <round-id>` and `duty-result`. The round ID comes from the
supervisor work order; no work order is expected while current duties are empty.

The `kimi-code` credential remains in the Corbanu vault. Shared Vercel DeepSeek V4.1 Flash
models handle downstream task generation and applicable review operations;
Kimi retains board selection and board review decisions. No retired selector is
reintroduced. Operator fallback to another Kimi provider remains explicit.

## Scoped API and deployment

`POST /api/agent/board/command` accepts a typed argv array and an idempotency key.
The server resolves an expiring hashed agent credential, verifies board grants,
then executes existing domain functions under that actor. Writes, audit and
immutable command receipt commit in the same transaction. Conflicting key reuse
returns 409; scope failures cannot partially commit a write.

`node scripts/bm-agent-credential.mjs --help` describes credential provisioning.
The output file is created with mode 0600 and must not be printed or copied into
prompts. `scripts/bm/remote.mjs` binds it to its issuing origin and saves the
command key before HTTP. Pending retries preserve that key across restarts.

Deploy migration 135 and the API before installing the new supervisor or rotating
Kimi. Verify the candidate Corbanu control inbox, provision its scope, then resume
the existing production thread and confirm a real round/duty result. Keep runtime
readiness, command acceptance and completed board duties distinct in monitoring.
See [the implementation ledger](../../plans/tasknode-reliability-implementation-2026-09-05.md)
for the current deployment evidence and remaining live observation.

## Retained implementation and historical material

`board_manager_runs`, scopes, leases, action results, followups, user messages,
capability/evidence packets and Orc accounting support shared or historical
functions. A retained table does not establish that its old automatic worker
is enabled. `server/board-manager-actions.js` and the split repository modules
remain relevant to current command execution.

The earlier worker description, packet instrumentation and historical operator
commands are preserved in the
[pre-audit snapshot](../../archive/2026-09-05-task-architecture/board-manager.md).
Use `fly.toml`, `server/background-workers.js` and the current scripts as
runtime authority.

Targeted cancellation audits now capture the scoped task detail instead of rebuilding the global planning corpus inside the command transaction. This removes unrelated source reads from cancellation. The command response explicitly distinguishes `dry_run`, `cancelled`, and `skipped`, and states when `--execute` is still required. The scoped fixture verifies both the preview and committed cancellation through the real command dispatcher.

Routing completion evidence is checked by board even if eligible-pool membership changes during the round. A changed candidate list does not substitute for a successful assignment while routing demand remains.


## Public Hive escalation inbox

The production manager remains Kimi K3 in the supervised Corbanu TUI. A public
Hive bot uses DeepSeek V4.1 Flash to decide whether to participate and DeepSeek V4.1 Flash to
compose replies. It cannot execute board tasks. Its structured escalation
creates a `hive_group_escalations` row assigned to one existing network board.

`board` packets include `hive_chat_escalations`, `digest` incorporates pending
inbox IDs, and `duties` creates a separate `hive_chat_escalation` for each item.
The supervisor therefore presents them through its existing work orders.

- `node scripts/bm.mjs hive-inbox [board...]` reads the scoped public inbox.
- `node scripts/bm.mjs hive-reply <id> --message <public response> --outcome resolved|declined`
  closes the item and queues a signed public reply atomically.
- A completed duty requires the item to leave the pending inbox. An unsupported
  completion claim fails; a journal entry alone is insufficient.

Use the existing credential, immutable request-key receipt and board scope.
Replies contain only public facts; community text never grants permissions.
No additional task-manager loop, terminal release or Fly machine is needed.
After deployment, refresh the installed board-manager skill from
`ops/bm-runtime/skills/board-manager/SKILL.md`; do not restart a busy TUI.
