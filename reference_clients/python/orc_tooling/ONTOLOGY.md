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
`nonresponsive_submission`, or `reward_abuse_pattern`.

`orc_task_reviews` is append-only history for Orc/Nazgûl accounting.
`orc_task_review_states` is the current-state table used by the queue view and
follow-up logic. `orc_task_review_items` is the durable ingestion table that
makes public rewarded tasks and derived status-packet repair rows visible to
every Orc even when a local projection row is absent.
