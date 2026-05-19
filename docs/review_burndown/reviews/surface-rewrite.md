# Review Plan: Rewrite

Source doc: `docs/wiki/surfaces/rewrite.md`
App doc group: Surfaces
App doc slug: `rewrite`
Review status: review_ready
Code review complete: no
Owner: unassigned
Last updated: 2026-05-18

## Important App Surfaces

- `src/main.jsx` tool menu entries
- Future rewrite tool runner, if implemented
- `server/chat-router.js`
- Any persistence path for saved rewrite results

## What Could Go Wrong

- Rewrite output is saved back into context, chat, or task state unexpectedly.
- The tool ignores requested style/constraints or changes factual content.
- Large input is sent without bounds or clear billing.
- Placeholder UI makes the feature look shipped when it is not.

## Best Practices To Check

- Rewrite tools should be explicit about input, output, and non-goals.
- No persistent mutation should happen without user confirmation.
- Large text inputs should be bounded and estimated.
- Output should preserve meaning unless the user explicitly asks otherwise.

## Code Review Plan

1. Verify whether Rewrite is visible-only or executable.
2. Trace provider execution, input bounds, and billing if implemented.
3. Check persistence behavior and user confirmation.
4. Review empty/large input UX.
5. Record doc drift if the visible page overstates implementation.

## Evidence To Capture

- UI/menu state.
- Provider request fixture if implemented.
- Large-input estimate or rejection behavior.

## Completion Checklist

- [ ] Source doc claims mapped to implementation.
- [ ] User-visible workflow reviewed.
- [ ] Persistence and ownership boundaries reviewed.
- [ ] Billing, provider, wallet, or chain effects reviewed where applicable.
- [ ] Tests or smoke evidence recorded.
- [ ] Findings written with realistic severity.

## Review Findings

Not started.
