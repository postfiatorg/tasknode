# Hive Board Professionalism Diagnosis

Date: 2026-05-26

This is the current professional bar for the Hive board and Board Manager. The recent failure was not one bad model choice. It was a product-state boundary failure: the system allowed planning language, model-selected archives, and live execution state to collapse into the same visible board semantics.

## Diagnosis

The board rendered planning artifacts as if they were live work. Labels like "Scoped tasks" or generated task counts suggested real tasks existed when there were no `network_project_task_refs` rows and no matching `task_projections` records. That is unacceptable because it gives the operator a false read of system progress. Planned scope may belong in a project document or backlog field, but it must never be rendered as task rows, routed PFT, or allocated operator load.

The archive path used the wrong lock semantics. `archive_project` is a valid Board Manager action for clearing empty or duplicate project cards from the active board. However, autonomous Board Manager archives must be reversible. They should not set the same `operator_archived` lock used for explicit human or migration cleanup decisions. The old behavior made a model-selected archive look like an operator-final archive, which blocked the planner from resurrecting the durable `task_node` project even when later context still supported Task Node as active work.

The active board accepted cards with no execution evidence. A project with zero live tasks, zero contributors, zero pending Network Task generation, and no explicit operator pin should not remain on the active board. It should be archived, paused, or held in planning/backlog state. Active means there is current work, not merely a plausible project name.

The feed hid operational quality problems behind vague language. "Decision pending" is acceptable only while a job is genuinely running. Provider errors need the actionable error, run id, trigger, and retry status. Completed runs with no selected action should be explicit failures or no-op decisions, not ambiguous board state.

The system relied too much on prompts. Prompt instructions can express intent, but the professional boundary must live in code: repository rollups, action hooks, planner resurrection rules, schema constraints, and regression tests.

## Required Standard

1. Active board counts must be derived from live rows only.
   `Task rows` comes from `network_project_task_refs` joined to `task_projections`. Routed PFT comes from actual routed or rewarded task state. Operator allocation comes from contributor rows or derivable task assignees. Planned fields may be stored, but they are not live counts.

2. Autonomous archives must be soft and reversible.
   Board Manager `archive_project` may set `network_projects.status = archived` and record `agent_archived` metadata. It must not set `operator_archived`, `archive_lock_source`, or other lock metadata. Only explicit operator actions or migrations may set an operator archive lock.

3. Resurrection must be first-class.
   An archived non-locked project can return to active when the planner selects the same durable project id, a project-linked task appears, a pending generation job targets it, a contributor is assigned, or an operator pins/reactivates it. Resurrection should reuse the existing project id instead of creating duplicate Task Node variants.

4. Empty active projects should leave the board.
   If there is no live task movement, no contributor, no pending generation, and no operator pin, the correct action is to archive, pause, or ask for the smallest missing decision. Do not keep empty cards active to make the Hive look populated.

5. The feed must distinguish running, failed, and completed states.
   Running jobs can show pending. Provider failures must show the provider error and retry/defer state. Completed decisions must show the selected action and execution result. A blank selected action is a bug unless explicitly recorded as `do_nothing`.

## Immediate Repair Checklist

- Convert model-selected archive metadata from `operator_archived` to `agent_archived` where appropriate, starting with `task_node`.
- Keep explicit migration/operator archive locks intact for truly rejected generated scoping cards.
- Add a resurrection path for archived, non-locked projects.
- Keep the UI label `Task rows`, never `Scoped tasks`, unless a separate planning-only section is clearly marked as planning.
- Add regression tests for fake-count prevention, model archive reversibility, and `task_node` resurrection.
