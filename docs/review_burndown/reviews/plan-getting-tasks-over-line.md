# Review Plan: Getting Tasks Over The Line

Source doc: `docs/wiki/plans/getting-tasks-over-line.md`
App doc group: Plans
App doc slug: `getting-tasks-over-line`
Review status: review_ready
Code review complete: no
Owner: unassigned
Last updated: 2026-05-18

## Important App Surfaces

- `src/main.jsx` task request mode and chat composer
- `server/task-request-intent.js`
- `server/repositories/tasks.js`
- `server/chat-task-context.js`
- `reference_clients/python/tasknode_pftl/app_data.py`
- `reference_clients/python/tasknode_pftl/scenarios/app_request_lifecycle.py`
- `reference_clients/python/tasknode_pftl/scenarios/full_lifecycle.py`

## What Could Go Wrong

- Request-mode chat metadata cannot reconcile pending UI with chain-backed task
  events.
- Real app data bundle differs from the Python task request bundle.
- Seed handling or receipt generation prints private material.
- Projection cache cannot rebuild task state from the produced PFTL/IPFS records.
- Reward wallet and authority wallet assumptions are not represented in code.

## Best Practices To Check

- Task request bundles should be typed, bounded, reproducible, and client-neutral.
- Pending UX should carry correlation IDs but not become canonical state.
- Secrets must remain outside docs, receipts, prompts, logs, and commits.
- Replay receipts should include only public wallet addresses, CIDs, tx hashes,
  task IDs, and final projections.

## Code Review Plan

1. Review request-mode intent detection and composer correlation metadata.
2. Compare app data bundle construction with Python `app_data.py`.
3. Review seed handling and receipt redaction rules.
4. Run app request lifecycle or full lifecycle fixtures where available.
5. Verify task projection import/rebuild path from receipts.

## Evidence To Capture

- App request bundle fixture for `task_sample`.
- Python app request lifecycle test output.
- Receipt proving no seed/private key material is printed.
- Task projection import smoke.

## Completion Checklist

- [ ] Source doc claims mapped to implementation.
- [ ] User-visible workflow reviewed.
- [ ] Persistence and ownership boundaries reviewed.
- [ ] Billing, provider, wallet, or chain effects reviewed where applicable.
- [ ] Tests or smoke evidence recorded.
- [ ] Findings written with realistic severity.

## Review Findings

Not started.
