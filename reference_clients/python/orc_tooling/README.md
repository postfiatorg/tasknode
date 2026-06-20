# orc_tooling

Small operator helpers for Task Node Orc and Nazgul work.

The default client uses the mainline `TaskNodeAgentClient` seed-isolation
contract: set one assigned seed in `TASKNODE_AGENT_WALLET_SEED`.
It reuses `/home/pfrpc/repos/tasknode_agent_sessions.json` for cached sessions.
Seed or mnemonic material is never printed.

## Unified Orc Console

Use `orcctl` for normal Orc review work. It keeps the review loop compact,
uses the assigned Orc wallet session, writes durable journal rows for task
lifecycle actions, writes shared review state/history rows, and separates
Personal follow-up work from Network task capacity.

```bash
cd /home/pfrpc/repos/tasknodeofficial/reference_clients/python

uv run orcctl status
uv run orcctl review next
uv run orcctl review classify task_... \
  --disposition reviewed_follow_up \
  --category reward_accounting \
  --summary "Rewarded task surfaced duplicate payment drift." \
  --action "Verify idempotent reward emission and reconcile affected totals." \
  --confidence high
uv run orcctl request-followup task_... --submit
uv run orcctl run-personal-task task_followup_...
uv run orcctl prioritize-network
uv run orcctl signal-user task_original_... \
  --message "Following up on your rewarded task: we verified the issue and completed the fix." \
  --execute
uv run orcctl close-followup task_original_... --followup-task-id task_followup_...
uv run orcctl self-cycle --execute
uv run orcctl self-loop --iterations 10 --sleep-seconds 120 --execute
```

## Onboard An Orc Agent

Register a new Orc in `orc_agents`, assign its charter, and print the public
wallet allowlist entry that Sauron/operator must add to the production Fly
secret:

```bash
uv run orcctl agent onboard \
  --handle grashnuk \
  --wallet-address r... \
  --account-id acct_... \
  --charter-file /path/to/grashnuk-charter.md
```

The command stores the charter in `orc_agents.metadata_json` under
`pf.orc.agent_onboard.v1`. It does not read, write, or print wallet seeds, and
it does not mutate Fly secrets. The JSON output includes
`allowlist.entryToAppend`; the operator appends that public classic address to
`TASKNODE_AGENT_WALLET_ALLOWLIST`.

`orcctl review classify` writes the current disposition to
`orc_task_review_states` and appends immutable history to `orc_task_reviews`.
Nazgûl shared-state summaries read `orc_task_reviews`, `orc_run_journal`,
`orc_operator_interactions`, and the linked `orc_work_journal` when those
Postgres tables are present.
`orcctl task accept`, `orcctl task submit`, and `orcctl task respond` keep the
local JSONL run journal and append DB-backed `task_accept`, `task_submit`, and
`task_respond` rows to `orc_work_journal` after successful signed submissions;
if that shared journal write fails after a tx is submitted, the command reports
the journal error in `workJournal` instead of rethrowing and encouraging an
unsafe retry.
Board Manager source packets also read `orc_review_rollups`, a bounded
manager-internal view that aggregates reviewed outcomes by contributor
account/wallet and task category. Rollups carry counts, controlled integrity
signal labels, latest reviewed task id, and timestamps only; raw review summary
text and recommendation text are intentionally excluded.

Ledger-adjacent executable reward/clawback artifacts are treated as controls,
not accusations. If a rewarded Network review item in `reward_accounting` or
`security` includes an executable script that alters rewards or performs a
clawback, Orc tooling adds the integrity signal
`executable_reward_clawback_artifact` and metadata control marker
`no_signing_no_fund_movement`. That marker means an independent Orc review is
required before operational use and no signer authorization has been recorded;
it does not ban, claw back, sign, move funds, or label the contributor as fraud.

Important invariant:

```text
networkStatus=at_capacity blocks Network routing only; Personal task requests are still allowed.
```

Follow-up linkage is persisted in review-state `metadata_json`. When
`request-followup` creates a Personal follow-up request, it records
`followup_request_id`, request CIDs/tx, `followup_task_id` when already known,
follow-up status, and user-signal status on the source review state. It also
appends an idempotent `request_followup` row to `orc_work_journal`; repeat
commands that find an active follow-up backfill that same journal row instead
of requesting another task. `orcctl status` surfaces stale closeable follow-ups:
actionable review states whose
linked follow-up task has reached a terminal closeable status. By default status
only proposes `close-followup` commands; `orcctl status --close-stale` performs
those closures through the same evidence-gated path. `close-followup` requires
either a terminal follow-up task (`rewarded`, `refused`, or `cancelled`) or an
explicit `--no-code-needed-proof`; it never closes immediately at request time.
`close-followup` also appends a terminal `orc_work_journal` row with the source
task, follow-up task/request, event CID, tx hash, outcome status, and the
previously recorded user-signal message id when one exists.
These post-action `orc_work_journal` writes are best-effort after the real
action or review-state update has succeeded: if the journal insert fails, the
command returns the journal error in `workJournal` instead of throwing after a
request, visible signal, signed tx, or terminal closure has already happened.

