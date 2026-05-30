# Restored Core Product Task Flow

Status: active implementation specification

Task: `task_5dc3c23dd1460a044bfa2ce1fede2292`

Request: `req_net_a506f6bb3f9e0112d2f61b9cb8baefca`

Network project: `task_node_core_product_restored`

Network allocation: `netalloc_7695d0f0ff01a848d4ac31a68967fa21`

Reward: 18,000 PFT

Deadline: May 31, 2026

## Scope

This document defines the first restored core Task Node product loop:

1. A signed-in user requests work.
2. Task Node generates a concrete task.
3. The user accepts, completes, and submits evidence.
4. Task Node asks one verification follow-up when needed.
5. The user responds.
6. Task Node scores the work and closes the task with a positive PFT reward or a zero-PFT reward decision.

Do not expand this milestone into profile, funding, Telegram, Discord, broad Hive strategy, or new task categories. Network Tasks and Alpha Tasks use the same lifecycle, but this board should ship one normal user loop before adding new surfaces.

## Product Contract

The user must never wonder whether Task Node is waiting on the wallet, the chain, the worker, the verifier, or the reward wallet. Every visible state needs:

- one status label;
- one acknowledgement of the latest completed action;
- one next action or one explanation that the system is working;
- one diagnostics path for operators.

The app may show compact copy to users, but the backing state must remain replayable from PFTL pointers, encrypted IPFS payloads, and Postgres projections.

## End-To-End Workflow

### 1. Request Draft

User action: Click `Request task` from Tasks or Chat and describe the desired work.

Required wallet state:

- signed in;
- linked wallet;
- matching local vault saved;
- vault unlocked;
- unlocked seed belongs to the linked wallet and current account.

Visible acknowledgement:

- If ready: `Request task` is enabled.
- If locked: `Unlock the linked wallet before publishing the task request.`
- If unlock modal is open: `Finish unlocking the linked wallet before publishing the task request.`
- If no local vault: `Restore the local wallet vault before requesting a task.`

Acceptance criteria:

- The UI blocks request publication before IPFS, encryption, or PFTL work if the wallet boundary is missing.
- Chat task-request mode and the Tasks modal use the same unlock policy.
- A locked or unlock-pending request cannot create duplicate modals or duplicate request rows.

Current source:

- `src/features/tasks/task-request-unlock-policy.js`
- `src/features/tasks/TaskRequestModal.jsx`
- `src/main.jsx`

### 2. Request Published

User action: Submit the request.

System action:

1. Build request bundle from context, memory, recent chat, and task queue.
2. Encrypt bundle locally for the user and Task Node service recipients.
3. Pin encrypted bundle to IPFS.
4. Encrypt a `pf.task.request.v1` event.
5. Sign and submit a PFTL `TASK` pointer from the user wallet.
6. Persist `task_requests` and hidden task-request chat metadata.

Visible acknowledgement:

- `Task request published to PFT. Transaction <prefix>...`
- Active request strip appears while the request is `published`, `queued`, `generating`, or recently `failed`.

Acceptance criteria:

- A request row exists with `request_id`, `account_id`, `subject_wallet`, `request_bundle_cid`, `request_event_cid`, `request_tx_hash`, and `status = published`.
- The UI shows the request as in flight until a projected task exists or a visible failure appears.
- A request cannot disappear silently after successful chain submit.

Current source:

- `server/task-request.js`
- `server/repositories/task-requests.js`
- `src/features/tasks/TaskRequestQueue.jsx`

### 3. Task Generating

System action:

1. `server/task-generation-worker.js` claims `task_requests` with `published` or `queued` status.
2. The worker marks the request `generating`.
3. The worker decrypts the request bundle, calls the task-generation prompt, validates the output, publishes `pf.task.offer.v1`, syncs PFTL, and lets the reducer create `task_projections`.

Visible acknowledgement:

- `Generating task` or equivalent active request copy.
- If generation fails: visible `Needs attention` state with the error summarized and a retry/repair path for operators.

Acceptance criteria:

- The generated task card comes from `task_projections`, not fabricated React state.
- Generated tasks have 2 to 5 steps.
- Generated tasks ask only for supported evidence: text, URL, screenshot/image, uploaded file/document, code text, public commit, or mixed evidence from those types.
- Unsupported evidence such as video, screen recording, live calls, and calendar invites is rejected before publication.

Current source:

- `server/task-generation-worker.js`
- `prompts/task_engine/taskgen_minimal_v1.md`
- `server/repositories/task-requests.js`

### 4. Proposed

User action: Inspect the proposed task.

Visible acknowledgement:

- Task appears in Outstanding with status `Proposed`.
- Detail view shows objective, steps, reward, deadline, submission requirement, and forensics.
- Primary actions: `Accept task` and `Refuse task`.

Acceptance criteria:

- The proposed task has `pf.task.offer.v1` in forensics.
- Accept/refuse actions are disabled until the wallet is ready.
- Refusing publishes a signed task update and moves the task to Refused.

