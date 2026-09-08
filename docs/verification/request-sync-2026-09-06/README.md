# Failed request dismissal and task sync verification — 2026-09-06

The reported “comprehensive review of IBKR” resurfaced as an old failed request receipt. Its later successful task remained completed. Separately, five historical cache hydration failures produced a live sync warning despite their exact events already being recorded in the current task projections.

## Investigation

Identity was resolved from `recommended_connection_profiles`, then checked against `account_provider_identities`, `pftl_sync_wallets`, and owned task records on September 6, 2026, between 11:45 and 12:07 UTC. The public handle is `georgl0nggamma` (zero); the active task wallet is `r4RPpeS2kUE8BjY9LvKbptW8PQVHhVWghS`. Private provider identifiers and request contents are omitted.

- Failed request `req_40b97b66-3fa7-4315-a30d-8b4bac3da89d` was created July 27 at 15:22 UTC and failed with `taskgen_provider_timeout`. It never generated a task. Removing the old 24-hour failed-receipt visibility cutoff exposed this unresolved attempt again.
- Later request `req_80256cda-d50e-4125-82e9-023f6567a69f` generated `task_4045d2d9653a0671f1a7e1c7d0dda7aa`, “Review Trading Directories and Draft Context Patch.” It was rewarded **3.20 PFT** on July 29. Reward transaction: `C44F04425EA7429E2081877818A2B35702D5E0DD4E46ECBF1AE53CB2EE97EA98`.
- A production database read through `listTaskState` at **11:54:58 UTC** returned `reducer_attention`, five failures, zero pending reducers, zero processing reducers, and zero indexing lag. All five failed cache rows had an exact matching transaction and CID in both the owned canonical event store and current projection. These were already-applied reward events.

## Repair

Failed requests now expose **Dismiss** beside Retry. Dismissal requires the authenticated owner and the expected attempt number, applies only to a failed request without a generated task, and preserves its receipt and original error. Repeated or stale clicks cannot close a newer attempt, an active worker, or an existing task. The API uses the existing `cancelled` terminal status and displays “Dismissed.” Request mutations invalidate cached app state.

Live sync health now excludes a failed hydration attempt only when its account, wallet, task, transaction, and CID match both a canonical event and the current nonempty projection. Unmatched failures still warn. Historical failure rows remain available for audit. Request freshness and handoff selection use timestamps rather than the unresolved-first queue display order.

The obsolete reported receipt was dismissed at **12:07:00 UTC** using the same guarded repository operation, after checking the later request's rewarded task. The original timeout and completed task were preserved.

## Validation

- `task-sync-reconciliation-smoke.mjs`: real isolated PostgreSQL; applied failure excluded; six mismatched or insufficient-proof cases continue to warn; all seven audit rows preserved; chronological handoff checked.
- `task-request-receipts-smoke.mjs`: owner and account fences, stale-attempt fencing, dismissal replay, preservation of active/generated requests, existing concurrent retry and pagination regressions.
- `task-request-dismiss-browser-smoke.mjs`: actual React queue in Chrome with synthetic HTTP responses; visible Dismiss button, readable error and retained row after failure, correctly fenced retry, and queue removal after success. See [browser evidence](browser-dismiss.json).
- `task-visible-state-smoke.mjs`, build, lint, format, whitespace checks, inference regex audit, API reference inventory (169 policies), and public Help boundary (26 sources) passed.
- Wiki task lifecycle guidance and embedded Tasks Help summary were updated.

Browser evidence covers the rendered component with controlled responses; it does not impersonate the user's authenticated browser session.

## Deployment and production proof

`PATH=/home/pfrpc/.fly/bin:$PATH npm run fly:deploy:prod` completed successfully.
Fly release **v707**, created at **12:07:44 UTC**, has status `complete`.
Image: `registry.fly.io/tasknodeofficial-dev:deployment-01M1V9TX55WN0159GEP5TV0KZ9`.
Migration registration, deployment preflight, rollout checks, and all eight
background worker group guards passed.

A read from the **deployed web machine** at **12:09:11 UTC** verified:

- The account's 139 projections return `ready`, with zero failed, pending, or processing reducers and zero indexing lag.
- The obsolete receipt is inactive and labelled `Dismissed`; its original provider timeout remains readable.
- The successful review remains rewarded at 3.20 PFT with the original transaction.
- All five historical failed cache rows remain in the database.

See [production state evidence](production-state.json). The public `/health`,
homepage, and deployed JavaScript asset returned HTTP 200 at **12:10:01 UTC**;
see [HTTP evidence](public-http.json).

This verifies the reported request and the reproduced sync warning. It does not
claim that every possible sync issue in another session has been reproduced.