For raw packet inspection, use the lower-level commands below. For normal
burn-down, prefer `orcctl` so the review state, follow-up request, task
lifecycle, user signal, and final closure stay tied together.

## Self-Cycle

`orcctl self-cycle` is the Option-A autonomous agent loop primitive. One run:

1. reads the Orc inventory through the signed agent session;
2. closes one already-terminal stale follow-up if present;
3. otherwise ranks assigned operator work and the shared review queue through the
   same Network Task triage capability used by `prioritize-network`;
4. performs one bounded work unit when `--execute` is present.

The default is a dry run. It prints the selected item and the exact action it
would take without mutating review state or submitting signed transactions.

```bash
uv run orcctl self-cycle --heuristic-only
uv run orcctl self-cycle --execute --heuristic-only
```

For rewarded Network Task review, an executed cycle records a source-backed Orc
review state. If the review needs a concrete follow-up, it can also create the
Personal follow-up request through the existing audited path. By default the
follow-up request is a signed preview; add `--submit-followup` to publish the
request pointer.

```bash
uv run orcctl self-cycle --execute --submit-followup
```

For assigned tasks, the cycle reads the task detail first. It accepts proposed
assigned tasks only when `--accept-assigned` is provided, and it submits or
responds only when evidence/response text is explicitly supplied.

```bash
uv run orcctl self-cycle --source operator-outstanding --execute --accept-assigned
uv run orcctl self-cycle --source operator-outstanding --execute --evidence-file ./evidence.md
```

`orcctl self-loop` wraps `self-cycle` with max-iteration and sleep guardrails. It
stops on idle/blocking outcomes by default.

```bash
uv run orcctl self-loop --iterations 12 --sleep-seconds 300 --execute
```

The loop does not deploy, ban, claw back, alter rewards, or approve
self-verification. Those remain reserved outside Orc autonomy.

## Nazgul Oversight Console

Use `nazgul` when acting as the manager over multiple Codex Orc panes. It wraps
tmux capture/injection and shared Orc state so the manager does not rely on
ad-hoc pane scraping.

```bash
cd /home/pfrpc/repos/tasknodeofficial/reference_clients/python

uv run nazgul status
uv run nazgul watch orc-alpha
uv run nazgul redirect orc-alpha "Continue the current task and report blockers."
uv run nazgul dispatch orc-alpha
uv run nazgul escalate orc-alpha "Signer approval required before clawback execution."
```

`nazgul redirect` uses the Codex-safe tmux flow: `load-buffer`,
`paste-buffer -p`, wait one second, verify exactly one `[Pasted Content ...]`
chip, then send Enter. `nazgul dispatch` pulls the next non-blocked
`not_reviewed` row from shared review state and injects a compact directive.
`nazgul escalate` records `orc_operator_interactions` and prints a Sauron-facing
message in the JSON output. When `redirect`, `dispatch`, `dispatch-runtime`, or
`escalate` can identify a source `task_...`, they also append an idempotent
linked row to `orc_work_journal`; `nazgul status` surfaces recent linked work
beside the shared review queue. If that trailing work-journal insert fails
after the operator interaction was recorded, `nazgul` returns the journal error
inside `workJournal` instead of failing the dispatch/redirect/escalation result.
For `redirect`, `dispatch`, and `dispatch-runtime`, the tmux injection or
runtime queue operation is also authoritative once it succeeds: if the later
`orc_operator_interactions` write fails, the command still reports the dispatch
result and includes `operatorInteraction.ok=false` with the recording error.
Do not retry those commands blindly just to repair the audit row; that can
duplicate the already-submitted directive.

Phase 5 adds a durable runtime prototype that avoids tmux injection:

```bash
uv run nazgul dispatch-runtime grashnuk
uv run orc-runtime status --orc grashnuk
uv run orc-runtime run-once --orc grashnuk --worker-id grashnuk-runtime-1
```

