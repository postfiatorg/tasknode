# Code Review Burndown

Updated: 2026-05-25

This is the queue for reviewing app-visible Help docs against implementation.
Every row links one visible doc page to a review brief. `Code review complete`
means the actual code review has been executed and findings/evidence were
recorded; most entries begin as `no`.

## Review Order

The current second-eyes review should first run the recent-work PR series in
`recent_work_pr_review_spec_2026-05-24.md`. That series covers the work that has
moved fastest since the original doc queue was written: auth, Fly data, Hive,
Board Manager, network tasks, profile, daily airdrop, task UX, chat/memory, DB,
and public-readiness.

After the PR series, continue the older app-doc queue:

1. Task Async Engine, PFTL Usage, Database.
2. Prompt pages and specialized tools.
3. Nostr, plans, and lower-risk docs.

## Recent-Work Review PR Series

Each row is intended to become one small review PR. The second agent should work
top to bottom and merge one at a time.

Review work must happen in separate worktrees under
`/home/pfrpc/repos/worktrees/tasknodeofficial/`, one branch per row. The main
checkout should remain clean except when checkpointing or merging reviewed
work.

Merging is a separate step from authoring the review. The review author should
push the branch and provide checks/evidence; a separate reviewer or integration
owner re-runs the relevant checks, merges with a GitHub merge commit, fast-
forwards local `main`, and removes the review worktree. If the PR conflicts or
checks fail, do not merge it.

| Order | Proposed PR | Branch | Spec Section | Status |
| --- | --- | --- | --- | --- |
| 1 | Auth and connected accounts | `review/01-auth-connected-accounts` | `recent_work_pr_review_spec_2026-05-24.md#pr-01-auth-and-connected-accounts` | `merged` |
| 2 | Deploy / Docker / Fly data | `review/02-deploy-docker-fly-data` | `recent_work_pr_review_spec_2026-05-24.md#pr-02-deployment-dockerfly-data-bridge-and-config-safety` | `merged` |
| 3 | Board Manager worker and actions | `review/03-board-manager-worker` | `recent_work_pr_review_spec_2026-05-24.md#pr-03-board-manager-worker-leases-actions-and-audit` | `review_ready` |
| 4 | Hive surface and routing | `review/04-hive-surface-routing` | `recent_work_pr_review_spec_2026-05-24.md#pr-04-hive-surface-hive-chat-context-projects-and-routing-feed` | `review_ready` |
| 5 | Network task lifecycle and recovery | `review/05-network-task-lifecycle` | `recent_work_pr_review_spec_2026-05-24.md#pr-05-network-task-lifecycle-recovery-reward-follow-up-and-projections` | `review_ready` |
| 6 | Task UX, evidence, copy, unlock | `review/06-task-ux-evidence` | `recent_work_pr_review_spec_2026-05-24.md#pr-06-task-detail-evidence-copy-unlock-and-verification-ux` | `review_ready` |
| 7 | Profile, daily airdrop, NFT | `review/07-profile-airdrop-nft` | `recent_work_pr_review_spec_2026-05-24.md#pr-07-profile-daily-airdrop-nft-and-public-profile-data` | `review_ready` |
| 8 | Chat, context, Jobs, memory packets | `review/08-chat-context-memory` | `recent_work_pr_review_spec_2026-05-24.md#pr-08-chat-context-refine-jobs-prompt-pgvector-and-memory-packets` | `review_ready` |
| 9 | Database and repositories | `review/09-database-repositories` | `recent_work_pr_review_spec_2026-05-24.md#pr-09-database-migrations-ownership-constraints-and-repository-consistency` | `review_ready` |
| 10 | Docs, prompts, public readiness | `review/10-docs-prompts-public-readiness` | `recent_work_pr_review_spec_2026-05-24.md#pr-10-docs-prompts-public-readiness-and-legacy-cleanup` | `complete` (findings in `reviews/pr-10-docs-prompts-public-readiness.md`) |

PR series progress: rows 1–2 merged on `main`; rows 3–9 have review branches/worktrees with findings recorded separately; row 10 review complete on this branch. Merging review PRs remains a separate integration step.

## Queue

