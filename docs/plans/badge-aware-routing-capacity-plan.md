# Badge-Aware Routing Capacity Plan

Status: implementation plan. This page describes the code and data changes
needed to make Network Task routing user-aware by verified operating badge. It
does not claim the runtime already enforces these rules.

This plan extends the badge catalog and identity approval model in
`docs/wiki/architecture/badge-based-network-task-routing.md`.

## Problem

Network Task capacity currently answers one narrow question: does this account
already have outstanding or pending Network Task work? That is necessary, but it
does not answer whether the account is qualified for the class of work the Hive
Board Manager is about to route.

The current Board Manager path still has these gaps:

- `server/repositories/network-tasks.js::getNetworkTaskEligibility` reports
  active task capacity but not verified badge/work-type eligibility.
- `server/repositories/network-tasks.js::listEligibleNetworkTaskCandidates`
  still treats completed NDR plus active wallet as the broad candidate pool.
- `server/repositories/board-manager.js::buildBoardManagerSourcePacket` does
  not provide a normalized badge eligibility projection to the model.
- `prompts/hive/board_manager_v1.md` and
  `prompts/hive/board_manager_secretary_v1.md` currently describe capacity as
  outstanding Network Tasks or pending generation jobs.
- `schemas/board-manager-action.schema.json` accepts generic Network Task
  fields but has no required badge, operating badge, work-type fit, or reward
  cap fields.
- `server/repositories/network-tasks.js::enqueueNetworkTaskGenerationFromBoardDecision`
  enforces task capacity but does not enforce badge eligibility, work type, or
  badge payout caps before generating an offer.

The result is that prompt language can discourage bad routing, but code does
not yet prevent the Board Manager from routing private repo, protocol, reward,
or sybil-sensitive work to a random community account.

## Core Rule

Do not redefine canonical task capacity to mean everything.

Keep these gates separate in code and data:

| Gate | Meaning | Primary consumer |
| --- | --- | --- |
| `task_capacity` | Active or pending Network Task load. | Tasks UI, Board Manager source packet, executor guard. |
| `badge_eligibility` | Whether the user has at least one verified Network Task badge. | Tasks UI and routing candidate selection. |
| `work_type_fit` | Whether the verified badge can receive the proposed task class, work type, project scope, and reward. | Board Manager source packet and executor guard. |

The UI may show a user-facing combined state such as `Capacity blocked`, but the
server payload must preserve the distinct blocker reasons. Otherwise operators
will confuse "already has work" with "not qualified for this work."

## Target Badge Projection

Add a deterministic server-side projection helper, backed by durable badge and
identity approval state. It should be usable by Profile, Tasks, Board Manager,
and review tooling without asking each surface to re-derive badge status.

Suggested output shape:

```json
{
  "accountId": "acct_...",
  "walletAddress": "r...",
  "verifiedBadges": [
    {
      "badgeId": "kol",
      "status": "verified",
      "eligibleWorkTypes": ["amplification", "article_distribution"],
      "rewardCaps": {
        "x_post": 20000,
        "medium_article": 50000
      },
      "evidenceSummary": "X linked, follower count verified by provider metrics",
      "verifiedAt": "2026-06-21T00:00:00.000Z"
    }
  ],
  "eligibleWorkTypes": ["amplification", "article_distribution"],
  "blockedWorkTypes": [
    {
      "workType": "private_repo_code",
      "reason": "missing_core_contributor_badge"
    }
  ],
  "missingBadgeRequirements": [
    {
      "badgeId": "qa_worker",
      "requirements": ["linked_discord", "linked_telegram", "usdc_top_up"]
    }
  ],
  "hasRoutableNetworkBadge": true
}
```

Initial badge inputs:

- KOL: linked X and objective audience metrics from provider APIs where
  available.
- Core Contributor: linked GitHub handle matched to a sanctioned contributor
  list or future internal access capability. Do not require broad private repo
  OAuth scopes from users.
- QA Worker: linked Telegram, linked Discord, and at least one recorded USDC
  chat-wallet top-up.
- Expert: at least 20 completed Personal tasks plus a current harsh GLM 5.2
  score of 80 or higher for the requested expertise topic.
- Project Leader: discretionary backend-approved Hive handles whose Hive Chat
  inputs can define special new projects, including open-source projects.
- Orc operator routing is separate infrastructure, not a user-facing Profile
  badge.

## Task Eligibility Changes

Extend `getNetworkTaskEligibility` with a badge gate. The Tasks UI should be
able to distinguish:

- `task_capacity.available`: the user has no active or pending Network Task
  blocker.
- `task_capacity.blocked`: active/proposed/accepted/submitted/verification work
  already consumes the lane.
- `badge_eligibility.available`: the user has at least one verified badge that
  can receive Network Tasks.
- `badge_eligibility.blocked`: the user has no verified Network Task badge.
- `work_type_fit.blocked`: the user has badges, but none match a specific
  routed work type.

Suggested user-facing copy for no badge:

> Capacity blocked: you need a verified Network Task badge before Hive Board
> Manager can route work to you.

Implementation boundaries:

- `server/repositories/network-tasks.js::getNetworkTaskEligibility`
- `src/features/tasks/network-task-eligibility-state.js`
- `src/features/tasks/NetworkTaskEligibilityPanel.jsx`

