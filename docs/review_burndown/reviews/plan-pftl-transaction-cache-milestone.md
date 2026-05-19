# Review Plan: PFTL Transaction Cache Milestone

Source doc: `docs/wiki/plans/pftl-transaction-cache-milestone.md`
App doc group: Plans
App doc slug: `pftl-transaction-cache-milestone`
Review status: review_ready
Code review complete: no
Owner: unassigned
Last updated: 2026-05-18

## Important App Surfaces

- `server/db/migrations/007_pftl_transaction_cache.sql`
- `server/repositories/pftl-cache.js`
- `server/pftl-transactions.js`
- `server/context-history-rpc.js`
- `server/repositories/tasks.js`
- Future sync workers and WSS/polling watchers

## What Could Go Wrong

- Phase status in docs does not match implemented schema/repository/workers.
- Cache-first reads are claimed before request paths actually use the cache.
- Empty cache is rendered as complete history instead of syncing/stale state.
- Sync worker failures corrupt cache rows or lose last-known checkpoints.

## Best Practices To Check

- Milestone reviews should verify each phase independently.
- Cache reads should degrade with explicit sync state.
- Upserts should be idempotent and preserve raw transaction/memo data.
- Workers should checkpoint, retry, suppress duplicates, and expose health.

## Code Review Plan

1. Review Phase 1 schema/repository completeness.
2. Identify which sync-worker phases are implemented versus planned.
3. Trace wallet activity, context history, and task replay consumers.
4. Verify empty/stale cache user-visible behavior.
5. Record phase-by-phase findings and not-ready gates.

## Evidence To Capture

- PFTL cache migration and repository smoke.
- Wallet feed cache-read fixture.
- Context pointer cache-read fixture.
- Sync health output if implemented.

## Completion Checklist

- [ ] Source doc claims mapped to implementation.
- [ ] User-visible workflow reviewed.
- [ ] Persistence and ownership boundaries reviewed.
- [ ] Billing, provider, wallet, or chain effects reviewed where applicable.
- [ ] Tests or smoke evidence recorded.
- [ ] Findings written with realistic severity.

## Review Findings

Not started.
