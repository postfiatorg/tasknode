# Review Plan: Task Lifecycle Replay

Source doc: `docs/wiki/architecture/task-lifecycle.md`
App doc group: Architecture
App doc slug: `task-lifecycle`
Review status: review_ready
Code review complete: no
Owner: unassigned
Last updated: 2026-05-18

## Important App Surfaces

- `docs/PFTL_TASK_ENGINE_SPEC.md`
- `reference_clients/python/tasknode_pftl/reducer.py`
- `reference_clients/python/tasknode_pftl/scenarios/full_lifecycle.py`
- `reference_clients/python/tasknode_pftl/scenarios/app_request_lifecycle.py`
- `server/repositories/tasks.js`
- `server/db/migrations/006_task_projections.sql`

## What Could Go Wrong

- The reducer and app projection disagree on task status transitions.
- Delayed or out-of-order events produce incorrect final state.
- Missing IPFS/decrypt failures erase pointer events instead of preserving retry
  state.
- Reward transactions are not tied back to task IDs and allocation wallets.

## Best Practices To Check

- Lifecycle reducers should be deterministic, replayable, and covered by fixture
  sequences.
- Projection caches should be rebuildable from canonical events.
- Failed payload hydration should be explicit state, not dropped data.
- Reward/replay receipts should include tx hashes, CIDs, wallet addresses, and
  final projection.

## Code Review Plan

1. Review lifecycle spec against Python reducer behavior.
2. Review app task projection schema and repository mapping.
3. Run reducer tests and projection smoke tests.
4. Inspect handling for duplicate, missing, and out-of-order events.
5. Compare web Tasks UI status labels to reducer status labels.

## Evidence To Capture

- Python reducer tests.
- Full lifecycle receipt or fixture.
- Task projection Postgres smoke.
- A replay from deleted projection rows, if implemented.

## Completion Checklist

- [ ] Source doc claims mapped to implementation.
- [ ] User-visible workflow reviewed.
- [ ] Persistence and ownership boundaries reviewed.
- [ ] Billing, provider, wallet, or chain effects reviewed where applicable.
- [ ] Tests or smoke evidence recorded.
- [ ] Findings written with realistic severity.

## Review Findings

Not started.
