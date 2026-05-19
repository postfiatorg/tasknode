# Review Plan: Task Async Engine

Source doc: `docs/wiki/architecture/task-async-engine.md`
App doc group: Architecture
App doc slug: `task-async-engine`
Review status: review_ready
Code review complete: no
Owner: unassigned
Last updated: 2026-05-18

## Important App Surfaces

- `reference_clients/python/tasknode_pftl/tx_queue.py`
- `reference_clients/python/tasknode_pftl/scenarios/multi_wallet_async_demo.py`
- `server/repositories/tasks.js`
- Future JS worker/queue code, if implemented
- PFTL submit and cache repositories

## What Could Go Wrong

- Multiple wallet transactions are attempted concurrently from the same wallet.
- Worker retries duplicate PFTL events or rewards.
- UX shows pending task state without durable correlation IDs.
- Authority/allocation wallet assignment is not reproducible.
- Demo-only queue behavior is mistaken for production worker support.

## Best Practices To Check

- Each signing wallet should have serialized transaction ownership.
- Jobs should be idempotent, resumable, and correlated to request/task IDs.
- Worker state should expose pending, submitting, confirmed, failed, and retrying.
- Wallet sharding and funding rules should be explicit.

## Code Review Plan

1. Review Python queue and multi-wallet demo against the architecture doc.
2. Identify which async-engine pieces exist only in reference client.
3. Review correlation metadata from request mode to task projection.
4. Check duplicate submit and retry behavior in tests or fixtures.
5. Record production gaps separately from reference demo success.

## Evidence To Capture

- Python multi-wallet async demo tests.
- Queue state fixture with per-wallet serialization.
- Request/task correlation IDs in receipt or app state.

## Completion Checklist

- [ ] Source doc claims mapped to implementation.
- [ ] User-visible workflow reviewed.
- [ ] Persistence and ownership boundaries reviewed.
- [ ] Billing, provider, wallet, or chain effects reviewed where applicable.
- [ ] Tests or smoke evidence recorded.
- [ ] Findings written with realistic severity.

## Review Findings

Not started.