| Priority | App Doc | Source | Review Brief | Status | Code Review Complete |
| --- | --- | --- | --- | --- | --- |
| 1 | Chat | `docs/wiki/surfaces/chat.md` | `reviews/surface-chat.md` | `complete` | yes |
| 1 | AI Providers | `docs/wiki/architecture/ai-providers.md` | `reviews/architecture-ai-providers.md` | `complete` | yes |
| 1 | Tasks | `docs/wiki/surfaces/tasks.md` | `reviews/surface-tasks.md` | `complete` | yes |
| 1 | Memory | `docs/wiki/surfaces/memory.md` | `reviews/surface-memory.md` | `complete` | yes |
| 1 | Task Lifecycle Replay | `docs/wiki/architecture/task-lifecycle.md` | `reviews/architecture-task-lifecycle.md` | `complete` | yes |
| 1 | Task Async Engine | `docs/wiki/architecture/task-async-engine.md` | `reviews/architecture-task-async-engine.md` | `review_ready` | no |
| 2 | Wallet | `docs/wiki/surfaces/wallet.md` | `reviews/surface-wallet.md` | `complete` | yes |
| 2 | PFTL Transaction Cache | `docs/wiki/architecture/pftl-transaction-cache.md` | `reviews/architecture-pftl-transaction-cache.md` | `complete` | yes |
| 2 | PFTL Usage | `docs/wiki/architecture/pftl.md` | `reviews/architecture-pftl.md` | `review_ready` | no |
| 2 | Database | `docs/wiki/architecture/database.md` | `reviews/architecture-database.md` | `review_ready` | no |
| 2 | Context | `docs/wiki/surfaces/context.md` | `reviews/surface-context.md` | `complete` | yes |
| 3 | Search | `docs/wiki/surfaces/search.md` | `reviews/surface-search.md` | `review_ready` | no |
| 3 | Motivation | `docs/wiki/surfaces/motivation.md` | `reviews/surface-motivation.md` | `review_ready` | no |
| 3 | Brainstorming Context | `docs/wiki/surfaces/brainstorming-context.md` | `reviews/surface-brainstorming-context.md` | `review_ready` | no |
| 3 | Refine Context | `docs/wiki/surfaces/refine-context.md` | `reviews/surface-refine-context.md` | `review_ready` | no |
| 3 | Rewrite | `docs/wiki/surfaces/rewrite.md` | `reviews/surface-rewrite.md` | `review_ready` | no |
| 3 | Agents | `docs/wiki/surfaces/agents.md` | `reviews/surface-agents.md` | `review_ready` | no |
| 3 | Encryption | `docs/wiki/architecture/encryption.md` | `reviews/architecture-encryption.md` | `review_ready` | no |
| 3 | IPFS | `docs/wiki/architecture/ipfs.md` | `reviews/architecture-ipfs.md` | `review_ready` | no |
| 3 | Prompt Index | generated from `prompts/**` | `reviews/prompts-index.md` | `review_ready` | no |
| 3 | Chat Prompts | generated from `prompts/chat/*.md` | `reviews/prompts-chat.md` | `review_ready` | no |
| 3 | Memory Prompts | generated from `prompts/memory/*.md` | `reviews/prompts-memory.md` | `review_ready` | no |
| 3 | Task Engine Prompts | generated from `prompts/task_engine/*taskgen*`, `block_contract_v1.md` | `reviews/prompts-task-engine.md` | `review_ready` | no |
| 3 | Verification Prompts | generated from `prompts/task_engine/verification_request_v1.md`, `evidence_screenshot_read_v1.md` | `reviews/prompts-verification.md` | `review_ready` | no |
| 3 | Reward Prompts | generated from `prompts/task_engine/reward_scoring_v1.md` | `reviews/prompts-reward.md` | `review_ready` | no |
| 4 | Start Here | `docs/wiki/index.md` | `reviews/start-task-node-wiki.md` | `review_ready` | no |
| 4 | Nostr TBD | `docs/wiki/architecture/nostr.md` | `reviews/architecture-nostr.md` | `review_ready` | no |
| 4 | Getting Tasks Over The Line | `docs/wiki/plans/getting-tasks-over-line.md` | `reviews/plan-getting-tasks-over-line.md` | `review_ready` | no |
| 4 | PFTL Transaction Cache Milestone | `docs/wiki/plans/pftl-transaction-cache-milestone.md` | `reviews/plan-pftl-transaction-cache-milestone.md` | `review_ready` | no |

## Operating Notes

- Keep this queue current when an app-visible doc is added, removed, or renamed.
- A review can be complete even if the feature is incomplete, as long as the
  findings clearly identify implementation gaps and the evidence is recorded.
- Prefer narrow review passes over omnibus reviews. If a doc spans multiple
  app surfaces, split findings by surface inside the brief instead of inflating
  severity.