`dispatch-runtime` and `orc-runtime` prefer the Postgres
`orc_runtime_directives` table whenever `--database-url` or a Task Node database
URL environment variable is configured. Claiming uses
`SELECT ... FOR UPDATE SKIP LOCKED` so multiple workers can claim concurrently
without double-assignment. When no database URL is configured, the commands
fall back to the local JSONL mailbox at
`~/.cache/tasknode/orc_runtime/orc_runtime_events.jsonl`.

The claim path also recovers stale Postgres claims for the requested Orc before
selecting ordinary queued work. The default stale-claim TTL is six hours and can
be overridden with `TASKNODE_ORC_RUNTIME_CLAIM_TTL_SECONDS` or
`--claim-ttl-seconds`; use `0` only when recovery should be disabled. Recovery
updates the stale row to the new worker in one transaction and records the
previous claim in `metadata_json.lastStaleClaimRecovery`.

`dispatch-runtime` is idempotent for active source work: while a directive for
the same Orc, source, and task id is still queued or claimed, a repeat dispatch
returns the existing directive instead of queueing duplicate agent work.

The prototype executor does not run Codex or submit task transactions. It only
claims a directive and returns a `prototype_claim_only` result in the command
output. It does not mark the row completed without a real embedded executor.
Production execution still needs the supervised worker described in
`docs/wiki/architecture/orc-durable-runtime.md`.

Orc panes can be configured with:

```bash
uv run nazgul \
  --orcs-json '[{"name":"orc-alpha","tmuxTarget":"orc-alpha:0.0"}]' \
  status
```

## Prioritize Network Review Work

Rank everyone's unreviewed rewarded Network Task submissions before choosing
the next Orc review:

```bash
cd /home/pfrpc/repos/tasknodeofficial/reference_clients/python
uv run orcctl prioritize-network
```

This is the shared Network Task triage capability. `orcctl prioritize-network`,
`orcctl review next`, and `nazgul dispatch` all consume the same ranked triage
result (`orc_network_task_triage_v1`) so Orc panes do not disagree about the
next task, next command, source mode, review disposition, or follow-up action.

By default the command reads the unified `orc_task_review_queue`. That queue is
backed by `orc_task_review_items`, which preserves local `task_projections`
forensic rows and also accepts public Directory rewarded-task packets ingested
from `/api/directory/rewarded-tasks?taskKind=network`. Queue items can carry a
derived status packet (`allocationState`, `taskState`, `rewardMovement`,
`repairRequired`), so zero-reward terminal outcomes, duplicate-guarded rewards,
and generation-link repair rows stay reviewable instead of disappearing behind a
positive-reward-only filter. It builds compact rewarded-submission packets and
asks OpenRouter model `z-ai/glm-5.2` to score the top heuristic-ranked
candidates. It also computes a deterministic local heuristic and returns sanity
warnings when the model score diverges sharply, omits reasons, or returns
inconsistent task ids.

Refresh the queue from the public Directory source:

```bash
npm run orc-review-queue-ingestion -- --execute
```

Rank the live Directory API directly, without using the shared queue:

```bash
uv run orcctl prioritize-network --source directory-rewarded-tasks
```

Rank only the current Orc's offered Network tasks with:

```bash
uv run orcctl prioritize-network --source operator-outstanding
```

Use the local fallback when testing command shape or when OpenRouter is not
available:

```bash
uv run orcctl prioritize-network --heuristic-only
```

## Request A Personal Task

Preview the signed request without publishing:

```bash
cd /home/pfrpc/repos/tasknodeofficial/reference_clients/python
uv run orc-request-task "verify zoz work"
```

Publish the request pointer:

```bash
cd /home/pfrpc/repos/tasknodeofficial/reference_clients/python
uv run orc-request-task --submit "verify zoz work"
```

Equivalent module form:

```bash
uv run python -m orc_tooling --submit "verify zoz work"
```

## Library Use

```python
from orc_tooling import request_personal_task

summary = request_personal_task("verify zoz work", submit=True)
print(summary["requestId"], summary["txHash"])
```

The helper builds one `TaskNodeAgentClient`, logs in or reuses the cached
session once, submits the request if asked, and returns only non-secret
identifiers such as request id, CIDs, transaction hash, and engine result.

## List Outstanding Task Briefs

```bash
cd /home/pfrpc/repos/tasknodeofficial/reference_clients/python
uv run orc-tasks
```

This reads `/api/tasks` and emits outstanding task briefs with objective,
steps, verification policy, and submission requirements.

## Inspect Executable Task Payloads

```bash
cd /home/pfrpc/repos/tasknodeofficial/reference_clients/python
uv run orc-task-payload task_c02d7a3048277e6cdd424bc67dbe9795
```

