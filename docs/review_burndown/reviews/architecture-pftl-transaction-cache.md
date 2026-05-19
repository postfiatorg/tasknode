# Review Plan: PFTL Transaction Cache

Source doc: `docs/wiki/architecture/pftl-transaction-cache.md`
App doc group: Architecture
App doc slug: `pftl-transaction-cache`
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
- `docs/wiki/plans/pftl-transaction-cache-milestone.md`

## What Could Go Wrong

- Cache schema cannot represent one transaction indexed for multiple wallets.
- Pointer decode failures lose raw memo data.
- Request paths still perform archive scans after the cache exists.
- Stale cache state is rendered as empty or complete data.
- Wallet registration misses linked, system, allocation, or authority wallets.

## Best Practices To Check

- Transaction mirrors should be idempotent and normalize tx, wallet index, and
  decoded memo tables separately.
- Cache consumers should expose `syncing`, `stale`, and `archive_incomplete`
  states.
- Workers should use resumable checkpoints and duplicate-job suppression.
- Raw transaction retention should be deliberate.

## Code Review Plan

1. Review migration schema against proposed tables and indexes.
2. Review repository upserts for idempotency and multi-wallet indexing.
3. Check pointer memo decode behavior and raw preservation.
4. Trace wallet feed, context history, and task replay consumers.
5. Identify remaining direct RPC request paths and whether they are intentional.

## Evidence To Capture

- PFTL cache repository smoke.
- Fixture upsert of one tx for multiple wallets.
- Pointer decode failure fixture.
- Wallet/context read from cache fixture.

## Completion Checklist

- [ ] Source doc claims mapped to implementation.
- [ ] User-visible workflow reviewed.
- [ ] Persistence and ownership boundaries reviewed.
- [ ] Billing, provider, wallet, or chain effects reviewed where applicable.
- [ ] Tests or smoke evidence recorded.
- [ ] Findings written with realistic severity.

## Review Findings

Not started.
