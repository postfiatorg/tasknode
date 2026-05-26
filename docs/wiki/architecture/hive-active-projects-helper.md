# Hive Active Projects Helper

The Hive Active Projects helper derives the current active project set from the
latest Hive Secretary report and project registry. It keeps the Hive board
focused without deleting recoverable project history.

System Status row: `hive_active_projects`

## Runtime Boundary

- Worker module: `server/hive-active-projects-worker.js`.
- Prompt: `prompts/hive/hive_active_projects_v1.md`.
- Source tables: `hive_project_planning_jobs`,
  `hive_project_generations`, project registry tables, and latest Secretary
  report rows.
- Related repair script: `scripts/repair-hive-project-rollups.mjs`.

## Status Derivation

Green means the latest project generation is fresh and no due project-planning
job is stale.

Amber means project-planning jobs failed recently.

Red means the project-planning queue is stale or the enabled helper has no
completed generation.

## Debug And Repair

Run the project planning smoke and rollup repair when the generated read model
is wrong:

```bash
npm run hive-project-planning-smoke
npm run hive-project-rollup-repair
```

Inspect `hive_project_planning_jobs.last_error` before requeueing. If worker
health is green but the board looks wrong, repair project rollups instead of
forcing a new generation. Board Manager archives must remain reversible unless
an explicit operator lock says otherwise.
