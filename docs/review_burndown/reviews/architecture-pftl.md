# Review Plan: PFTL Usage

Source doc: `docs/wiki/architecture/pftl.md`
App doc group: Architecture
App doc slug: `pftl`
Review status: review_ready
Code review complete: no
Owner: unassigned
Last updated: 2026-05-18

## Important App Surfaces

- `server/pftl-pointer.js`, `server/pftl-submit.js`
- `server/pftl-balance.js`, `server/pftl-transactions.js`
- `server/context-history-rpc.js`
- `server/repositories/pftl-cache.js`
- `reference_clients/python/tasknode_pftl/pftl.py`, `pointers.py`, `codec.py`

## What Could Go Wrong

- The app writes or reads PFTL pointer metadata differently from Python.
- Direct RPC reads and cache reads disagree without visible stale/sync status.
- PFTL transaction failure is displayed as product success.
- Pointer memo decoding drops raw data on unsupported or malformed memos.

## Best Practices To Check

- Chain writes should be idempotent where possible and record tx hash, ledger,
  pointer kind, schema, and CID.
- Readers should preserve raw memo data and expose sync/failure state.
- App and reference client should share pointer encoding expectations.
- Request paths should not block on full archive scans.

## Code Review Plan

1. Compare JS and Python pointer encoding/decoding.
2. Review PFTL submit path and result validation.
3. Review balance/transaction reads and cache integration.
4. Check user-visible failure states for RPC outages and stale cache.
5. Run pointer codec and wallet transaction smokes.

## Evidence To Capture

- Python pointer codec tests.
- `npm run wallet-transactions-smoke`
- A PFTL pointer fixture with raw memo and decoded fields.

## Completion Checklist

- [ ] Source doc claims mapped to implementation.
- [ ] User-visible workflow reviewed.
- [ ] Persistence and ownership boundaries reviewed.
- [ ] Billing, provider, wallet, or chain effects reviewed where applicable.
- [ ] Tests or smoke evidence recorded.
- [ ] Findings written with realistic severity.

## Review Findings

Not started.
