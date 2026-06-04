# Task Lifecycle Replay

Task lifecycle replay is the ability to reconstruct task state from PFTL wallet history and encrypted IPFS payloads. This is the core reason to deprecate app-only task state from the old PFTasks interface.

## Canonical Lifecycle

1. User requests a task with a signed `pf.task.request.v1` pointer and encrypted request bundle.
2. System issues a proposed task with `pf.task.offer.v1`.
3. User accepts, refuses, or later cancels the task.
4. Accepted task moves onto the user's plate.
5. User submits the required work product as `pf.task.submission.v1`.
6. System requests verification with a `pf.task.update.v1` transition to `verification_requested`.
7. User submits verification evidence as `pf.task.verification_response.v1`.
8. System processes evidence and records one terminal `pf.reward.v1`.
9. If the review pays PFT, that same transaction carries the economic payout; if it pays zero, it uses a one-drop carrier and records `reward_pft: 0`.

## Technical Architecture

The protocol contract is documented in this Help wiki across PFTL, Task Async
Engine, Task Generation Worker, Task Review And Reward Worker, and PFTL
Transaction Cache. The live replay reference is
`reference_clients/python/tasknode_pftl/scenarios/full_lifecycle.py`. The
encryption-specific onboarding reference is
`reference_clients/python/tasknode_pftl/scenarios/encryption_pubkey_demo.py`.

The app maintains a task projection cache for speed. The cache is rebuildable by scanning relevant wallet histories and fetching referenced IPFS CIDs.

The current Tasks UX reads from `task_projections` and opens task detail through `GET /api/tasks/detail`. Detail pages include a server-derived action model from `server/task-lifecycle-policy.js`. Non-terminal tasks can be stopped from the Overview tab. Proposed tasks use `refused`; accepted/submitted/verification-loop tasks use `cancelled`. The stop action is published as an encrypted `pf.task.update.v1` payload and a user-signed `TASK_UPDATE` PFTL pointer through `POST /api/tasks/action`.

Request creation, evidence submission, verification requests, and terminal reward outcomes are now wired into the app path:

- `POST /api/tasks/request` coordinates browser-signed `pf.task.request.v1` publishing and durable `task_requests` rows.
- `server/task-generation-worker.js` emits `pf.task.offer.v1` from the authority wallet.
- `POST /api/tasks/submission` publishes initial evidence and verification evidence from the user wallet.
- `server/task-review-worker.js` emits verification requests and one terminal `pf.reward.v1` reward outcome.
- `server/pftl-cache-reducer.js` hydrates the encrypted IPFS payloads and projects the task state.

Reward display is also projection-derived. A terminal `pf.reward.v1` with `reward_pft: 0` is still shown under the Rewarded bucket, but the UI explains that no economic PFT was paid and renders the verifier reason from the indexed reward payload.

Evidence packets can include one or two compact artifacts. Screenshot/image evidence is processed into a vision description and digest metadata before the encrypted payload is pinned; raw image bytes should not be embedded in task payload JSON.

## Verification Evidence

Verification evidence is portable across the web app, Codex, and wallet-capable
agents. The canonical packet is `pf.task.evidence.v1`, wrapped by
`pf.task.verification_response.v1` when a user responds to a verification
request.

Supported evidence inputs:

- text evidence;
- public URL evidence;
- screenshot/image evidence described by the OpenAI vision evidence reader;
- PDF and DOCX file evidence extracted to compact text and metadata;
- mixed evidence made from one or two compact artifacts.

Implementation references:

- `server/task-evidence-processing.js`
- `prompts/task_engine/evidence_screenshot_read_v1.md`
- `reference_clients/python/tasknode_pftl/verification.py`
- `reference_clients/python/tasknode_pftl/scenarios/verification_evidence_examples.py`

Example reference command:

```bash
cd /home/pfrpc/repos/tasknodeofficial/reference_clients/python
python3 -m tasknode_pftl.scenarios.verification_evidence_examples
```

Evidence readers must not receive wallet seeds, private keys, wallet passwords,
or other custody material. URL evidence must be public text or HTML; binary URLs
are file evidence and should go through the file evidence path.