## Board Manager Source Packet

Add a normalized `badgeEligibility` block to
`buildBoardManagerSourcePacket`. It should sit next to
`boardActionPressure`, `capabilityInstrumentation`, and
`networkTaskCandidates`.

The source packet should include:

- verified badges per candidate;
- eligible and blocked work types;
- reward caps by badge and task subtype;
- missing requirements for the next badge step;
- a clear distinction between task-capacity blockers and badge blockers.

Avoid ambiguous aggregate counts. Prefer separate fields such as:

- `taskCapacityEligibleCandidateCount`
- `badgeEligibleCandidateCount`
- `workTypeEligibleCandidateCount`
- `candidateBadgeBlockers`
- `candidateTaskCapacityBlockers`

`boardActionPressure.candidateCapacity` should remain the task-capacity view,
but Board Manager routing pressure should consider both task capacity and badge
fit before choosing `initiate_network_task`.

## Board Manager Schema And Executor

Prompt edits alone are insufficient because the schema currently drops any
unknown Network Task fields. Update
`schemas/board-manager-action.schema.json` before relying on model output.

Add fields under `payload.network_task`:

- `required_badge_id`
- `operating_badge_id`
- `badge_reason`
- `badge_reward_cap_pft`
- `badge_work_type`
- `badge_evidence_requirements`

Then enforce them in
`enqueueNetworkTaskGenerationFromBoardDecision` before any offer is generated:

- reject if the candidate lacks `required_badge_id`;
- reject if the proposed work type is not allowed for the badge;
- reject if `reward_max_pft` exceeds the badge cap;
- reject if the action omits badge metadata for a badge-gated Network Task.

Suggested rejection reasons:

- `network_task_candidate_missing_badge`
- `network_task_work_type_not_allowed_for_badge`
- `network_task_reward_exceeds_badge_cap`
- `network_task_missing_badge_metadata`

This must be a hard runtime gate, not only prompt guidance.

## Prompt Changes

Update the Hive prompts only after the projection and schema exist.

`prompts/hive/board_manager_v1.md` should tell the model:

- choose candidates by verified badge and work-type fit;
- route KOL work only to KOLs;
- route QA reports only to QA Workers;
- route expert bundles only to matching Experts;
- allow backend-approved Project Leaders to define special/open-source projects
  from Hive Chat inputs;
- route private repo/core implementation only to Core Contributors;
- never use badge-ineligible users for sensitive protocol, reward, sybil,
  private repository, or enforcement work.

`prompts/hive/board_manager_secretary_v1.md` should preserve badge eligibility
and work-type fit during packet compression.

`prompts/task_engine/taskgen_network_v1.md` should generate badge-specific
evidence requirements:

- KOL: public post/article link and required audience/channel proof.
- QA Worker: screenshot, repro steps, account/device context, and observed app
  state.
- Expert: bundle of five relevant Personal task outputs and domain conclusion.
- Core Contributor: PR, commit, branch, issue, or sanctioned repo artifact.

## Persistence And Audit

Persist badge routing metadata into the allocation, generation job, task source
packet, and review/reward audit surfaces:

- `required_badge_id`
- `operating_badge_id`
- `badge_reward_cap_pft`
- `badge_work_type`
- `badge_eligibility_decision`
- `badge_projection_version`
- `badge_projection_evidence_digest`

This is needed for later review of why a user received a task, why a payout was
allowed, and whether the Board Manager routed work against the intended badge
state.

## Build Order

1. Add the deterministic badge projection helper/repository.
2. Extend `getNetworkTaskEligibility` with `task_capacity` and
   `badge_eligibility` gates.
3. Update the Tasks capacity UI to show no-badge routing as a distinct
   capacity blocker.
4. Add `badgeEligibility` to the Board Manager source packet.
5. Extend the Board Manager action schema with badge routing fields.
6. Enforce badge, work-type, and reward-cap checks in the Network Task executor.
7. Update Board Manager, secretary, and Network Task generation prompts.
8. Persist badge routing metadata into allocation/job/task source packets.

## Verification Plan

Minimum checks before merge:

- Badge projection smoke: KOL, Core Contributor, QA Worker, Expert, no-badge,
  and mixed-badge accounts.
- Task eligibility smoke: no badge returns badge-blocked capacity copy while
  active Network Task blockers still return task-capacity blockers.
- Board Manager source packet smoke: candidates include badge eligibility and
  separate task-capacity vs badge blockers.
- Schema smoke: `initiate_network_task` validates the new badge fields and
  rejects unknown or missing required values.
- Executor smoke: rejects missing badge, wrong work type, excessive reward, and
  missing badge metadata.
- Prompt smoke: generated task briefs include badge-specific evidence
  requirements and do not route sensitive work to Anon/community users.

## Done State

The feature is complete when:

- private Profile shows eligible and missing badge states;
- public Profile renders verified badge symbols;
- Tasks explains badge-blocked Network Task routing clearly;
- Board Manager source packets carry badge/work-type/reward-cap facts;
- schema and executor enforce badge routing before task offer generation;
- generated Network Tasks include badge-specific evidence requirements;
- audit records show which badge authorized each routed task.
