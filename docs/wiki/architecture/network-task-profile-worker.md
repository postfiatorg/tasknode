# Network Task Profile Worker

The Network Task Profile worker builds compact routing profiles for users. Board
Manager and Network Task allocation use these profiles instead of raw private
chat, context, or memory bundles.

System Status row: `network_task_profile`

## Runtime Boundary

- Source tables: `network_task_profile_jobs` and `network_task_profiles`.
- Prompt: `prompts/memory/network_task_profile_v2.md`.
- Smoke script: `scripts/network-task-profile-smoke.mjs`.
- Runtime consumer: Board Manager source packet and Network Task routing.

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
