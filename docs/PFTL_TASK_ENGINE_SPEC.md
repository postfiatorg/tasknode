# PFTL-Native Task Engine Specification

Status: proposed architecture
Last updated: 2026-05-16

## Purpose

Task Node should become a wallet-native protocol, not a website-specific task
database. The web app, Codex, a Python package, a CLI, or any other client
should be able to reconstruct task state from PFTL pointer events plus
encrypted IPFS payloads.

The database remains important, but only as a cache, index, queue, and read
model. It must not be the canonical source of task truth.

This spec defines the target task lifecycle, why the current PFTasks interface
should be deprecated as the primary task engine, how to map the existing
PFTasks implementation into a PFTL pointer workflow, and how to keep the system
fast without constantly rehydrating every wallet from archive RPC.

## Current PFTasks Research

PFTasks already contains most of the business logic, but the current lifecycle
is DB-first.

Relevant current implementation:

- Task generation:
  `pftasks/api/src/routes/chat/post_message_task_general.js`
  - `runTaskRequestGeneration(...)` builds task-history/context replacements,
    calls the LLM task prompt, parses the task payload, inserts a row into
    `tasks`, records a `task_generated` row in `task_events`, and inserts a
    chat message with serialized task metadata.
  - Current generated task status is usually `pending`.
- Task overview/read model:
  `pftasks/api/src/services/task_history_service.js`
  and `pftasks/api/src/routes/tasks/overview_routes.js`
  - Dashboard outstanding statuses are `pending`, `proposed`, `accepted`,
    and `in_progress`.
  - Submitted tasks move through `submitted` / `pending_verification`.
  - Rewarded tasks are identified from `rewarded`, `verified_at`, and reward
    fields.
- Accept/refuse/cancel:
  `pftasks/api/src/routes/tasks/lifecycle_routes.js`
  - Accept updates `tasks.status = 'in_progress'`, stamps `accepted_at`, and
    records `task_accepted`.
  - Refuse updates the task row and records refusal events.
  - Expired offers are represented as refused/no-response style states.
- Initial submission:
  `pftasks/api/src/routes/tasks/submission_routes.js`
  - Inserts `task_submissions`.
  - Updates `tasks.status = 'pending_verification'`.
  - Records `submission_recorded`.
  - Triggers `generateVerificationAsk(...)`.
- Verification ask:
  `pftasks/api/src/services/verification_service.js`
  - Builds an LLM follow-up verification question.
  - Stores `verification_ask`, `verification_payload`,
    `verification_requested_at`, and `verification_status = 'awaiting_response'`.
  - Records `verification_requested`.
- Verification response:
  `pftasks/api/src/routes/tasks/verification_routes.js`
  - Encrypts the user's verification response/evidence to IPFS.
  - Records local `verification_response_evidence`.
  - Requires a final pointer transaction hash before setting
    `verification_status = 'response_submitted'`.
  - Records `verification_responded` and enqueues reward scoring.
- Reward:
  `pftasks/worker/src/jobs/reward_task/execution.js`
  and `pftasks/worker/src/jobs/reward_task/runners.js`
  - Scores the evidence with category-specific reward prompts.
  - Builds a `pf.reward.v1` encrypted payload with
    `reward_history_schema: 1` and a full task-history snapshot.
  - Uploads the encrypted payload to IPFS.
  - Builds a `pf.ptr/v4` memo with `kind = REWARD`, `schema = 1`,
    `flags = encrypted`, and `task_id`.
  - Sends the reward payment from the reward wallet pool.
  - Finalizes SQL rows and records `reward_paid`, `reward_skipped`, or
    `reward_paid_post_cancel`.
- Pointer infrastructure:
  `pftasks/api/src/pftl/pointer.js` and
  `pftasks/api/proto/pf/ptr/v4/pointer.proto`
  - Current canonical memo type is `pf.ptr`.
  - Current canonical memo format is `v4`.
  - Existing content kinds include `TASK`, `TASK_UPDATE`,
    `TASK_SUBMISSION`, `CONTEXT`, `REWARD`, `POLICY`, `IDENTITY`, and others.
- Reward wallets:
  `pftasks/docs/reward_wallets.md`
  - PFTasks already provisions a reward wallet pool and keeps faucet/treasury
    top-up separate from payout wallets.

The important conclusion: reward payout is already close to PFTL-native. Task
offer, accept/reject, initial submission, verification ask, and some evidence
state are still too DB-centered.

## Why Deprecate The PFTasks Interface As The Core

