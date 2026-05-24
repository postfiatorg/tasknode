# Code Review Burndown

This folder turns the app-visible Help docs into concrete code review plans.
Each review brief starts from one visible doc page, maps the app surfaces that
claim depends on, names practical failure modes, lists review standards, and
defines a review plan.

The briefs are not completed code reviews. They are the review queue.

## Folder Layout

- `burndown.md` - queue, status, and suggested review order.
- `composer_full_codebase_review_plan_2026-05-23.md` - ramp and operating plan
  for a full-codebase composer review agent.
- `recent_work_pr_review_spec_2026-05-24.md` - current PR-by-PR review plan for
  the recent auth, Fly-data, Hive, Board Manager, network-task, profile,
  airdrop, task UX, chat/memory, database, docs, and prompt work.
- `reviews/` - one review-plan brief per app-visible doc page.
- `templates/review_plan_template.md` - format for new review briefs.

## Status Values

- `review_ready` - source doc has a review brief and can be reviewed.
- `reviewing` - code review is currently being executed.
- `blocked` - review needs missing context, fixture data, or a product decision.
- `complete` - code review findings have been written and verification evidence
  is attached.
- `stale` - source doc or implementation moved enough that the brief needs a
  refresh before review.

## Severity Bar

Use production-realistic severity only.

- `P0` - concrete data loss, account leakage, auth or billing bypass, or a
  deploy-blocking failure already reachable in normal use.
- `P1` - likely user-visible breakage, incorrect billing, ownership isolation
  failure, unrecoverable workflow state, or protocol/cache divergence.
- `P2` - maintainability, missing observability, incomplete edge-state handling,
  stale documentation, or weak test coverage.
- `P3` - polish, clarity, backlog hardening, or review follow-up.

Do not mark speculative model behavior, theoretical prompt issues, or broad
"could be bad" concerns as P0/P1 unless there is a concrete app action,
data-boundary failure, or money/account impact behind it.

## Review Method

1. Read the source doc.
2. Identify the code surfaces the doc promises or implies.
3. List practical things that could go wrong.
4. Compare the implementation to normal industry expectations for that feature.
5. Execute the review plan and write findings in the brief.
6. Mark `Code review complete` only when findings and verification are present.
