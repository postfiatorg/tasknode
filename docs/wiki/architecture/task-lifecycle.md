# Task Lifecycle and Replay

Current implementation reviewed September 5, 2026.

Task lifecycle semantics and storage transport are separate. The shared
contract in `shared/task-lifecycle.js` defines states, tabs, actions and refresh
behavior. Current production uses offchain task events and projections;
historical signed PFTL/IPFS records retain a replay path.

## Lifecycle

1. An authenticated user or authorized routing service records a task request.
2. The generator records a proposed `pf.task.offer.v1` event and task projection.
3. The user accepts or refuses the proposal; accepted work can later be cancelled.
4. Initial evidence records `pf.task.submission.v1` and advances to `submitted`.
5. Review can request verification through `pf.task.update.v1`.
6. The user answers with `pf.task.verification_response.v1`.
7. Review records a terminal `pf.reward.v1` outcome and reconciles any payment.

`rewarded` includes zero-reward outcomes. Show the decision and amount; do not
imply that every terminal review paid positive PFT.

## Canonical records

| Path | Record and visibility |
| --- | --- |
| Current generated offers | `applyOffchainTaskOffer` transaction writes `task_events` and `task_projections` |
| Current offchain actions/submissions | Domain services validate the actor/state and write offchain lifecycle events/projections |
| Historical signed task events | PFTL pointer plus applicable encrypted IPFS payload; cache/reducer projects the event |
| Economic reward payment | Recorded publication and actual ledger settlement; inspect `task_review_publications` and indexed outcome |

`postgres:` references identify application records and `offchain:` references
identify offchain events. They must not be displayed or described as confirmed
PFTL transaction hashes. A complete database backup is required for current
Postgres-native tasks; replaying wallet history alone cannot reconstruct them.

The current generator always uses its offchain offer writer. Its
`syncOfferProjection` helper reports `direct_write` and does not perform PFTL
sync/reduction. The retained signed request intake and historical reducer do
not imply that a newly generated offer was signed on-chain.

## API and user actions

- `POST /api/tasks/request`: browser request service with configured intake path.
- `POST /api/terminal/tasknode/requests`: authenticated Corbanu minimal-bundle intake.
- `POST /api/tasks/action`: validated task action and configured lifecycle writer.
- `POST /api/tasks/submission`: initial and verification evidence processing/submission.
- `GET /api/tasks` and `/api/tasks/detail`: projected state and allowed actions.
- Terminal task detail/action/evidence routes expose the linked account's task workflow.

The server-derived action model in `server/task-lifecycle-policy.js` remains
the authority for available actions. Proposed tasks can be refused;
accepted/submitted/verification-loop tasks can be cancelled when permitted.
Signing and local unlock are required for paths that actually use the browser
wallet. An authenticated offchain terminal mutation does not ask the TUI to
sign a PFTL transaction.

## Evidence

The canonical evidence packet is `pf.task.evidence.v1`, wrapped by the relevant
submission or verification-response event. Supported inputs include text,
public URLs, image descriptions, supported document/archive extraction and
mixed evidence containing up to two compact artifacts.

`server/task-evidence-processing.js` and `server/evidence-file-extraction.js`
validate bytes/digests, bound expansion and extract compact text and metadata.
Image analysis uses the shared verification-vision capability; see
[AI providers](ai-providers.md). Raw image bytes do not belong in task event
JSON. Public URL extraction rejects unsafe destinations and unsupported forms.
Never include custody material or secrets in evidence.

The Python examples in
`reference_clients/python/tasknode_pftl/scenarios/verification_evidence_examples.py`
and `full_lifecycle.py` document the signed protocol client. Their successful
replay is evidence about that protocol path, not a complete backup/restore test
of Postgres-native production tasks.

## Review and refresh

`worker-task-review` advances submitted and verification-response states.
`worker-pftl` owns historical pointer/cache/reducer work. The web process's
health endpoint cannot establish either worker's liveness.

| State | Current refresh reason |
| --- | --- |
| `submitted` | Worker may request verification |
| `verification_requested` | Waiting for user input; focus/detail refresh observes cross-device changes |
| `verification_response_submitted` | Worker may record a reward outcome |
| `rewarded`, `refused`, `cancelled`, `expired`, `rejected` | Terminal; inspect history rather than continuously polling for worker progress |

The detail and list must converge on the same authoritative state. Preserve
optimistic receipts until confirmed, reject stale display regressions and
expose stalled work with its recovery status. Current browser refresh/backoff
rules live in `src/features/tasks/task-refresh-policy.js` and
`task-visible-state.js`.

## Failure diagnosis

Start with the storage path and authoritative event/projection, then inspect
request/job attempt ownership, publication state and client freshness. Use
reducer repair only for a real pointer/replay problem. A missing offchain event
cannot be recovered by claiming a signed pointer exists. For an unknown reward
submit, reconcile the existing recorded transaction before any second payout.

See [task async engine](task-async-engine.md),
[task generation](task-generation-worker.md),
[review and reward](task-review-reward-worker.md), and the
[historical chain-only snapshot](../../archive/2026-09-05-task-architecture/task-lifecycle.md).
