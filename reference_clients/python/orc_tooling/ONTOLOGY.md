# Orc Review Ontology

This is the read model for answering: "What did this contributor submit for a
rewarded Network Task, and why did it get paid?"

## Entities

- `Person`: public handle or display identity used by operators.
- `Account`: Task Node `account_id`; owns profile, memory, context, and public
  handle rows.
- `Wallet`: PFTL classic address; Network Task offers, submissions, and rewards
  are wallet-scoped.
- `NetworkTask`: `task_projections` row with `task_kind=network`, joined to
  `network_task_allocations` and `network_task_generation_jobs`.
- `TaskBrief`: generated offer payload: title, objective, steps, submission
  requirement, and verification policy.
- `SourcePacket`: generation-job source payload explaining why Board Manager
  routed the task.
- `Submission`: `pf.task.submission.v1` evidence payload from `task_events`.
- `VerificationResponse`: `pf.task.verification_response.v1` follow-up evidence
  payload from `task_events`.
- `RewardOutcome`: `pf.reward.v1` or `pf.task.reward_decision.v1` review score,
  reviewer reason, feedback, and paid PFT.
- `TaskReview`: immutable Orc review/audit row for one classification event,
  persisted in `orc_task_reviews`.
- `ReviewState`: current shared Orc disposition for one rewarded Network Task,
  persisted in `orc_task_review_states` and readable through
  `orc_task_review_queue`.
- `OrcWorkJournal`: append-only Nazgûl/orc work ledger row linking a manager
  interaction to source task id, follow-up request/task, event CID, tx hash,
  operator handle, blocker, action, and terminal outcome.
- `OrcReviewRollup`: bounded view over reviewed outcomes by contributor
  account/wallet and task category. It carries disposition counts, integrity
  signal counts, latest reviewed task id, and timestamps for Board Manager
  routing context without raw review text.
- `OrcRuntimeDirective`: durable queue row for Nazgûl-to-Orc runtime
  handoffs, persisted in `orc_runtime_directives` when Postgres is configured
  and mirrored by JSONL only as a local fallback. One worker claims queued rows
  atomically with `FOR UPDATE SKIP LOCKED`.

## Identity Resolution

Resolve in this order:

1. exact `--account-id`;
2. `--task-id` via `task_projections`;
3. exact public handle through `user_identity_vectors.public_handle`,
   `recommended_connection_profiles.hive_handle`, then
   `user_observability_events.public_handle`;
4. exact `--wallet` through `pftl_sync_wallets` and `task_projections`.

If handle resolution fails, do not infer identity from similar names. Use
`--wallet`, `--account-id`, or `--task-id`.

## Query

```bash
cd /home/pfrpc/repos/tasknodeofficial/reference_clients/python
uv run orc-review-payloads --handle goodalexander --limit 5
uv run orc-review-payloads --wallet r... --limit 5
uv run orc-review-payloads --task-id task_... --raw-events
```

The command defaults to rewarded Network Tasks and returns:

- identity vector;
- provider names/counts, but not raw private provider identity JSON;
- task brief;
- source packet;
- submission artifacts;
- verification requests and responses;
- reward outcome;
- CIDs and transaction hashes.

Secret-shaped fields are redacted. The command is read-only.

## Shared Review State

Initialize the table and queue view:

```bash
cd /home/pfrpc/repos/tasknodeofficial/reference_clients/python
uv run orc-review-state init
```

Primary dispositions are mutually exclusive:

- `not_reviewed`: no review row exists yet, or the task has been explicitly reset.
- `in_review`: an orc has started reviewing but has not committed a final label.
- `reviewed_no_action`: self-contained, no core team or agent action needed.
- `reviewed_follow_up`: useful feedback needs categorization or action.
- `reviewed_follow_up_completed`: follow-up was completed, routed, or closed;
  no current action remains.
- `reviewed_integrity_follow_up`: negative integrity signal needs reconciliation
  or detection work.
- `reviewed_unclear`: evidence is missing, ambiguous, inaccessible, or needs a
  second pass.
- `reviewed_duplicate_or_superseded`: already captured, duplicated, or
  superseded.

