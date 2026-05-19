# Review Plan: Brainstorming Context

Source doc: `docs/wiki/surfaces/brainstorming-context.md`
App doc group: Surfaces
App doc slug: `brainstorming-context`
Review status: review_ready
Code review complete: no
Owner: unassigned
Last updated: 2026-05-18

## Important App Surfaces

- `src/main.jsx` tool menu entries
- `src/features/context/context-view-utils.jsx`
- `server/chat-router.js`
- `server/repositories/context.js`
- `server/repositories/chat-memory.js`

## What Could Go Wrong

- Brainstorming writes to saved context instead of producing a draft.
- Suggestions are presented as facts rather than model-generated options.
- Empty context produces filler instead of clarifying questions.
- Billing or provider behavior differs from ordinary chat without disclosure.

## Best Practices To Check

- Draft-producing tools should separate read-only suggestion state from saved
  context state.
- Accept/save should be explicit and reversible where possible.
- Tool inputs should be bounded and account-scoped.
- Output should be labeled as suggestions when confidence is not anchored.

## Code Review Plan

1. Verify whether the surface is placeholder, chat mode, or dedicated tool.
2. Trace any context write path reachable from the tool.
3. Review how current context and memory are loaded and bounded.
4. Check user controls for accept, discard, and save.
5. Record implementation gap or doc drift if no tool runner exists.

## Evidence To Capture

- UI/menu state.
- Request/response fixture if implemented.
- Context revision before/after a brainstorming action.

## Completion Checklist

- [ ] Source doc claims mapped to implementation.
- [ ] User-visible workflow reviewed.
- [ ] Persistence and ownership boundaries reviewed.
- [ ] Billing, provider, wallet, or chain effects reviewed where applicable.
- [ ] Tests or smoke evidence recorded.
- [ ] Findings written with realistic severity.

## Review Findings

Not started.
