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

## Provider Contract

Network Task Profile jobs run inside the memory worker and use the same
OpenRouter private memory request contract as turn and deep memory:
`provider.zdr = true`, `provider.data_collection = "deny"`, a provider
allowlist in both `provider.order` and `provider.only`,
`provider.require_parameters = true`, `reasoning.effort = "none"`,
`reasoning.exclude = true`, `response_format.type = "json_object"`, and
`usage.include = true`.

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

If the worker reports JSON parse failures, run the request-contract smoke before
requeueing profile jobs. Provider routes must not ignore JSON mode or hidden
reasoning controls.
