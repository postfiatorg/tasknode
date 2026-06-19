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
```

`orcctl review classify` writes the current disposition to
`orc_task_review_states` and appends immutable history to `orc_task_reviews`.
Nazgûl shared-state summaries read `orc_task_reviews`, `orc_run_journal`, and
`orc_operator_interactions` when those Postgres tables are present.

Important invariant:

```text
networkStatus=at_capacity blocks Network routing only; Personal task requests are still allowed.
```

For raw packet inspection, use the lower-level commands below. For normal
burn-down, prefer `orcctl` so the review state, follow-up request, task
lifecycle, user signal, and final closure stay tied together.

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
message in the JSON output.

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

By default the command reads Task Node's Directory-backed rewarded-task API,
`/api/directory/rewarded-tasks?taskKind=network`, so it ranks the same public
discoverable operator population shown in the Directory leaderboard. It builds
compact rewarded-submission packets and asks OpenRouter model `z-ai/glm-5.2`
to score the top heuristic-ranked candidates. It also computes a deterministic
local heuristic and returns sanity warnings when the model score diverges
sharply, omits reasons, or returns inconsistent task ids.

Use the local shared review-state table explicitly with:

```bash
uv run orcctl prioritize-network --source review-queue
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

This creates `orc_task_review_states` plus `orc_task_review_queue` in the Task
Node Postgres read model. Other orcs can read the same table/view to burn down
rewarded Network Task submissions by disposition.

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
chat message with `kind=orc_hive_signal` metadata. It bypasses Board Manager
dedupe and does not write `board_manager_user_messages`.
