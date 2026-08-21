# Deep Memory Worker

The Deep Memory worker consolidates repeated turn memory and account activity
into longer-lived account memory. It is the durable background context used by
chat and routing systems when a signed-in user has enough history.

System Status row: `deep_memory`

## Runtime Boundary

- Source tables: `chat_deep_memory_jobs` and deep memory entry tables.
- Prompt: `prompts/memory/deep_memory_v1.md`.
- Backfill script: `scripts/memory-backfill.mjs`.
- Runtime smoke: `scripts/chat-memory-postgres-smoke.mjs`.
- Request-contract smoke: `scripts/chat-memory-worker-request-smoke.mjs`.

## Provider Contract

Deep memory uses the shared Ambient `fast_text` memory request contract, which
defaults to `deepseek/deepseek-v4-flash-0731`: reasoning is disabled,
structured JSON output is required, and usage is reported. The default output
cap is `TASKNODE_DEEP_MEMORY_MAX_TOKENS` or `12000`, with a floor of `3500`.
The contract is intentionally JSON-first compression, not reasoning chat.

## Status Derivation

Green means deep memory jobs complete and no due pending or processing job is
stale.

Amber means recently failed deep memory jobs exist.

Red means the deep memory queue is stale.

## Debug And Repair

Run memory smoke and bounded backfill:

```bash
npm run db:memory-smoke
npm run memory:backfill
```

If a row is `processing` with `locked_at IS NULL`, the claim path should recover
it automatically. If it does not, inspect the deep-memory claim function before
manual SQL.

If a failed row reports invalid JSON, run the request-contract smoke before
requeueing. Deep-memory retries should not proceed through a provider route that
can ignore JSON mode or hidden-reasoning controls.

If the Memory page shows Recent Memory capped at 36, do not assume memory is
stuck. The page displays the latest 36 turn-memory rows, while the API also
returns stored totals. Check `counts.turnMemoryTotal` from `GET /api/memory` or
query `chat_memory_entries` by account and `kind = 'turn_memory'`.

If `chat_deep_memory_jobs` rows are `completed` but the Memory page has no Deep
Memory, the visible output rows are missing. This happened on June 4, 2026 when
Deep Memory could be cleared from `chat_memory_entries` while the completed job
rows remained in `chat_deep_memory_jobs`. Backfill then skipped the blocks
because the jobs still looked complete. The repair path now treats a completed or
failed deep-memory job without a matching `deep_memory` entry as incomplete and
requeues it.

If a repaired deep-memory job fails with `deep_memory_job_source_incomplete`,
inspect its `source_entry_ids`. Old snapshots can reference turn-memory rows that
were deleted after the snapshot was created. When no deep-memory output row
exists, repair refreshes that stale snapshot from the current 36-row block before
requeueing. Do not refresh a snapshot for a block that already has a
`deep_memory` entry; existing output rows preserve the original source contract.
