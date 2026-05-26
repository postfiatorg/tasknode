# Turn Memory Worker

The Turn Memory worker summarizes individual chat turns into compact memory
entries. It keeps chat grounding useful without forcing every future request to
read full transcripts.

System Status row: `chat_turn_memory`

## Runtime Boundary

- Source tables: `chat_memory_jobs` and `chat_memory_entries`.
- Prompt: `prompts/memory/chat_memory_v1.md`.
- Backfill script: `scripts/memory-backfill.mjs`.
- Runtime smoke: `scripts/chat-memory-postgres-smoke.mjs`.

## Status Derivation

Green means turn memory entries are being completed and no due memory job is
stale.

Amber means recently failed memory jobs exist.

Red means due pending or processing jobs are stale.

## Debug And Repair

Run memory smoke and bounded backfill:

```bash
npm run db:memory-smoke
npm run memory:backfill
```

Inspect `chat_memory_jobs.status`, `locked_at`, `next_attempt_at`, and
`last_error`. Release stale locks only when the worker is stopped or the lock is
older than the recovery threshold.
