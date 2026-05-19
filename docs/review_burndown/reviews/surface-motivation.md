# Review Plan: Motivation

Source doc: `docs/wiki/surfaces/motivation.md`
App doc group: Surfaces
App doc slug: `motivation`
Review status: review_ready
Code review complete: no
Owner: unassigned
Last updated: 2026-05-18

## Important App Surfaces

- `src/main.jsx` sidebar/tool menu entries
- Future typed tool runner, if implemented
- `server/chat-router.js`
- `server/repositories/context.js`, `server/repositories/chat-memory.js`
- Billing and usage paths if Motivation uses providers

## What Could Go Wrong

- The tool is visible but not wired to a real route or result surface.
- Motivation output fabricates personal facts because context/memory are missing
  or not bounded.
- Provider calls bypass normal billing or confirmation behavior.
- Output is saved as context or task input without explicit user action.

## Best Practices To Check

- Specialized tools should reuse the same provider, billing, and account
  boundaries as chat unless explicitly documented otherwise.
- Tool inputs should be typed and inspectable.
- No context or task mutation should happen without explicit user action.
- Empty context should produce a useful fallback, not false personalization.

## Code Review Plan

1. Verify whether Motivation is currently a placeholder or executable feature.
2. If executable, trace provider request, billing, and output persistence.
3. Confirm context/memory/task inputs are account-scoped and bounded.
4. Review empty-context and provider-failure UX.
5. Record doc drift if the visible doc overstates implementation.

## Evidence To Capture

- UI route/menu evidence.
- Provider request fixture if implemented.
- Billing record if implemented.
- Empty-context behavior note.

## Completion Checklist

- [ ] Source doc claims mapped to implementation.
- [ ] User-visible workflow reviewed.
- [ ] Persistence and ownership boundaries reviewed.
- [ ] Billing, provider, wallet, or chain effects reviewed where applicable.
- [ ] Tests or smoke evidence recorded.
- [ ] Findings written with realistic severity.

## Review Findings

Not started.