## Review Loop Refresh Contract

Task lifecycle state is shared between server and client through `shared/task-lifecycle.js`. That file is the source of truth for labels, tabs, allowed actions, terminal states, and refresh behavior.

Review-loop states are not final. `submitted`, `verification_requested`, and `verification_response_submitted` can all be followed by worker-published events. The app must keep refreshing projections while a visible task is in one of those states. This prevents a split-brain UX where the detail route has already observed a reward but the list route still shows the older Verification card.

On Fly, the worker-published transitions in this loop require the `worker`
process group to be running. `npm run fly:deploy` runs the post-deploy worker
guard; manual operator checks can run `npm run fly:worker-guard`. If a task is
stuck in `submitted`, the first production check is worker liveness and
`server/task-review-worker.js` logs, not direct mutation of `task_projections`.

The current contract is:

| State | Why it refreshes |
| --- | --- |
| `submitted` | The authority worker may publish a verification request. |
| `verification_requested` | The user may submit verification evidence and the worker may later review it. |
| `verification_response_submitted` | The authority worker may publish the terminal `pf.reward.v1` outcome. |

Terminal states such as `rewarded`, `refused`, `cancelled`, `expired`, and `rejected` do not request ongoing list refresh. They can still be opened and audited through detail/forensics, but the normal lifecycle is finished.

## Diagram

```mermaid
sequenceDiagram
  participant U as User Wallet
  participant T as Task Node Wallet
  participant R as Reward Wallet
  participant IPFS as IPFS
  U->>IPFS: Encrypted task request bundle
  U->>T: Request pointer
  T->>IPFS: Encrypted proposed task
  T->>U: Offer pointer
  U->>T: Accept or reject pointer
  U->>T: Initial submission pointer
  T->>U: Verification request pointer
  U->>T: Verification response pointer
  R->>U: Reward outcome pointer and optional economic payout
```

## Failure Modes

- PFTL is synchronous per wallet, so transaction queues are required.
- Cache updates should tolerate delayed or out-of-order replay.
- Encrypted payload fetch failures should be retried without losing pointer events.
- A rewarded projection can correctly have `0 PFT` when the reward outcome rejects evidence or assigns no payout.
- User stop actions must be signed by the linked wallet and must not mutate the task projection directly before chain replay confirms the update.
- Date-only deadlines must render as dates, while PFTL events and review timestamps must render as exact times with timezone.
- If the cache lags after a submit, the UI should show the submitted transaction and poll projection state rather than pretending the task did not change.
- If the Fly `worker` process is stopped, `submitted` tasks cannot advance to
  `verification_requested`; run `npm run fly:worker-guard` before treating the
  task row as corrupt.

## Reviewer To Do List

Review implementation against this document (task lifecycle). Mark each item when verified.

### Memory Efficiency
- [ ] Hot paths use bounded queries, checkpoints, or projection tables.
- [ ] Background workers dedupe and lock jobs to prevent duplicate work.
- [ ] Replay rebuilds projection from cached pointers, not live chain scan per UI request.

### Code Quality
- [ ] Architecture claims map to migrations, repositories, and smoke scripts.
- [ ] Failure modes have operator-visible signals or health endpoints.
- [ ] State machine in doc matches `shared/task-lifecycle.js` and reducer transitions.
- [ ] Review-loop refresh contract implemented for `verification_requested`.

### Coherence
- [ ] Canonical vs cache boundaries consistent with wiki index.
- [ ] Cross-links to related architecture pages remain accurate.
- [ ] Browser and Python reference paths emit same schema versions.
- [ ] Terminal `rewarded` includes zero-reward outcomes consistently.

### Bloat
- [ ] No parallel implementations of the same protocol concern.
- [ ] Retention policies drop queue noise without losing audit tx rows.
- [ ] Event types normalized once in `task_events`, not duplicated per consumer.

### Security
- [ ] Encryption and wallet-role rules enforced at trust boundaries.
- [ ] Secrets and seeds remain server-side or browser-local as designed.
- [ ] Lifecycle transitions require signed pointers from appropriate wallet roles.
- [ ] Authority/reward wallets configured via env; not user-editable.
