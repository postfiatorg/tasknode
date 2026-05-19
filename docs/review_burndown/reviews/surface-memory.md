# Review Plan: Memory

Source doc: `docs/wiki/surfaces/memory.md`
App doc group: Surfaces
App doc slug: `memory`
Review status: review_ready
Code review complete: no
Owner: unassigned
Last updated: 2026-05-18

## Important App Surfaces

- `src/features/memory/MemoryView.jsx`, `src/features/memory/memory.css`
- `server/chat-memory-worker.js`
- `server/chat-memory-context.js`
- `server/repositories/chat-memory.js`
- `server/chat-router.js`
- `server/db/migrations/004_chat_memory.sql`, `005_deep_chat_memory.sql`
- `scripts/chat-memory-postgres-smoke.mjs`, `scripts/memory-backfill.mjs`

## What Could Go Wrong

- Memory worker failures are retried poorly or become invisible operational debt.
- Memory entries are written under the wrong account or conversation.
- Future chat prompts use a different field contract from the Memory page.
- Memory context cost is omitted from estimates or credit checks.
- Deep memory block ordering drifts after backfill or reprocessing.

## Best Practices To Check

- Async workers should be idempotent, retryable, observable, and bounded.
- Memory context should be account-scoped and included in billing estimates when
  it becomes provider input.
- UI should show the same default fields that the system uses.
- Backfills should preserve logical ordering and avoid duplicate rows.

## Code Review Plan

1. Trace enqueue, claim, complete, fail, retry, backfill, and deep-memory flows.
2. Review account/conversation/message joins for memory job source lookup.
3. Compare Memory page fields to formatted chat memory context.
4. Verify estimate and provider input include the same memory block or reserve.
5. Run Postgres memory smoke and runtime request-shape smoke tests.

## Evidence To Capture

- `npm run db:memory-smoke`
- `npm run runtime-smoke`
- A mismatched-account job negative fixture.
- A memory estimate versus request-body fixture.

## Completion Checklist

- [ ] Source doc claims mapped to implementation.
- [ ] User-visible workflow reviewed.
- [ ] Persistence and ownership boundaries reviewed.
- [ ] Billing, provider, wallet, or chain effects reviewed where applicable.
- [ ] Tests or smoke evidence recorded.
- [ ] Findings written with realistic severity.

## Review Findings

Not started.
