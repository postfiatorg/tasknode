# Code Review Burndown

The Help docs are product promises. This burndown maps each visible Help page to
a focused code review plan so the team can review implementation against the
surface area users can see.

The source queue lives in `docs/review_burndown/burndown.md`. Individual review
briefs live in `docs/review_burndown/reviews/`.

## Status Model

- `review_ready`: the review brief exists and is ready to execute.
- `reviewing`: someone is actively reviewing the code.
- `blocked`: the review needs missing data, a fixture, or a product decision.
- `complete`: findings and verification evidence are written.
- `stale`: the source doc or implementation moved enough to refresh the brief.

## First Reviews

| Priority | App Doc | Review Brief | Current State |
| --- | --- | --- | --- |
| 1 | Chat | `docs/review_burndown/reviews/surface-chat.md` | `review_ready`; code review complete: no |
| 1 | AI Providers | `docs/review_burndown/reviews/architecture-ai-providers.md` | `review_ready`; code review complete: no |
| 1 | Memory | `docs/review_burndown/reviews/surface-memory.md` | `review_ready`; code review complete: no |
| 1 | Tasks | `docs/review_burndown/reviews/surface-tasks.md` | `review_ready`; code review complete: no |
| 1 | Task Lifecycle Replay | `docs/review_burndown/reviews/architecture-task-lifecycle.md` | `review_ready`; code review complete: no |
| 1 | Task Async Engine | `docs/review_burndown/reviews/architecture-task-async-engine.md` | `review_ready`; code review complete: no |

## Review Rules

- Use realistic severity only: P0/P1 requires a concrete account, data, billing,
  deploy, or protocol failure path.
- Treat docs as claims to verify, not implementation truth.
- Record evidence commands or fixture receipts before marking a review complete.
- If a doc describes future work, the review should check whether the app labels
  that work honestly rather than treating it as already shipped.
