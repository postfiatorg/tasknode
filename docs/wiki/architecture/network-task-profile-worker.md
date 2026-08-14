# Network Task Profile Worker

The Network Task Profile worker builds compact routing profiles for users. Board
Manager and Network Task allocation use these profiles instead of raw private
chat, context, or memory bundles.

System Status row: `network_task_profile`

## Runtime Boundary

- Source tables: `network_task_profile_jobs` and `network_task_profiles`.
- Prompt: `prompts/memory/network_task_profile_v2.md`.
- Smoke script: `scripts/network-task-profile-smoke.mjs`.
- Request-contract smoke: `scripts/chat-memory-worker-request-smoke.mjs`.
- Runtime consumer: Board Manager source packet and Network Task routing.
- Auto-queue trigger: `server/repositories/tasks.js::importTaskReplayReceipt`
  queues a profile job when a task projection reaches the rewarded tab with
  positive `reward_actual_pft` and the account has at least two positive task
  rewards. The memory worker also backfills eligible accounts with no current
  profile/job.

## Provider Contract

Network Task Profile jobs run inside the memory worker through Ambient's pinned
DeepSeek Flash `fast_text` capability. The request disables hidden reasoning
and requires JSON output with `reasoning.effort = "none"`,
`reasoning.exclude = true`, and `response_format.type = "json_object"`.

The default output cap is `TASKNODE_NETWORK_TASK_PROFILE_MAX_TOKENS` or `1800`,
with a floor of `900`.

## Status Derivation

Green means compact routing profiles are completing and the queue is not stale.

Amber means recently failed profile jobs exist.

Red means due profile work is stale or no completed profile exists when enabled.

## Debug And Repair

Run the profile smoke and verify workers:

```bash
npm run network-task-profile-smoke
npm run fly:background-guard
```

Inspect profile job source packet errors, provider config, and
`network_task_profiles` digest state. Do not route a Network Task from a stale
or invented profile packet.

If a user has at least two positive task rewards but no report, inspect
`task_projections.reward_actual_pft`, `network_task_profile_jobs`, and the
memory worker return fields `networkProfileSeeded` and
`networkProfileSeedFailed`. Opening Memory is not required for the normal path;
it is only a manual refresh/repair surface.

If the worker reports JSON parse failures, run the request-contract smoke before
requeueing profile jobs. Provider routes must not ignore JSON mode or hidden
reasoning controls.
