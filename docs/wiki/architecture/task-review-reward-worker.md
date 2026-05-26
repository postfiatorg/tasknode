# Task Review And Reward Worker

The Task Review and Reward worker advances submitted tasks through verification
and reward decisions. It reads canonical task projection state and emits the
next allowed lifecycle action only when the protocol state permits it.

System Status row: `task_review`

## Runtime Boundary

- Primary state: `task_projections` and `task_events`.
- Related prompts: `prompts/task_engine/verification_request_v1.md` and
  `prompts/task_engine/reward_scoring_v1.md`.
- Repair scripts: `scripts/task-replay-repair.mjs` and
  `scripts/data-architecture-audit.mjs`.
- Canonical source: signed PFTL task lifecycle events.

## Status Derivation

Green means submitted and verification-response-submitted tasks are not stale
and the worker has recently progressed review or reward states.

Amber is not used for this row today.

Red means submitted or verification-response-submitted projections have been
waiting beyond the review threshold.

## Debug And Repair

Repair projection drift before judging worker logic:

```bash
npm run task-replay-repair -- --task-id=<task_id> --apply
npm run data-architecture-audit
```

If projection is current but review is stalled, inspect worker logs, provider
config, reward seed config, and the latest `task_events`. Do not issue a reward
from a Hive or UI row; reward state must be backed by signed lifecycle evidence.
