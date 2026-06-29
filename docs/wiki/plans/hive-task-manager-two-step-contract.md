# Hive Task Manager Two-Step Contract

Generated: 2026-06-29

## Goal

Create a narrow Task Manager that can generate Network Tasks without reviving
the broad Board Manager action loop. The Task Manager's only live action is to
queue one guarded Network Task generation job.

## Cadence And Model

- Cadence: every 5 minutes.
- Model: `z-ai/glm-5.2`.
- Reasoning effort: `high`.
- Prompt: `prompts/hive/task_manager_selection_v1.md`.
- Worker: `server/hive-task-manager-worker.js` in the `worker-hive` process.

## Step 1: Board And Operator Selection

The source packet narrows choices before the model runs:

- active boards only;
- live Network Task state;
- latest Hive reports, including executive, Hive Intelligence, and Board
  Manager Planning;
- contributor badge eligibility;
- capacity checks, so selected operators do not already have an outstanding
  Network Task or pending Network Task generation job;
- user memory/context;
- recent refused tasks, including refusal outcome text when available;
- recent rewarded tasks;
- board packet and operator packet.

Only operators in `eligibleSelectionPool` can receive a Network Task. Profile
text, prior rewards, point-person status, or wallet history cannot create
eligibility without a verified contributor badge.

## Step 2: Task Generation

After the model selects one board/operator pair, deterministic guardrails
re-check:

- the board is still active;
- the operator is still in the eligible pool;
- the selected badge and work type match the operator's verified badges;
- the reward does not exceed the badge cap;
- the task intent is not duplicative of outstanding, pending, or recent
  terminal Network Task state.

Only then does the system translate the selection into the existing
`initiate_network_task` allocation path. The task-generation worker receives the
Task Manager selection, board packet, and operator packet and writes the actual
Network Task card through `prompts/task_engine/taskgen_network_v1.md`.