The old PFTasks interface should be deprecated as the canonical task engine for
three reasons.

First, it is not portable. Users increasingly do their work in Codex or local
agent runtimes. A user running Codex with their seed available locally should be
able to sync tasks, accept work, submit evidence, and observe rewards without
using the PFTasks web UI.

Second, it is not replayable enough. A SQL row is not a durable protocol event.
If a task offer exists only in Postgres, an arbitrary client cannot reconstruct
the user's task state from the ledger.

Third, it creates the wrong legal and operational boundary. If task state is
wallet-scoped on-chain pointer history, then a user-specific audit or legal
request can be answered from that user's wallet interactions and related
service wallet events. It should not require exposing the entirety of Task
Node's global operational database.

PFTasks remains valuable as:

- a reference implementation of task-generation, verification, and reward
  policy;
- a migration bridge for historical data that was never written as pointers;
- an index source while PFTL-native issuance is being built;
- a regression oracle for current task semantics.

It should not remain the canonical state machine.

## Design Principles

1. On-chain pointer events are canonical.
2. IPFS encrypted payloads are canonical content.
3. Postgres, SQLite, Redis, and in-memory state are caches or projections.
4. Every task state must be replayable by reducing ordered events.
5. The same protocol must support web app, Codex, CLI, and third-party UXes.
6. Caching is mandatory for performance, but cache loss must be recoverable.
7. Wallet ownership, not OAuth identity, owns task state.
8. OAuth identity may bind a web account, but sensitive actions require wallet
   proof or delegated wallet capability.
9. User work and context must be encrypted to explicit recipients.
10. The system should minimize global disclosure during audit, support, and
    subpoena workflows.

## Canonical Lifecycle

The canonical lifecycle is:

1. User requests a task with a specific context block.
2. System issues a task to the user. This may happen without a user request.
3. State becomes `proposed`.
4. User accepts the task.
5. Task is now on the user's plate.
6. If the user does not accept by the offer deadline, the task is assumed
   rejected/expired.
7. User may explicitly reject the task with a reason.
8. Task contains a submission requirement.
9. User submits the initial task submission.
10. System processes the submission and issues a follow-on verification request.
11. User submits a verification evidence packet.
12. System processes the evidence and issues an on-chain reward.

The protocol must support task issuance without a preceding user request. That
matters for network tasks, alpha tasks, system-assigned work, and future
multi-agent allocation.

## Canonical State Machine

Recommended canonical states:

```text
none
  -> requested
  -> proposed
  -> accepted
  -> submitted
  -> verification_requested
  -> verification_response_submitted
  -> reward_processing
  -> rewarded

proposed
  -> rejected
  -> expired
  -> cancelled

accepted/submitted/verification_requested
  -> cancelled
  -> expired
```

Operational UI labels can differ:

```text
proposed                         -> Proposed
accepted                         -> In flight
submitted                        -> Submitted
verification_requested           -> Verification
verification_response_submitted  -> Reward processing
rewarded                         -> Rewarded
rejected / expired / cancelled   -> Closed
```

The reducer must be deterministic:

- Events are ordered by validated ledger index, transaction index, memo index,
  and payload timestamp only as a tie-breaker.
- Invalid transitions do not mutate canonical state; they are retained as audit
  anomalies.
- Conflicting events are resolved by authority rules, not last-write-wins.
- A reward event is final for payment history even if a later operational cache
  repair notices a cancellation race.

## Pointer Contract

All task protocol events use the existing pointer envelope:

```text
MemoType   = pf.ptr
MemoFormat = v4
MemoData   = protobuf pf.ptr.v4.Pointer
```

Current pointer fields:

```text
cid        field 1
target     field 2
kind       field 3
schema     field 4
task_id    field 5
thread_id  field 6
context_id field 7
flags      field 8
```

Existing content kinds are sufficient for the first version:

```text
TASK             task request or task offer
TASK_UPDATE      accept, reject, expire, cancel, verification request
TASK_SUBMISSION  initial submission and verification response
REWARD           reward payment / skipped reward payload
CONTEXT          context documents and grants
POLICY           task authority, wallet delegation, or protocol policy
IDENTITY         account/wallet identity claims
```

## Event Schemas

Each event payload should include these common fields:

```json
{
  "schema": "pf.task.<event>.v1",
  "protocol": "tasknode.pftl",
  "created_at": "ISO-8601",
  "chain": "pftl-testnet",
  "task_id": "canonical task id or null for request",
  "event_id": "deterministic id",
  "previous_event_id": "optional parent event",
  "actor_wallet": "wallet that authorized the event",
  "subject_wallet": "user wallet the task belongs to",
  "authority_wallet": "task authority wallet when applicable",
  "allocation_wallet": "per-user reward/allocation wallet when applicable",
  "context_id": "optional context block id",
  "request_id": "optional user request id"
}
```

Recommended payload schemas:

### `pf.task.request.v1`

Content kind: `TASK`

User asks for a task against a context block. Optional for system-issued tasks.

```json
{
  "schema": "pf.task.request.v1",
  "request_id": "req_...",
  "subject_wallet": "r...",
  "context": {
    "context_id": "ctx_...",
    "context_cid": "baf...",
    "context_digest": "sha256:..."
  },
  "request_text": "user-visible task request",
  "requested_task_kind": "personal|network|alpha|system",
  "client": {
    "name": "tasknodeofficial|codex|python|cli",
    "version": "semver"
  }
}
```

### `pf.task.offer.v1`

Content kind: `TASK`

System issues a proposed task.

```json
{
  "schema": "pf.task.offer.v1",
  "task_id": "task_...",
  "request_id": "req_... or null",
  "subject_wallet": "r...",
  "authority_wallet": "r...",
  "allocation_wallet": "r...",
  "status": "proposed",
  "title": "Task title",
  "description": "Task description",
  "task_kind": "personal|network|alpha|system",
  "submission_requirement": {
    "type": "text|url|github_commit|screenshot|file|mixed",
    "criteria": "What the initial submission must contain"
  },
  "verification_policy": {
    "mode": "standard_followup|relief|direct_reward_eligible",
    "followup_required": true
  },
  "reward_offer": {
    "amount_estimate_pft": "3200.00",
    "cap_pft": "optional",
    "late_reward_cap": "optional"
  },
  "proposed_at": "ISO-8601",
  "accept_by": "ISO-8601",
  "deadline_at": "ISO-8601 or null",
  "context_refs": [
    {
      "context_id": "ctx_...",
      "cid": "baf...",
      "digest": "sha256:..."
    }
  ]
}
```

### `pf.task.update.v1`

Content kind: `TASK_UPDATE`

State transition event for accept, reject, expire, cancel, amend, and
verification request.

```json
{
  "schema": "pf.task.update.v1",
  "task_id": "task_...",
  "transition": "accepted|rejected|expired|cancelled|verification_requested",
  "reason_code": "optional stable reason",
  "reason_text": "optional user/system text",
  "status_after": "accepted",
  "accepted_at": "ISO-8601 or null",
  "verification_request": {
    "verification_ask": "Only present for verification_requested",
    "verification_run_id": "optional",
    "verification_policy": {}
  }
}
```

### `pf.task.submission.v1`

Content kind: `TASK_SUBMISSION`

Initial user submission after accept.

```json
{
  "schema": "pf.task.submission.v1",
  "task_id": "task_...",
  "submission_id": "sub_...",
  "phase": "initial_submission",
  "artifact_cid": "baf...",
  "artifact_type": "text|url|github_commit|screenshot|file|mixed",
  "artifact_digest": "sha256:...",
  "summary": "short user-visible summary",
  "submitted_at": "ISO-8601"
}
```

### `pf.task.verification_response.v1`

Content kind: `TASK_SUBMISSION`

User response to the follow-on verification ask.

```json
{
  "schema": "pf.task.verification_response.v1",
  "task_id": "task_...",
  "submission_id": "sub_...",
  "phase": "verification_response",
  "verification_response_cid": "baf...",
  "verification_response_digest": "sha256:...",
  "response_text": "optional plaintext summary before encryption",
  "artifact_type": "text|url|github_commit|screenshot|file|mixed",
  "responded_at": "ISO-8601"
}
```

### `pf.reward.v1`

Content kind: `REWARD`

This mostly exists today. It should remain the canonical reward event and should
continue to include a task-history snapshot for recoverability.

```json
{
  "schema": "pf.reward.v1",
  "reward_history_schema": 1,
  "task_id": "task_...",
  "submission_id": "sub_...",
  "recipient_wallet_address": "r...",
  "reward_pft": "3200.00",
  "reward_tier": "A",
  "reward_score": 0.92,
  "reward_summary": "Short explanation",
  "task_history": {}
}
```

## Canonical Task ID

Task IDs must be portable. They cannot be database IDs.

Recommended v1 derivation:

```text
task_id = base32(blake3(
  "tasknode.task.v1" ||
  chain_id ||
  authority_wallet ||
  offer_payload_cid ||
  offer_tx_hash
))
```

During migration, legacy PFTasks UUIDs may be preserved as
`legacy_task_id`, but the pointer-native ID should become the primary key for
new tasks.

## Wallet Model

Recommended wallet classes:

### User wallet

User-controlled. Owns identity, task acceptance, rejection, submissions,
context grants, and reward receipt.

### Task authority wallet

System-controlled or committee-controlled. Signs valid task offers and policy
events. This is the policy authority, not necessarily the payout wallet.

### Treasury/funding wallet

Funds reward allocation wallets. It should not pay every user reward directly.

### Per-user allocation/reward wallet

Mapped 1:1 to a user wallet or account. Pays rewards for that user and emits
reward payment transactions. This reduces contention, isolates accounting, and
improves latency.

Recommended relationship:

```text
treasury_wallet
  funds
    user_allocation_wallet

task_authority_wallet
  signs
    task offer / task policy

user_wallet
  signs
    accept / reject / submit / context grant

user_allocation_wallet
  pays
    reward to user_wallet
```

## Provisioning

Provisioning should be explicit and pointer-visible where useful.

1. User links a wallet to a Task Node account.
2. Task Node creates or assigns an allocation wallet for that user.
3. Task authority emits or caches an identity/allocation claim:
   - user wallet;
   - allocation wallet;
   - task authority wallet;
   - policy version;
   - effective time.
4. Treasury funds the allocation wallet according to policy.
5. Indexer watches the user wallet, task authority wallet, and allocation
   wallet.

The allocation wallet mapping can be stored in the cache database for speed,
but the durable claim should be recoverable from a `POLICY` or `IDENTITY`
pointer event if we want full playback.

## Authentication And Delegation

OAuth authenticates a web session. Wallet proof authorizes wallet-bound state.

For Codex and portable agents, add delegated capabilities:

```json
{
  "schema": "pf.identity.agent_grant.v1",
  "grantor_wallet": "user wallet",
  "agent_public_key": "local Codex/runtime key",
  "permissions": [
    "read_tasks",
    "read_context",
    "accept_tasks",
    "reject_tasks",
    "submit_evidence"
  ],
  "spend_limit_pft": "0",
  "task_scope": "all|workstream|task_id",
  "expires_at": "ISO-8601"
}
```

Codex should not need the seed in model context. The runtime should expose a
local signing/decryption boundary:

```text
Codex -> local tasknode tool -> local wallet vault -> signed pointer event
```

## Portable Client Target

A portable client should be able to run:

```bash
tasknode wallet status
tasknode sync
tasknode tasks list --status proposed
tasknode tasks accept TASK_ID
tasknode tasks reject TASK_ID --reason wrong_scope
tasknode submit TASK_ID --artifact evidence.md
tasknode verification respond TASK_ID --artifact proof.md
tasknode replay --wallet r...
```

Local storage should be disposable:

```text
~/.tasknode/
  vault.json
  tasknode.sqlite
  ipfs-cache/
  config.toml
```

The local SQLite cache stores sync checkpoints, pointer events, decrypted
metadata, task projections, context projections, and queued local submissions.
Deleting it should only cost replay time.

## Cache And Index Strategy

We should absolutely not hydrate every task from archive RPC on every page
load. The right design is canonical replay plus aggressive indexing.

### Cache layers

1. Browser/session cache
   - Current page state, unlocked wallet state, decrypted previews.
   - Never canonical.

2. App database read model
   - Fast task list, task detail, context summaries, reward history.
   - Wallet-scoped.
   - Rebuildable from pointer events and IPFS payloads.

3. Pointer event index
   - Raw decoded `pf.ptr/v4` observations.
   - Stores wallet, tx hash, ledger index, memo index, CID, kind, schema,
     task_id, context_id, flags, direction, and source RPC.
   - This table should be treated as replay input cache.

4. IPFS payload cache
   - Stores encrypted blob metadata and optionally decrypted summaries when
     policy allows.
   - Stores payload hash and schema version.

5. Local agent cache
   - SQLite equivalent of the app read model for Codex/CLI.

### RPC policy

Use the cheapest reliable source for hot sync, but periodically reconcile
against the canonical archive source.

Recommended behavior:

```text
hot path:
  local/cheap WSS or local rapid RPC
  recent ledger windows
  known watched wallets

reconciliation path:
  production/archive RPC
  lower frequency
  full account_tx pagination
  fills missing historical pointers

fallback path:
  indexed snapshots from legacy PFTasks while migration is incomplete
```

