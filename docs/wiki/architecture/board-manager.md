# Board Manager

The Board Manager is the leased Hive decision worker. It reads the compact Hive
source packet, asks the configured decision model for one action, validates that
action against the registry, and writes durable run/action evidence before any
board mutation is considered complete.

System Status row: `board_manager`

## Runtime Boundary

- Process: Fly `board-manager` process group.
- Entrypoint: `npm run start:board-manager`.
- Primary scripts: `scripts/board-manager-worker.mjs`,
  `scripts/board-manager-model-exec.mjs`, and
  `scripts/board-manager-ops.mjs`.
- Source tables: `board_manager_scopes`, `board_manager_runs`,
  `board_manager_jobs`, `board_manager_leases`, and
  `board_manager_action_results`.
- Current Hive action results are rendered in the Hive surface as inspectable
  agent activity.

## Status Derivation

Green means the `global_hive` scope is enabled and the latest completed run is
fresh for the configured cadence. A fresh running run is also green.

Amber means failed Board Manager jobs were updated inside the recent failure
window. Historical failed jobs remain in counts for audit but do not keep the
row amber forever.

Red means the scope is missing, paused, disabled, stale beyond cadence, the
latest run failed, or a running run is stale.

## Debug And Repair

Start with the scheduler and Fly process state:

```bash
npm run board-manager:ops -- status
npm run fly:board-guard
fly status -a tasknodeofficial-dev
```

If the scope is paused, resume it deliberately:

```bash
npm run board-manager:ops -- resume --reason "operator recovery"
npm run board-manager:ops -- enqueue --reason "operator recovery run"
```

Inspect `board_manager_jobs.last_error`, `board_manager_runs.error`, provider
secrets, and action-hook errors before retrying. Do not manually mutate Hive
project rows while the Board Manager scope is enabled unless the repair is a
bounded data fix with a recorded reason.
