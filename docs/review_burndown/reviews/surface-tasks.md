# Review Plan: Tasks

Source doc: `docs/wiki/surfaces/tasks.md`
App doc group: Surfaces
App doc slug: `tasks`
Review status: review_ready
Code review complete: no
Owner: unassigned
Last updated: 2026-05-18

## Important App Surfaces

- `src/main.jsx` task UI and request-task entry points
- `server/repositories/tasks.js`, `server/chat-task-context.js`
- `server/db/migrations/006_task_projections.sql`
- `scripts/task-projection-postgres-smoke.mjs`
- `scripts/import-task-replay-receipts.mjs`
- `reference_clients/python/tasknode_pftl/reducer.py`
- `docs/PFTL_TASK_ENGINE_SPEC.md`

## What Could Go Wrong

- Task UI shows fixture or cache-only data as if it were canonical task state.
- Task projection rows are not rebuildable from PFTL/IPFS evidence.
- Chat task context includes stale task status without explaining cache staleness.
- Accept/refuse/submit/reward flows are visible before wallet and chain writes
  are actually wired.

## Best Practices To Check

- Chain-backed task state should be replayable and cache rebuildable.
- UI should distinguish proposed, accepted, pending verification, refused,
  expired, and rewarded states.
- Mutating task actions should be idempotent and wallet-authorized.
- Projection imports should preserve source tx hashes, CIDs, and replay metadata.

## Code Review Plan

1. Compare visible task UI with repository-backed task projection behavior.
2. Review task projection schema, import script, and smoke tests.
3. Trace chat task context loading and formatting for account/wallet scope.
4. Verify whether any task mutation buttons are wired; if not, confirm honest UX.
5. Compare reducer semantics against `PFTL_TASK_ENGINE_SPEC.md`.

## Evidence To Capture

- `npm run db:task-projection-smoke` or equivalent current script.
- A replay/import fixture with task IDs, CIDs, and tx hashes.
- Screenshots or notes showing empty/proposed/rewarded task states.

## Completion Checklist

- [ ] Source doc claims mapped to implementation.
- [ ] User-visible workflow reviewed.
- [ ] Persistence and ownership boundaries reviewed.
- [ ] Billing, provider, wallet, or chain effects reviewed where applicable.
- [ ] Tests or smoke evidence recorded.
- [ ] Findings written with realistic severity.

## Review Findings

Not started.