For each wallet, store:

```text
last_hot_ledger_seen
last_archive_ledger_checked
last_full_replay_at
last_pointer_gap_detected_at
source_confidence
```

The app can show cached data immediately with an honest sync indicator:

```text
Synced recently
Reconciling history
Archive check overdue
RPC degraded
```

### Cache invalidation

Invalidate or refresh a wallet projection when:

- a watched wallet has new transactions;
- a known task CID was not hydrated yet;
- a reward allocation wallet pays the user;
- archive reconciliation finds a missing pointer;
- context grants change;
- protocol schema version changes;
- user manually requests replay.

## Performance Bottlenecks

Expected bottlenecks and mitigations:

### PFTL transaction confirmation

Issue: pointer events require ledger transactions.

Mitigation:

- Show optimistic local state as `pending_chain`.
- Mark canonical only after tx confirmation.
- Queue signing/submission locally for Codex.
- Use per-user allocation wallets to parallelize reward payments.

### RPC history scans

Issue: archive `account_tx` scans are slow and can be incomplete on non-archive
nodes.

Mitigation:

- WSS hot sync for recent transactions.
- Wallet-scoped sync checkpoints.
- Archive reconciliation on a slower cadence.
- Use cheap/local RPC for current balance and recent ledgers.
- Use production/archive RPC for historical proof and gap repair.

### IPFS hydration

Issue: fetching and decrypting many CIDs can be slow.

Mitigation:

- Hydrate only task-list summary fields first.
- Lazy hydrate task detail.
- Cache encrypted blobs by CID.
- Cache decrypted summary only under explicit policy.
- Keep reward payload task-history snapshots to reduce dependency on many old
  CIDs.

### LLM task generation and verification

Issue: LLM calls dominate latency for task issuance, verification asks, and
reward scoring.

Mitigation:

- Emit `TASK_REQUESTED` quickly.
- Let task authority write `TASK_OFFERED` after generation completes.
- Separate `VERIFICATION_REQUESTED` from initial submission.
- Use queues and honest UI states.

### Reward wallet liquidity

Issue: payout fails if the active reward wallet is empty or unavailable.

Mitigation:

- Per-user allocation wallets with minimum/target balances.
- Treasury top-up jobs.
- Wallet health monitoring.
- Retry with explicit `reward_failed_retryable` projection state.

## Database As Cache

The app database should contain at least these logical tables or equivalents:

```text
wallet_accounts
  account_id
  user_wallet
  allocation_wallet
  authority_wallet
  active flags

pointer_events
  wallet
  tx_hash
  ledger_index
  tx_index
  memo_index
  cid
  kind
  schema
  task_id
  context_id
  flags
  direction
  observed_at
  source

payload_cache
  cid
  encrypted_sha256
  schema
  content_kind
  hydrated_at
  decrypt_status
  payload_summary

task_events
  task_id
  event_id
  event_type
  source_tx_hash
  source_cid
  actor_wallet
  subject_wallet
  authority_wallet
  allocation_wallet
  canonical_order
  payload

task_projection
  task_id
  subject_wallet
  status
  title
  description_preview
  task_kind
  reward_offer
  reward_actual
  accept_by
  deadline_at
  latest_event_id
  source_confidence
  updated_at
```

These tables are a materialized view. The reducer can rebuild them.

## Legal And Privacy Boundary

Wallet-scoped replay creates a better disclosure boundary.

For a user-specific legal or support request, the system should be able to
produce:

- pointer events involving the user's wallet;
- pointer events involving the user's allocation wallet;
- relevant task authority events for tasks issued to that wallet;
- encrypted CIDs and decrypted payloads only where the service has lawful and
  technical access;
- derived DB projections for that wallet.

It should not require dumping unrelated users' global task state.

This requires discipline:

- no global task row as the only source of truth;
- no plaintext context as the default server record;
- no cross-user reward wallet mixing where avoidable;
- no web-only action that cannot be represented as a pointer event.

## Migration From PFTasks

Migration should be staged.

### Phase 1: Read-model bridge

In Task Node Official:

- Add a real task-history adapter.
- Ingest PFTasks indexed rows for pending/in-flight tasks.
- Ingest PFTL reward/context/task pointers where available.
- Project into the new task UI.
- Keep the UI source-agnostic.

This gives users real pending task data quickly while preserving the target
shape.

### Phase 2: Pointer-native submissions