Inspect every visible Network task payload:

```bash
uv run orc-task-payload --all-visible --network-only
```

This reads `/api/tasks/detail` and returns the execution brief, generated task
payload, Network Task project/allocation/routing payload, source CIDs, action
availability, and verification/reward state visible to the assigned Orc wallet.
Use `--raw-detail` only when debugging extractor coverage; it still redacts
secret-shaped fields.

## Review Other Contributors' Rewarded Network Tasks

```bash
cd /home/pfrpc/repos/tasknodeofficial/reference_clients/python
uv run orc-review-payloads --handle goodalexander --limit 5
uv run orc-review-payloads --wallet r... --limit 5
uv run orc-review-payloads --task-id task_... --raw-events
```

This is a read-only Postgres query, not a wallet-signed API action. It resolves
the identity vector and returns rewarded Network Task briefs, source packets,
submitted evidence artifacts, verification responses, reward scores, CIDs, and
transaction hashes. It emits provider names/counts for routing context, not raw
private provider identity JSON. See `ONTOLOGY.md` for the entity model.

## Persist Shared Review State

```bash
cd /home/pfrpc/repos/tasknodeofficial/reference_clients/python
uv run orc-review-state init
uv run orc-review-state queue --disposition not_reviewed --limit 20
uv run orc-review-state set task_... \
  --disposition reviewed_follow_up \
  --category onboarding \
  --summary "Actionable onboarding feedback." \
  --recommended-action "Route to core onboarding backlog."
```

This creates `orc_task_review_states`, `orc_task_review_items`,
`orc_task_review_queue`, and `orc_review_rollups` in the Task Node Postgres read
model. Other orcs can read the same table/view to burn down rewarded Network
Task submissions by disposition. The Board Manager consumes the rollups as
context only; they do not enforce fraud findings, bans, reward changes, or task
lifecycle changes. Local projection rows win over public Directory packets on
conflict; public packets only fill missing queue items or newer public event
pointers.

Follow-up requests are idempotent for active generated work. If a review already
has a submitted/generated follow-up request, a follow-up transaction hash, or a
linked follow-up task id in `metadata_json`, `orcctl request-followup` returns
that active linkage instead of creating a second Personal task. Preview-only
metadata remains replaceable so an Orc can upgrade a dry-run preview to a real
submitted request later.

## Send Hive Chat Follow-Ups

Preview an audited Board Manager message to the owner of a task:

```bash
cd /home/pfrpc/repos/tasknodeofficial/reference_clients/python
uv run orc-hive-followup send \
  --task-id task_d2527276782f04a30ce1bbe19bc5c188 \
  --message "Following up on the rewarded task..."
```

Send the duplicate-reward reconciliation follow-up:

```bash
uv run orc-hive-followup duplicate-reward --execute
```

The wrapper calls `/home/pfrpc/repos/tasknodeofficial/scripts/orc-hive-followup.mjs`,
which resolves the task owner, routes delivery through the app's Board Manager
`message_user` action hook, writes chat/audit rows, and defaults to dry-run
unless `--execute` is provided. Duplicate-reward follow-ups are informational
by default, so they do not open a new Board Manager follow-up waiting on the
user.

The Python wrapper fails closed unless the Node script returns valid JSON. A
zero-exit process with malformed stdout returns `ok=false` and the CLI exits
non-zero, so an Orc cannot claim a Board-Manager-routed message was sent
without a parsed delivery contract.

## Send Direct Orc Hive Signals

Use direct signals for Orc review notices that should appear in Hive Chat but
should not become Board Manager actions or follow-up blockers:

```bash
cd /home/pfrpc/repos/tasknodeofficial/reference_clients/python
uv run orc-hive-signal \
  --task-id task_8f8ff4b94792842a9b54a63769710afd \
  --message "Reviewed and closed..." \
  --reviewer-handle orc-alpha \
  --execute
```

This calls `/home/pfrpc/repos/tasknodeofficial/scripts/orc-hive-signal.mjs`,
ensures the task owner's Hive conversation exists, and appends an assistant
chat message with `kind=orc_hive_signal` metadata. It does not write
`board_manager_user_messages`. Retries are idempotent for the same recipient,
conversation, task id, reviewer, reason, and exact message body: the script
returns the existing verified chat row instead of appending a duplicate Orc
message.

The Python wrapper fails closed unless the Node script returns valid JSON. A
zero-exit process with malformed stdout returns `ok=false` and the CLI exits
non-zero, so an Orc cannot claim a direct message was sent without a parsed
delivery contract.