Current source:

- `shared/task-lifecycle.js`
- `src/features/tasks/TaskDetailModal.jsx`
- `server/task-actions.js`

### 5. Accepted

User action: Accept the proposed task.

System action:

- Browser signs a `pf.task.update.v1` acceptance pointer.
- Reducer projects status `accepted`.

Visible acknowledgement:

- Task status becomes `Accepted`.
- Submit tab becomes available.
- Detail copy tells the user what evidence is required.

Acceptance criteria:

- Acceptance has a CID and transaction hash in forensics.
- The Submit tab is available only after acceptance.
- Accepted tasks remain in Outstanding and cannot disappear from the queue.

### 6. Evidence Submitted

User action: Submit initial evidence.

System action:

1. Browser prepares compact evidence metadata.
2. Screenshot/image/file evidence is processed before payload construction; raw media bytes are not embedded in JSON.
3. Browser encrypts `pf.task.submission.v1`.
4. Browser signs and submits a PFTL `TASK_SUBMISSION` pointer.
5. Reducer projects status `submitted`.

Visible acknowledgement:

- `Evidence published` with transaction prefix.
- Task remains visible while awaiting review.
- Submitted evidence appears in detail and forensics.

Acceptance criteria:

- Empty evidence is blocked.
- Oversized or unsupported evidence is blocked visibly.
- One or two evidence items can be submitted in a single signed packet.
- A submitted task keeps refreshing because the review worker may publish the next transition.

Current source:

- `server/task-submission.js`
- `src/features/tasks/TaskDetailModal.jsx`
- `shared/task-lifecycle.js`

### 7. Verification Requested

System action:

1. `server/task-review-worker.js` claims `submitted` tasks.
2. Worker evaluates the task and evidence.
3. Worker publishes a `pf.task.update.v1` transition to `verification_requested`.

Visible acknowledgement:

- Task moves to Verification.
- Detail overview shows the current verification ask prominently.
- Primary action routes the user to Submit.

Acceptance criteria:

- Verification request is specific to the original task and submitted evidence.
- The original task context is available but secondary.
- The task remains refreshable until terminal state.

### 8. Verification Response Submitted

User action: Submit verification evidence or response.

System action:

- Browser publishes `pf.task.verification_response.v1`.
- Reducer projects status `verification_response_submitted`.

Visible acknowledgement:

- Status becomes `Awaiting review`.
- The latest verification response is visible in forensics.
- User sees that scoring is now system-side.

Acceptance criteria:

- The user cannot submit a verification response before a verification request exists.
- The response packet has CID and transaction hash.
- The task keeps refreshing while reward scoring is pending.

### 9. Rewarded

System action:

1. Review worker scores the verification response.
2. Worker publishes `pf.task.reward_decision.v1`.
3. If positive, reward wallet publishes `pf.reward.v1` and transfers PFT.
4. Reducer projects terminal status `rewarded`.

Visible acknowledgement:

- Task moves to Rewarded.
- Positive reward: show PFT amount, reward decision, and payment transaction when indexed.
- Zero reward: show `No PFT paid` and the verifier reason. This is still terminal `rewarded`.

Acceptance criteria:

- Positive, partial, and zero reward outcomes all render honestly.
- Rewarded tasks stop active refresh unless a positive reward decision is waiting for the payment pointer.
- Wallet and task forensics agree on the payment state.
- No separate fake completion state is used outside projected lifecycle.

## State Table

| Product state | Backing state | User acknowledgement | Next action | Acceptance criteria |
| --- | --- | --- | --- | --- |
| `needs_wallet` | No linked wallet | Link a PFT wallet before requesting a task. | Open Wallet | No request row, IPFS pin, or PFTL submit. |
| `needs_local_vault` | Linked wallet without matching browser vault | Restore the local wallet vault before requesting a task. | Open Wallet | No signing action starts. |
| `locked` | Saved vault but no decrypted seed | Unlock the linked wallet before publishing the task request. | Unlock wallet | Shared unlock modal opens; task flow remains in place. |
| `unlock_pending` | Unlock modal already open | Finish unlocking the linked wallet before publishing the task request. | Wait | No second modal and no duplicate submit. |
| `invalid_unlock` | Decrypted wallet does not match account/link | Unlocked wallet state does not match the linked wallet. | Unlock correct vault | Signing publisher also rejects. |
| `signing_request` | Browser local only | Publishing request. | Wait | Button disabled; no duplicate submit. |
| `published` | `task_requests.status = published` | Task request published to PFT. | Wait for worker | Active request strip visible. |
| `generating` | `task_requests.status = generating` | Generating task. | Wait | Worker attempt metadata retained. |
| `request_failed` | `task_requests.status = failed` | Needs attention. | Retry or operator repair | Error is visible; request does not disappear for 24 hours. |
| `proposed` | `task_projections.status = proposed` | Proposed task. | Accept or refuse | Offer payload, CID, and tx present. |
| `accepted` | `task_projections.status = accepted` | Accepted. | Submit evidence | Acceptance CID and tx present. |
| `submitted` | `task_projections.status = submitted` | Evidence submitted. | Wait for verification | Refresh continues. |
| `verification_requested` | `task_projections.status = verification_requested` | Verification requested. | Submit verification response | Current ask is prominent. |
| `verification_response_submitted` | `task_projections.status = verification_response_submitted` | Awaiting review. | Wait for reward decision | Refresh continues. |
| `reward_decided` | `task_projections.status = reward_decided` | Reward decided. | Wait for payment pointer if positive | Positive decisions still refresh. |
| `rewarded` | `task_projections.status = rewarded` | Rewarded or No PFT paid. | Audit only | Terminal; reason and payment state visible. |
| `refused` | `task_projections.status = refused` | Refused. | Audit only | Terminal. |
| `cancelled` | `task_projections.status = cancelled` | Cancelled. | Audit only | Terminal. |