`orc_task_review_queue` left joins `orc_task_review_items` to
`orc_task_review_states` and coalesces missing rows to `not_reviewed`. Review
items include local `task_projections` rows as `local_projection`, public
Directory rewarded-task packets as `directory_public`, and derived
`network_status_packet` rows for operational repair cases. Local projection rows
are the richer forensic source and win on conflict; public packets only fill
gaps or newer public event pointers. Each item can carry a derived
`statusPacket` with allocation state, task state, reward movement, and repair
reason. The queue admits positive-paid, zero-closed, duplicate-guarded, and
repair-required tasks so review work does not silently drop zero-reward terminal
outcomes or generation-link repair items. Burn down starts with:

```bash
uv run orc-review-state queue --disposition not_reviewed --limit 20
```

Persist a review state and append a review-history row:

```bash
uv run orc-review-state set task_... \
  --disposition reviewed_follow_up \
  --category onboarding \
  --category task_routing \
  --summary "Submission contains actionable onboarding feedback." \
  --recommended-action "Route into the onboarding issue backlog."
```

Integrity follow-up requires at least one integrity signal such as
`suspected_sybil_cluster`, `generic_ai_response`, `fabricated_evidence`,
`nonresponsive_submission`, `reward_abuse_pattern`, or
`executable_reward_clawback_artifact`.

`executable_reward_clawback_artifact` is a separation-of-duties control for
ledger-adjacent artifacts, not an accusation. Orc tooling applies it when a
review item categorized as `reward_accounting` or `security` includes an
executable artifact that alters rewards or performs clawback. The review
metadata then carries `integrityControl.controlMarker =
no_signing_no_fund_movement`, `independentOrcReviewRequired = true`, and
`humanSignerAuthorization = none_recorded`. The marker is recommend-only:
Sauron owns any signer approval, fund movement, clawback, ban, or enforcement.

`orc_task_reviews` is append-only history for Orc/Nazgûl accounting.
`orc_task_review_states` is the current-state table used by the queue view and
follow-up logic. `orc_task_review_items` is the durable ingestion table that
makes public rewarded tasks and derived status-packet repair rows visible to
every Orc even when a local projection row is absent.

`orc_work_journal` is the linked work ledger for assignment and closure
bookkeeping. `nazgul redirect`, `dispatch`, `dispatch-runtime`, and `escalate`
append idempotent rows when a source task is known. `orcctl close-followup`
appends a separate terminal row once the follow-up task reaches a closeable
state or explicit no-code-needed proof is recorded. Existing rows are not
rewritten; duplicate exact events are suppressed by an idempotency key.

`orc_review_rollups` is read-only and derived from
`orc_task_review_states`, `orc_task_review_items`, and `task_projections`. It
feeds audit outcomes back into Board Manager routing as manager-internal triage
context: counts by disposition, repeated integrity signals, high-value
categories, and latest reviewed task pointers. It deliberately excludes raw
review summaries and recommendations, and it does not enforce bans, reward
changes, or lifecycle transitions.

`orc_runtime_directives` is the durable queue for future supervised Orc runtime
work. The status enum is `queued`, `claimed`, `completed`, `failed`, or
`cancelled`. Claiming is a transaction that selects one queued directive for an
Orc with `FOR UPDATE SKIP LOCKED`, updates it to `claimed`, and records
`worker_id`, `claimed_at`, and `attempt_count`. Completion is idempotent:
terminal rows are reported as already terminal and are not completed again.
Without a configured database URL, `orc-runtime` uses the legacy JSONL mailbox
for local fallback only.

Follow-up linkage lives in `orc_task_review_states.metadata_json`, not new
canonical columns. `request-followup` writes `followup_request_id`, request
CIDs/tx, `followup_task_id` when known, `followup_status`, and
`user_signal_status`. Active submitted/generated follow-up linkage is treated as
idempotent: repeat `request-followup` calls return the existing request/task
instead of creating duplicate Personal tasks. Preview-only linkage can still be
replaced by a later submitted request. Stale closeable follow-ups are actionable
review states whose linked Personal follow-up task has reached `rewarded`,
`refused`, or `cancelled`. `close-followup` then marks the source review
`reviewed_follow_up_completed` and records terminal status, reward tx/cid, user
signal message id, and close time. A source review can also close with explicit
`no_code_needed` proof, but it never closes at request time.
