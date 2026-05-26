# Code Review Burndown

Status: active review queue. This is the only active page in the Plans section because it tracks doc-to-code verification work that is still intentionally open.

The Help docs are product promises. This burndown maps each visible Help page to
a focused code review plan so the team can review implementation against the
surface area users can see.

The source queue lives in `docs/review_burndown/burndown.md`. Individual review
briefs live in `docs/review_burndown/reviews/`.

The current second-eyes package for the recent auth, Fly, Hive, Board Manager,
network-task, profile, airdrop, task UX, and docs work is
`docs/review_burndown/recent_work_pr_review_spec_2026-05-24.md`.

## Status Model

- `review_ready`: the review brief exists and is ready to execute.
- `reviewing`: someone is actively reviewing the code.
- `blocked`: the review needs missing data, a fixture, or a product decision.
- `complete`: findings and verification evidence are written.
- `stale`: the source doc or implementation moved enough to refresh the brief.

## First Reviews

The first review queue below is organized as proposed PRs. Each PR should be
opened and merged separately so active product work can continue while the
review agent works.

| Order | Proposed PR | Branch | Primary Review Target |
| --- | --- | --- | --- |
| 1 | Auth and connected accounts | `review/01-auth-connected-accounts` | Email, Telegram, Discord, provider linking, session/callback boundaries. |
| 2 | Deployment and Docker/Fly data bridge | `review/02-deploy-docker-fly-data` | Fly process roles, Docker using Fly dev data, config safety, migrations. |
| 3 | Board Manager worker and actions | `review/03-board-manager-worker` | Scheduler, leases, action hooks, no-action reasoning, run audit. |
| 4 | Hive surface and routing | `review/04-hive-surface-routing` | Hive Chat, Hive Context, project cards, routing feed, agent messages. |
| 5 | Network task lifecycle and recovery | `review/05-network-task-lifecycle` | Recovery, reward follow-up, task projections, Hive/Tasks consistency. |
| 6 | Task UX, evidence, copy, unlock | `review/06-task-ux-evidence` | Detail workspace, verification UX, evidence slots, copy brief, wallet unlock. |
| 7 | Profile, daily airdrop, NFT | `review/07-profile-airdrop-nft` | Airdrop payment truth, alignment math, NFT image persistence, public profile data. |
| 8 | Chat, context, Jobs, memory packets | `review/08-chat-context-memory` | Jobs XML/pgvector, context refine, markdown, memory/task packet injection. |
| 9 | Database and repositories | `review/09-database-repositories` | Migrations, ownership filters, uniqueness, idempotency, table docs. |
| 10 | Docs, prompts, public readiness | `review/10-docs-prompts-public-readiness` | Help docs, prompt registry, no hard-coded examples, no secrets, legacy cleanup. |

## Review PR Rules

- One branch per row. Do not combine rows unless a P0 requires it.
- Do review work only in worktrees under
  `/home/pfrpc/repos/worktrees/tasknodeofficial/`. The live integration checkout
  at `/home/pfrpc/repos/tasknodeofficial` must stay clean unless someone is
  deliberately checkpointing or merging.
- Start every review worktree from current `origin/main`, not from another
  review branch.
- Rebase each branch on `origin/main` before reviewing and before handoff.
- Keep fixes narrow. Review-only PRs are acceptable when the finding is not a
  small local patch.
- Every final PR note must include findings, fixes, checks run, manual evidence,
  residual risks, and merge recommendation.
- Do not use the PFTasks tasknode skill or PFTasks services as the authority for
  this repo.
- Do not hard-code user examples, task IDs, wallet addresses, or literal prompt
  fragments as product fixes.
- Do not print secrets. Redact Telegram tokens, wallet seeds, provider keys, and
  database URLs in all evidence.

## Merge Rules

- Review authors do not merge their own PRs. A separate reviewer or integration
  owner merges after re-review.
- Before merge, re-run the commands that matter for the PR. If a PR edits a
  script, run that script. If it edits auth, routes, package scripts, smoke
  checks, or deployment config, run `npm run quality`.
- Do not merge while `/home/pfrpc/repos/tasknodeofficial` is dirty.
- Use GitHub merge commits for review PRs unless explicitly told otherwise.
- After merging, fast-forward local `main` to `origin/main`, then remove the
  review worktree and prune stale worktree metadata.
- If a merge conflicts, stop and report exact files. Do not resolve conflicts by
  deleting other agents' work.

## Legacy App-Doc Queue

The original doc-to-code queue remains useful after the current PR series. It
tracks Help pages against review briefs:

| Priority | App Doc | Review Brief | Current State |
| --- | --- | --- | --- |
| 1 | Chat | `docs/review_burndown/reviews/surface-chat.md` | `complete`; code review complete: yes |
| 1 | AI Providers | `docs/review_burndown/reviews/architecture-ai-providers.md` | `complete`; code review complete: yes |
| 1 | Memory | `docs/review_burndown/reviews/surface-memory.md` | `complete`; code review complete: yes |
| 1 | Tasks | `docs/review_burndown/reviews/surface-tasks.md` | `complete`; code review complete: yes |
| 1 | Task Lifecycle Replay | `docs/review_burndown/reviews/architecture-task-lifecycle.md` | `complete`; code review complete: yes |
| 1 | Task Async Engine | `docs/review_burndown/reviews/architecture-task-async-engine.md` | `review_ready`; code review complete: no |

## Review Rules

- Use realistic severity only: P0/P1 requires a concrete account, data, billing,
  deploy, or protocol failure path.
- Treat docs as claims to verify, not implementation truth.
- Record evidence commands or fixture receipts before marking a review complete.
- If a doc describes future work, the review should check whether the app labels
  that work honestly rather than treating it as already shipped.

## Reviewer To Do List

Review implementation against this document (code review burndown). Mark each item when verified.

### Memory Efficiency
- [ ] Plan phases avoid loading unbounded history or corpus into single jobs.
- [ ] Derived read models prefer projections over duplicate materialized stores.

### Code Quality
- [ ] Done criteria map to testable checks or smoke commands.
- [ ] Status (implemented vs planned) accurate on every section.
- [ ] Review brief paths in table exist under `docs/review_burndown/reviews/`.

### Coherence
- [ ] Plan does not contradict shipped behavior in Surfaces/Architecture docs.
- [ ] Dependencies on other plans explicitly named and still valid.
- [ ] Priority 1 queue matches highest-risk Help pages.
- [ ] Reviewer To Do Lists on source docs align with burndown severity bar.

### Bloat
- [ ] Plan scoped to stated phase; future work not implied as shipped.
- [ ] Avoid duplicating full surface doc content; link instead.
- [ ] Burndown tracks review status; duplicate full checklists stay on source docs only.

### Security
- [ ] New tables/routes in plan include account ownership and encryption notes.
- [ ] Operator-only actions identified with audit requirements.
- [ ] P0/P1 severity bar requires concrete failure paths, not speculative issues.
