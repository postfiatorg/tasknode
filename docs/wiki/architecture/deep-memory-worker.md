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

Deep memory uses the same OpenRouter private memory request contract as turn
memory: ZDR provider routing, `provider.require_parameters = true`,
`reasoning.effort = "none"`, `reasoning.exclude = true`,
`response_format.type = "json_object"`, and usage reporting. The default output
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
