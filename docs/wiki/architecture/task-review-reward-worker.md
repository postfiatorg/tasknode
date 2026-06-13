# Task Review And Reward Worker

The Task Review and Reward worker advances submitted tasks through verification
and reward outcomes. It reads canonical task projection state and emits the
next allowed lifecycle action only when the protocol state permits it.

System Status row: `task_review`

## Runtime Boundary

- Primary state: `task_projections` and `task_events`.
- Publication lock: `task_review_publications`, keyed by `(task_id, worker_name)`.
- Related prompts: `prompts/task_engine/verification_request_v1.md` and
  `prompts/task_engine/reward_scoring_v1.md`.
- Repair scripts: `scripts/task-replay-repair.mjs` and
  `scripts/data-architecture-audit.mjs`.
- Canonical source: signed PFTL task lifecycle events.

Only the production worker should publish verification requests or reward
outcomes by default. Local Docker and ad hoc development servers can read and
reduce PFTL state, but task-review publication is blocked unless
`TASKNODE_TASK_REVIEW_ALLOW_NON_PRODUCTION=true` is explicitly set.

Reward signing in production requires an explicit `TASKNODE_REWARD_SEED`. The
development convenience chain (allocation, authority, service, and faucet seed
fallbacks in `server/production-guards.js::moneySeedFromEnv`) is refused when
`TASKNODE_ENV=production`, so a missing reward seed fails loudly with the
existing seed-missing error code instead of silently signing payouts from a
different wallet. Startup warns when the worker is enabled without its
explicit seed. This
prevents a local database from observing live PFTL task events and emitting a
second terminal reward outcome outside the Fly publication lock.

The local Docker exception is `npm run docker:reward-test`. That profile starts
an explicit reward-test worker with generated local service, authority, and
reward seeds from `.env.local-rewards`. It is allowed to publish local reward
test events, but it must never use Fly/prod authority or reward seeds.

## Idempotency And Duplicate Reward Protection

Idempotency means the same task-review work can be retried, overlapped, or
replayed without creating a second terminal reward outcome or a second economic
PFT payout.
The retry may observe that work already happened, but it must not publish a new
terminal event for the same task and worker lane.

The worker uses `task_review_publications` as the publication lock table. The
lock key is `(task_id, worker_name)`, where the current worker lanes are:

- `verification_request`: publishes the follow-up verification request after an
  initial submission.
- `reward_scoring`: publishes exactly one terminal `pf.reward.v1` review
  outcome.

The claim queries exclude projections that already have matching indexed events
in `task_events`. Immediately before publishing, the worker rehydrates task
detail and checks the timeline again for the events it is about to create:

- `pf.task.update.v1` with transition `verification_requested`;
- `pf.reward.v1`.

For reward scoring, the authority decision and payment are no longer separate
protocol transactions:

1. The worker scores the verification response.
2. It builds a single `pf.reward.v1` payload containing the decision, score,
   reason, task history, and reward amount.
3. If the decision is positive or partial, the reward transaction amount is the
   economic PFT payout.
4. If the decision is zero, the reward transaction amount is one drop and the
   payload records `reward_pft: "0.00"` and `economic_reward_pft: "0.00"`.
5. It records the `pf.reward.v1` CID and transaction in
   `task_review_publications`.

If publication fails after the worker attempts the `pf.reward.v1` transaction,
the publication row remains claimed with error metadata. A retry must resume
from the recorded publication row or the indexed timeline instead of asking the
model to score again or issuing a second reward outcome. Operators should repair
from the recorded CID/transaction references, not from a Hive card or UI
summary.

`TASKNODE_TASK_WORKER_CLAIM_STALE_SECONDS` controls stale claim recovery. The
deployment value is 900 seconds and the code floor is 300 seconds because
review/scoring can include provider calls, IPFS writes, PFTL publication, and
projection refresh. A short stale window can reclaim the same task while the
first transaction is still settling.

## Multi-Machine And Local Boundaries

Multiple Fly machines are safe only when they share the same Postgres database,
the same `task_review_publications` lock domain, and the same authority/reward
key set. In that shape, an active worker and a standby worker may overlap or
recover stale claims without creating duplicate protocol events.

The unsafe shape is two independent databases watching the same PFTL task
universe while using the same production authority or reward seeds. A local
Docker worker and the Fly worker cannot coordinate through
`task_review_publications` if their Postgres databases are different. That is
how duplicate reward outcome pointer events can happen even though each worker
is internally behaving consistently.

Default local Docker is therefore web/API only for task review publication:

- `TASKNODE_PROCESS_ROLE=web`;
- `TASKNODE_TASK_REVIEW_WORKER_ENABLED=false`;
- no local publication of verification requests or reward outcomes to the live
  Fly task universe.

Local end-to-end reward testing uses the explicit reward-test profile instead:

```bash
npm run docker:reward-test
```

That command generates local-only service, authority, and reward seeds in
`.env.local-rewards` and starts a `reward-test-worker` against the local Docker
database. It is for proving reward behavior locally without sharing signing
authority with Fly.

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
config, reward seed config, `task_review_publications`, and the latest
`task_events`. Do not issue a reward from a Hive or UI row; reward state must be
backed by signed lifecycle evidence.
