# Hive Secretary Worker

The Hive Secretary worker turns validated Hive Context into a structured
operator report for the Board Manager and Hive surface. It is an implementation
primitive: the Board Manager decides when a refresh is needed, while this worker
does the report generation and stores durable output.

System Status row: `hive_secretary`

## Runtime Boundary

- Worker module: `server/hive-secretary-worker.js`.
- Repository module: `server/repositories/hive-context.js`.
- Prompt: `prompts/hive/hive_secretary_v1.md`.
- Source tables: `hive_secretary_jobs` and `hive_secretary_reports`.
- Trigger source: Hive chat/context changes and Board Manager refresh actions.

## Status Derivation

Green means a completed Secretary report exists within the freshness window and
no due queue item is stale.

Amber means Secretary jobs failed recently.

Red means due pending or processing work has been stale for too long, or no
report has ever completed while the worker is enabled.

## Debug And Repair

Run the focused Hive context smoke and verify the background worker:

```bash
npm run hive-context-smoke
npm run fly:background-guard
```

Inspect the oldest due row in `hive_secretary_jobs`, especially `status`,
`locked_at`, `next_attempt_at`, and `last_error`. Fix the provider or prompt
schema error before retrying. Requeue by moving `next_attempt_at` only after the
root cause is understood.