## Remaining P0 Blockers

These are the blockers to call the restored core loop deterministic for beta users.

1. Worker failure state UI is incomplete. Request generation, review, scoring, and reward failures are retained in metadata/logs, but the user does not yet get a dedicated retry/failure panel for every worker failure.
2. Authority and reward signing do not yet use a durable wallet transaction queue. The current worker signs inline with configured seeds, which is acceptable for low-volume dev but not deterministic under public load.
3. Per-user or per-shard allocation reward wallet provisioning is not implemented. Reward signing still uses configured service/reward seeds.
4. Live QA coverage is not packaged as a repeatable script for positive reward, partial reward, and zero-reward from a clean browser account.
5. Operator status needs one direct bridge from task detail to relevant runbook when a task is stale because worker, PFTL cache, reducer, or reward payment is behind.
6. Network Task project mirrors must be verified after reward so Hive shows completed work from projection replay, not from Board Manager assumptions.

## Initial Restored Board Tasks

Use these as the first 8 board tasks. They are ordered to ship the loop, not to broaden the product.

| Priority | Task | Workflow state covered | Beta boundary | Acceptance criteria |
| --- | --- | --- | --- | --- |
| P0-1 | Build visible task worker failure and retry panel | `request_failed`, review failure, reward failure | Tasks | Failed generation/review/reward rows show a user-facing state, concise error, timestamp, and operator retry path. |
| P0-2 | Add wallet transaction queue for authority and reward signing | offer, verification request, reward decision, payment | Task Async Engine | Authority and reward wallet submissions serialize by signing wallet and can be retried without duplicate pointers/payments. |
| P0-3 | Add reward wallet funding and payout health surface | `reward_decided`, `rewarded` | Wallet, Tasks, System Status | Positive reward decisions show paid, pending payment, or failed payment; low balance has an operator alert. |
| P0-4 | Package browser E2E task lifecycle QA | full loop | QA, Tasks | One command/runbook captures request ID, task ID, CIDs, tx hashes, screenshots/text captures, and final reward state. |
| P0-5 | Verify zero-reward and positive-reward UX side by side | `rewarded` | Tasks | Rewarded tab clearly distinguishes paid PFT from `0 PFT` decision with reason; both are terminal and auditable. |
| P0-6 | Wire stale task diagnostics to runbooks | `published`, `generating`, `submitted`, `verification_response_submitted`, `reward_decided` | System Status, Docs | A stale task detail links to Task Generation, Task Review And Reward, PFTL Cache Reducer, or PFTL RPC runbook as appropriate. |
| P0-7 | Harden Network Task projection mirror after reward | Network Task reward completion | Hive, Network Tasks | Rewarded Network Task updates `network_project_task_refs` and allocation status from projection replay; Board Manager follow-up is idempotent. |
| P0-8 | Add compact restored-loop product checklist to QA protocol | whole loop | Docs, QA | QA agents test exactly request, offer, accept, evidence, verification, response, reward, and forensics without route-click bloat. |

Deferred after the restored core loop:

- New task categories beyond Personal, Network, and Alpha.
- Discord-based task control.
- Public marketplace or social task feeds.
- Multiple verification rounds.
- Rich task collaboration between multiple users.
- New profile, NFT, or airdrop behavior.

## Verification Evidence For This Specification

This document is the verification artifact for `task_5dc3c23dd1460a044bfa2ce1fede2292`.

Expected proof bundle:

- changed file: `docs/wiki/plans/restored-core-product-task-flow.md`;
- docs index entry: `#docs/restored-core-product-task-flow`;
- command: `npm run format-check`;
- command: `git diff --check`;
- current source references: `docs/wiki/surfaces/tasks.md`, `docs/wiki/architecture/task-lifecycle.md`, `docs/wiki/architecture/task-async-engine.md`, `shared/task-lifecycle.js`, `server/repositories/task-requests.js`.
