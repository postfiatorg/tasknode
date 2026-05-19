# Review Plan: Refine Context

Source doc: `docs/wiki/surfaces/refine-context.md`
App doc group: Surfaces
App doc slug: `refine-context`
Review status: review_ready
Code review complete: no
Owner: unassigned
Last updated: 2026-05-18

## Important App Surfaces

- `src/main.jsx` tool menu entries and context UI
- `src/features/context/context-view-utils.jsx`
- `server/repositories/context.js`
- `server/chat-router.js`
- `shared/context-html.js`

## What Could Go Wrong

- Refinement changes meaning while presenting the output as cleanup.
- Refined output overwrites context without review.
- Context HTML/text conversion loses structure or introduces formatting drift.
- Provider calls are not estimated or billed consistently.

## Best Practices To Check

- "Refine" should be a draft/preview flow with explicit accept.
- Diff or before/after review should be available for meaningful edits.
- Prompt contract should constrain changes to cleanup, structure, and clarity.
- Context normalization should be shared and tested.

## Code Review Plan

1. Determine whether Refine Context is implemented or only documented.
2. Trace any provider call and context write path.
3. Review prompt/input packet for "preserve meaning" constraints.
4. Verify preview, diff, accept, discard, and save behavior.
5. Check tests around context conversion and saved revisions.

## Evidence To Capture

- Context revision before/after.
- Draft or diff screenshot/note if implemented.
- Provider request fixture if implemented.

## Completion Checklist

- [ ] Source doc claims mapped to implementation.
- [ ] User-visible workflow reviewed.
- [ ] Persistence and ownership boundaries reviewed.
- [ ] Billing, provider, wallet, or chain effects reviewed where applicable.
- [ ] Tests or smoke evidence recorded.
- [ ] Findings written with realistic severity.

## Review Findings

Not started.
