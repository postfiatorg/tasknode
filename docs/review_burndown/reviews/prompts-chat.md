# Review Plan: Chat Prompts

Source docs: `prompts/chat/task_node_instructions_v1.md`, `prompts/chat/account_memory_context_v1.md`, `prompts/chat/account_tasks_context_v1.md`
App doc group: Prompts
App doc slug: `prompts-chat`
Review status: review_ready
Code review complete: no
Owner: unassigned
Last updated: 2026-05-18

## Important App Surfaces

- `server/chat-memory-context.js`
- `server/chat-task-context.js`
- `server/chat-router.js`
- `server/chat-estimate.js`
- `scripts/runtime-store-smoke.mjs`

## What Could Go Wrong

- Runtime instructions drift from prompt files shown in Help.
- Memory/task context fields included in provider input differ from estimate
  fields.
- Task context claims mutations or rewards happened when it is only a cached
  projection.
- Prompt docs omit provider-specific placement differences.

## Best Practices To Check

- Prompt source, version, and runtime call site should be auditable.
- Context blocks should be bounded, typed, and represented in estimates.
- Prompt tests should assert key shape, not exact prose only.
- Product action claims should require actual app-side action results.

## Code Review Plan

1. Compare prompt files to `taskNodeInstructions`, memory formatting, and task
   formatting.
2. Review estimate token accounting for memory and task context.
3. Check provider request fixtures for OpenAI and OpenRouter.
4. Verify task context is advisory and not treated as mutation state.

## Evidence To Capture

- `npm run runtime-smoke`
- Request fixtures showing memory and task context.
- Prompt digest/version record if available.

## Completion Checklist

- [ ] Source doc claims mapped to implementation.
- [ ] User-visible workflow reviewed.
- [ ] Persistence and ownership boundaries reviewed.
- [ ] Billing, provider, wallet, or chain effects reviewed where applicable.
- [ ] Tests or smoke evidence recorded.
- [ ] Findings written with realistic severity.

## Review Findings

Not started.
