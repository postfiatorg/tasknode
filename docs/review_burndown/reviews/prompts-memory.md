# Review Plan: Memory Prompts

Source docs: `prompts/memory/chat_memory_v1.md`, `prompts/memory/deep_memory_v1.md`
App doc group: Prompts
App doc slug: `prompts-memory`
Review status: review_ready
Code review complete: no
Owner: unassigned
Last updated: 2026-05-18

## Important App Surfaces

- `server/chat-memory-worker.js`
- `server/repositories/chat-memory.js`
- `scripts/chat-memory-postgres-smoke.mjs`
- `scripts/memory-backfill.mjs`

## What Could Go Wrong

- Worker prompt text differs from prompt files in Help.
- JSON parsing accepts malformed or incomplete memory summaries.
- Prompt output fields do not match database field limits.
- Deep memory summarization orders or selects the wrong block.

## Best Practices To Check

- Worker prompts should be versioned and source-controlled.
- Model output should be parsed conservatively and validated before persistence.
- Field limits should be enforced before insert/update.
- Backfill/deep-memory jobs should be idempotent and observable.

## Code Review Plan

1. Compare memory prompt files to worker system prompts.
2. Review JSON parsing, validation, field clipping, and retry behavior.
3. Check prompt version/model/provider recording in memory entries.
4. Run memory Postgres smoke and inspect deep-memory block ordering.

## Evidence To Capture

- `npm run db:memory-smoke`
- Failed JSON parse fixture.
- Completed memory row showing prompt version and bounded fields.

## Completion Checklist

- [ ] Source doc claims mapped to implementation.
- [ ] User-visible workflow reviewed.
- [ ] Persistence and ownership boundaries reviewed.
- [ ] Billing, provider, wallet, or chain effects reviewed where applicable.
- [ ] Tests or smoke evidence recorded.
- [ ] Findings written with realistic severity.

## Review Findings

Not started.
