# Review Plan: Task Node Wiki

Source doc: `docs/wiki/index.md`
App doc group: Start
App doc slug: `start`
Review status: review_ready
Code review complete: no
Owner: unassigned
Last updated: 2026-05-18

## Important App Surfaces

- `src/features/docs/DocsView.jsx` and `src/features/docs/docs-content.js`
- `src/main.jsx` app navigation and feature mounting
- `server/chat-router.js`, `server/repositories/*`, `server/pftl-*`, `server/context-*`
- `reference_clients/python/tasknode_pftl/`

## What Could Go Wrong

- The Help mental model says PFTL is canonical while UI/API behavior treats
  Postgres-only cache state as final.
- A visible surface claims wallet, task, memory, or context behavior that is not
  actually reachable from the app.
- App docs reference source files or concepts that have moved and now mislead
  reviewers.

## Best Practices To Check

- Public docs distinguish shipped behavior, cache behavior, and planned protocol
  behavior.
- User-facing surfaces expose honest empty, syncing, stale, and unavailable
  states.
- Canonical protocol records and convenience caches have separate ownership and
  tests.

## Code Review Plan

1. Compare the product map to current routes and sidebar navigation.
2. Verify each canonical rule has a code boundary or visible "not ready" state.
3. Check that listed primary code references still exist and are active.
4. Review whether PFTL/caches are described consistently in feature-specific docs.
5. Record mismatches as doc drift or implementation gaps.

## Evidence To Capture

- Route smoke output for visible surfaces.
- Links to the implementation files backing each canonical rule.
- Screenshots or notes for surfaces that are visible but incomplete.

## Completion Checklist

- [ ] Source doc claims mapped to implementation.
- [ ] User-visible workflow reviewed.
- [ ] Persistence and ownership boundaries reviewed.
- [ ] Billing, provider, wallet, or chain effects reviewed where applicable.
- [ ] Tests or smoke evidence recorded.
- [ ] Findings written with realistic severity.

## Review Findings

Not started.
