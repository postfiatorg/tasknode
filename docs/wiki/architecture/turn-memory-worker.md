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
- Request-contract smoke: `scripts/chat-memory-worker-request-smoke.mjs`.

## Provider Contract

The worker calls OpenRouter Chat Completions through the private memory route in
`server/chat-memory-worker.js`. The request must keep:

- `provider.zdr = true` and `provider.data_collection = "deny"`;
- the configured provider allowlist in both `provider.order` and
  `provider.only`;
- `provider.require_parameters = true`;
- `reasoning.effort = "none"` and `reasoning.exclude = true`;
- `response_format.type = "json_object"`;
- `usage.include = true`.

Turn memory defaults to `TASKNODE_MEMORY_MAX_TOKENS` or `1200`, with a floor of
`900`. This cap is for visible JSON output. Hidden reasoning is disabled so the
model cannot spend the JSON budget on non-visible reasoning tokens and then
return a truncated object.

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

If `last_error` is `memory_summary_invalid_json`, first verify the provider
contract smoke. Then requeue the failed job by setting `status = 'pending'`,
`attempt_count = 0`, `locked_at = NULL`, `last_error = ''`, and
`next_attempt_at = now()`.