- Make initial submission and verification response emit
  `TASK_SUBMISSION` pointers.
- Keep SQL as cache only.
- Require task IDs and submission IDs to be portable.

### Phase 3: Pointer-native task offers

- Generate task offer payload.
- Upload encrypted offer to IPFS.
- Emit `TASK` pointer from task authority wallet.
- Only then mark the task canonical `proposed`.

### Phase 4: Per-user allocation wallets

- Map each user wallet to an allocation wallet.
- Fund allocation wallets from treasury.
- Emit allocation claim/policy events.
- Reward from allocation wallet, not global treasury.

### Phase 5: PFTasks interface deprecation

- Freeze old PFTasks web UX as legacy.
- Keep read-only migration/index endpoints.
- Move active work to Task Node Official, CLI, and local Codex runtime.
- Keep prompts/policies as reusable modules, not web-app-bound state.

## Mapping Current PFTasks To PFTL Events

| Current PFTasks action | Current storage | Target event |
| --- | --- | --- |
| User asks for task in chat | `chat_messages`, prompt input | `pf.task.request.v1` |
| LLM generates task | `tasks`, `task_events.task_generated` | `pf.task.offer.v1` |
| User accepts | `tasks.status = in_progress`, `task_accepted` | `pf.task.update.v1: accepted` |
| User refuses | `tasks.status = refused`, refusal fields | `pf.task.update.v1: rejected` |
| Offer expires/no response | refusal/no-response state | `pf.task.update.v1: expired` |
| User submits initial artifact | `task_submissions`, `submission_recorded` | `pf.task.submission.v1` |
| System asks verification | `verification_ask`, `verification_requested` | `pf.task.update.v1: verification_requested` |
| User sends verification evidence | encrypted IPFS, pending tx | `pf.task.verification_response.v1` |
| Reward scoring completes | `reward_payload`, queue status | cache-only until payout |
| Reward paid/skipped | reward tx with `pf.ptr/v4` | `pf.reward.v1` |

## Task Node Official Implementation Path

Current Task Node Official still serves mock tasks from
`server/app-state.js` through `/api/tasks`. Context history already has a
PFDocs-style pointer import path, but task/reward pointers are not yet a first
class task-history surface.

Recommended next implementation:

1. Add `server/task-history.js`.
2. Define the normalized event envelope and reducer.
3. Add `/api/task-history` returning projected wallet-scoped task state.
4. Add indexed PFTasks import for pending/in-flight rows.
5. Add PFTL pointer import for `TASK`, `TASK_UPDATE`, `TASK_SUBMISSION`, and
   `REWARD`.
6. Replace mock task data with the projection.
7. Keep task UI unaware of source: PFTasks bridge, RPC replay, or cache.
8. Add tests for reducer transitions, duplicate events, missing CIDs, reward
   reconstruction, expired offers, and mixed legacy/native history.

## Acceptance Criteria

The architecture is working when:

- A wallet can replay a rewarded historical task from PFTL pointers and IPFS.
- A wallet can see pending/in-flight legacy tasks from the indexed bridge.
- New task offers are written as pointer events before becoming canonical.
- A Codex local runtime can sync tasks without the web app.
- The web app can delete and rebuild task projections from pointer events.
- The app does not perform full archive hydration on every page load.
- Reward payment uses allocation wallets or an explicitly comparable wallet
  pool strategy.
- A user-specific export can be produced without exposing unrelated users'
  task records.

## Open Questions

1. Should `TASK_REQUESTED` be mandatory for user-requested tasks, or can the
   first canonical event always be `TASK_OFFERED` with embedded request text?
2. Should allocation wallet mapping be public, encrypted, or split between a
   public pointer and private policy payload?
3. How much decrypted context summary may the server cache for hive context?
4. Should acceptance be signed directly by the user wallet every time, or can
   an agent grant sign acceptance for Codex under scoped permissions?
5. What is the archive reconciliation cadence for high-history wallets?
6. Do we need a protocol-level `TASK_VERIFICATION_REQUEST` content kind later,
   or is `TASK_UPDATE` sufficient?

## Recommendation

Proceed with the PFTL-native design.

It is a lift, but it is the correct canonical architecture. The existing
PFTasks SQL engine solved the first product loop, but it is not the right
foundation for portable agent work, open-source playback, wallet-scoped audit,
or arbitrary UX clients. The target should be:

```text
PFTL pointer events + encrypted IPFS payloads = canonical state
database/cache/index = fast projection
web app / Codex / CLI = clients
```

