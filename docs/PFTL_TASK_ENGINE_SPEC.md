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

Every encrypted payload should also include a clear recipient manifest outside
the plaintext body or in the encrypted envelope metadata:

```json
{
  "encryption": {
    "suite": "x25519_xchacha20poly1305",
    "recipients": [
      {
        "role": "user",
        "wallet": "r...",
        "kid": "user x25519 key id"
      },
      {
        "role": "task_node_service",
        "wallet": "r... or service id",
        "kid": "task node x25519 key id"
      },
      {
        "role": "reward_or_verification_service",
        "wallet": "allocation wallet or service id",
        "kid": "service x25519 key id"
      }
    ]
  }
}
```

Do not encrypt directly "to a seed." Wallet seeds authorize signing. Payloads
are encrypted to recipient public keys, normally X25519 keys derived, registered,
or associated with the relevant wallet/service identity. The reward/allocation
wallet may have a companion encryption key if the reward service needs direct
decrypt access, but the payout wallet does not need plaintext simply to send a
reward transaction.

## Task Request Bundle

The task request bundle is a first-class protocol object. It should not be a
React state blob, chat database row, or prompt-only construction. Any client
that can produce the same bundle should be able to request or generate a task
without the Task Node Official UX.

The bundle captures the evidence used to generate a task:

- the explicit user request, if one exists;
- recent chat messages;
- relevant historical chat excerpts or summaries;
- context document references;
- optional context summaries;
- wallet and policy metadata;
- source client metadata.

The bundle should be content-addressed, encrypted, and referenced by task
request and task offer events.

Recommended schema:

```json
{
  "schema": "pf.task.request_bundle.v1",
  "bundle_id": "bundle_...",
  "subject_wallet": "r...",
  "created_at": "ISO-8601",
  "client": {
    "name": "tasknodeofficial|codex|python|cli",
    "version": "semver",
    "session_id": "optional"
  },
  "request": {
    "request_id": "req_...",
    "request_text": "user request or null for system-issued task",
    "requested_task_kind": "personal|network|alpha|system",
    "source": "user_chat|system_allocation|agent|scheduler"
  },
  "recent_chat": {
    "messages": [
      {
        "id": "msg_...",
        "role": "user|assistant|system|tool",
        "content": "bounded message content",
        "created_at": "ISO-8601",
        "digest": "sha256:..."
      }
    ],
    "summary": "bounded recent-chat summary",
    "window": {
      "started_at": "ISO-8601",
      "ended_at": "ISO-8601"
    }
  },
  "relevant_history": {
    "strategy": "semantic_retrieval|recency|manual|none",
    "items": [
      {
        "kind": "chat_summary|task_summary|context_excerpt|reward_summary",
        "cid": "baf... or null",
        "digest": "sha256:...",
        "summary": "bounded relevant item summary",
        "score": 0.82
      }
    ]
  },
  "context": {
    "primary_context_doc": {
      "context_id": "ctx_...",
      "cid": "baf...",
      "digest": "sha256:...",
      "summary": "bounded context summary",
      "revision": "optional"
    },
    "additional_refs": [
      {
        "kind": "profile|portfolio|network_context|hive_context",
        "cid": "baf...",
        "digest": "sha256:...",
        "summary": "bounded summary"
      }
    ]
  },
  "policy": {
    "task_policy_version": "task-policy-v1",
    "reward_policy_version": "reward-policy-v1",
    "generation_policy_version": "taskgen-policy-v1"
  },
  "wallet": {
    "subject_wallet": "r...",
    "allocation_wallet": "r... or null",
    "authority_hint": "r... or null"
  }
}
```

Rules:

- The full bundle is encrypted and uploaded to IPFS.
- Task request events may point to the bundle CID.
- Task offer events must carry the request bundle CID or digest when the offer
  was generated from a bundle.
- The task-generation prompt consumes the bundle or a deterministic projection
  of the bundle.
- UX-specific chat IDs may be included as metadata, but they are not canonical.
- Context documents remain their own IPFS objects. The bundle references them
  by CID and digest rather than copying the full context document by default.
- Portable clients may create bundles directly from local chat logs, local
  context files, or Codex transcripts.

Recommended payload schemas:

### `pf.task.request.v1`

Content kind: `TASK`

User asks for a task against a context block. Optional for system-issued tasks.

```json
{
  "schema": "pf.task.request.v1",
  "request_id": "req_...",
  "subject_wallet": "r...",
  "request_bundle": {
    "bundle_id": "bundle_...",
    "cid": "baf...",
    "digest": "sha256:...",
    "summary": "short task-generation bundle summary"
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
  ],
  "generation": {
    "model": "chat-latest",
    "prompt_version": "taskgen-minimal-v1",
    "prompt_digest": "sha256:...",
    "request_bundle_cid": "baf... or null",
    "request_bundle_digest": "sha256:...",
    "input_packet_digest": "sha256:...",
    "latency_ms": 1200
  }
}
```

The task offer must include enough generation metadata to audit which prompt,
model, and input packet produced the task without requiring the UI database.
The full task request bundle remains encrypted in IPFS; the offer can carry
only hashes, summaries, and CIDs needed for replay.

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

### Verification Evidence Adapters

Verification evidence must be normalized before it becomes encrypted IPFS
content. The web app, Codex runtime, and any external agent should produce the
same payload shape so replay does not depend on a specific UX.

Canonical adapter inputs:

- `text`: bounded text summary supplied by the user or agent.
- `url`: public HTTP(S) text/HTML evidence. Gists are fetched through the
  GitHub gist API and aggregated by text file. Private collaboration URLs and
  binary/download URLs are rejected as URL evidence.
- `github_commit`: public GitHub commit metadata and bounded file summary.
- `screenshot`: image evidence described by a vision model into a concise
  verification-relevant text record. The original screenshot should be hashed
  and may be stored as encrypted IPFS content.
- `file`: document evidence. PDFs and DOCX files are extracted into bounded
  text with parser provenance; binary documents should not be smuggled through
  URL evidence.
- `mixed`: ordered list of the above evidence records.

The Python reference implementation is `tasknode_pftl.verification`; runnable
examples live in `tasknode_pftl.scenarios.verification_evidence_examples`.
Those examples generate screenshot, PDF, DOCX, and public gist evidence
packets with `pf.task.evidence.v1` shape, then build a
`pf.task.verification_response.v1` wrapper ready to encrypt, pin, and point to
from PFTL.

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

## Reference Simulation Harness

Do not block protocol work on the app surface. The first real implementation
should be a reference harness that simulates user behavior outside the web app.
This gives us a canonical example other builders can inspect and copy.

Recommended repo layout:

```text
reference_clients/
  python/
    README.md
    pyproject.toml
    tasknode_pftl/
      __init__.py
      config.py
      wallets.py
      encryption.py
      ipfs.py
      pointers.py
      taskgen.py
      reducer.py
      sync.py
      tx_queue.py
      scenarios/
        issue_task.py
        accept_task.py
        reject_task.py
        submit_initial.py
        request_verification.py
        submit_verification.py
        pay_reward.py
        full_lifecycle.py
    tests/
      test_reducer.py
      test_encryption_recipients.py
      test_task_id.py
      test_tx_queue.py
```

The harness should create or load wallets, fund test wallets, write encrypted
payloads to IPFS, submit `pf.ptr/v4` transactions, sync the resulting wallet
history, and rebuild task state from the reducer. It should not require the
Task Node Official React app.

The canonical simulation scenario:

1. Create or load a user wallet.
2. Create or load a task authority wallet.
3. Create or load a per-user allocation/reward wallet.
4. Build a portable task request bundle from context, recent chat, and
   relevant history.
5. Generate a task offer using the minimal task-generation prompt.
6. Encrypt the task content for the user, Task Node service, and optional
   reward/verification service recipient.
7. Upload the encrypted offer to IPFS.
8. Submit the `TASK` pointer from the task authority wallet.
9. Accept or reject from the user wallet.
10. Submit initial evidence from the user wallet.
11. Issue the follow-on verification request from the task authority wallet.
12. Submit the verification evidence packet from the user wallet.
13. Score and pay the reward from the allocation wallet.
14. Replay wallet history and verify the reducer reaches `rewarded`.

This harness is also where we should run latency measurements before putting
flows into the UX.

## Task Generation Contract

PFTasks has a large prompt surface. The pointer-native engine should scope task
generation down to a small, testable contract.

Task generation consumes a task request bundle. The model-facing input may be a
bounded deterministic projection of the encrypted bundle so prompt size stays
controlled, but the bundle CID/digest remains the portable source object.

Recommended task-generation input packet:

```json
{
  "schema": "pf.taskgen.input.v1",
  "request_bundle": {
    "bundle_id": "bundle_...",
    "cid": "baf...",
    "digest": "sha256:..."
  },
  "request": {
    "request_text": "user request or null for system-issued task",
    "requested_task_kind": "personal|network|alpha|system"
  },
  "context": {
    "context_cid": "baf...",
    "context_digest": "sha256:...",
    "summary": "bounded context summary"
  },
  "chat": {
    "recent_chat_summary": "bounded recent-chat summary",
    "relevant_history_summary": "bounded relevant-history summary",
    "recent_messages": [
      {
        "role": "user|assistant|system",
        "content": "bounded content",
        "created_at": "ISO-8601"
      }
    ],
    "summary": "bounded conversation summary"
  },
  "wallet": {
    "subject_wallet": "r...",
    "allocation_wallet": "r..."
  },
  "policy": {
    "task_policy_version": "task-policy-v1",
    "reward_policy_version": "reward-policy-v1"
  }
}
```

Recommended task-generation output packet:

```json
{
  "schema": "pf.taskgen.output.v1",
  "title": "short title",
  "description": "task body",
  "task_kind": "personal|network|alpha|system",
  "submission_requirement": {
    "type": "text|url|github_commit|screenshot|file|mixed",
    "criteria": "specific acceptance criteria"
  },
  "verification_policy": {
    "followup_required": true,
    "mode": "standard_followup"
  },
  "reward_offer": {
    "amount_estimate_pft": "3200.00"
  },
  "deadline": {
    "accept_by": "ISO-8601",
    "deadline_at": "ISO-8601 or null"
  }
}
```

Model policy:

- Default low-latency task generation should use `chat-latest`.
- Benchmark the same input packets against `gpt-5.5` high reasoning for quality
  and latency deltas.
- Store model name, reasoning mode, prompt version, prompt digest, input packet
  digest, request bundle CID/digest, output digest, latency, and parse result
  in the encrypted task offer metadata.
- Keep the prompt minimal. The generation prompt should transform a structured
  input packet into a structured output packet, not carry the whole PFTasks
  historical prompt surface forward.
- If `chat-latest` produces an invalid or low-confidence packet, retry once
  with a stricter repair prompt or route to `gpt-5.5` high reasoning.

The output parser should be deterministic and schema-first. Do not let task
generation silently fall back to free text.

## PFTL Transaction Queueing

PFTL transactions are synchronous from the perspective of a signing wallet. A
single wallet cannot safely blast many independent transactions at once without
sequence contention, unclear failure handling, and poor replay semantics.

The protocol implementation should assume one serialized transaction queue per
signing wallet:

```text
wallet_tx_queue(authority_wallet)
  TASK offer pointers
  TASK_UPDATE verification request pointers

wallet_tx_queue(user_wallet)
  accept/reject pointers
  submission pointers
  context grant pointers

wallet_tx_queue(allocation_wallet)
  reward payment pointers
```

Rules:

- Only one in-flight transaction per signing wallet unless the client has a
  proven sequence reservation strategy.
- Every queued transaction has an idempotency key derived from event type,
  task id, payload CID, and signing wallet.
- The queue records prepared, submitted, confirmed, failed-retryable, and
  failed-final states.
- A confirmed transaction is the canonical event source. A prepared or
  submitted transaction is only optimistic local state.
- Different wallets may proceed concurrently. This is the practical reason to
  use per-user allocation wallets for reward payment and potentially an
  authority-wallet pool for high-volume task issuance.

If one central task authority wallet becomes a bottleneck, split authority into
policy-approved authority shards:

```text
task_authority_root
  POLICY grants
    task_authority_shard_1
    task_authority_shard_2
    task_authority_shard_3
```

The reducer accepts task offers from approved authority shards and rejects
offers from unknown wallets.

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
- Serialize transactions per signing wallet and scale concurrency by adding
  wallets, not by submitting many simultaneous transactions from one wallet.

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
- Use `chat-latest` for low-latency task generation by default.
- Benchmark selected packets with `gpt-5.5` high reasoning and store the
  quality/latency comparison.
- Keep generation prompts small, schema-bound, and packet-driven.

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

### Phase 0: Reference simulation

- Build the Python reference harness outside the app surface.
- Simulate the full lifecycle with created wallets.
- Validate encryption recipients, pointer writing, transaction serialization,
  reducer playback, and reward payout.
- Use this harness as the protocol reference for other clients before coupling
  flows to Task Node Official UX.

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

1. Add the Python reference harness under `reference_clients/python/`.
2. Add `server/task-history.js`.
3. Define the normalized event envelope and reducer.
4. Add `/api/task-history` returning projected wallet-scoped task state.
5. Project cached PFTL pointers for `TASK`, `TASK_UPDATE`, `TASK_SUBMISSION`,
   and `REWARD`.
7. Replace mock task data with the projection.
8. Keep task UI unaware of source: PFTasks bridge, RPC replay, or cache.
9. Add tests for reducer transitions, duplicate events, missing CIDs, reward
   reconstruction, expired offers, and mixed legacy/native history.

## Acceptance Criteria

The architecture is working when:

- A wallet can replay a rewarded historical task from PFTL pointers and IPFS.
- A wallet can see pending/in-flight legacy tasks from the indexed bridge.
- New task offers are written as pointer events before becoming canonical.
- The Python reference harness can simulate request, offer, accept/reject,
  submission, verification request, verification response, and reward without
  using the app UI.
- A Codex local runtime can sync tasks without the web app.
- The web app can delete and rebuild task projections from pointer events.
- The app does not perform full archive hydration on every page load.
- Transactions are serialized per signing wallet, with idempotency and retry
  state recorded.
- Task content is encrypted to the user and Task Node service, with optional
  reward/verification service recipient keys where needed.
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
7. Does one task authority wallet handle enough throughput, or do we need
   authority shards from the beginning?
8. Which task categories require the allocation/reward service to decrypt task
   content, versus only the Task Node verification service?

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

## Reviewer To Do List

Review implementation against this document (PFTL TASK ENGINE SPEC). Mark each item when verified.

### Memory Efficiency
- [ ] Operational paths use checkpoints, caches, or bounded batch sizes.
- [ ] Cache/index strategy keeps UI reads O(projection) not O(chain history).

### Code Quality
- [ ] Commands, env vars, and file paths verified against repo.
- [ ] Event schemas versioned (`pf.task.*.v1`); parser rejects unknown versions safely.

### Coherence
- [ ] Doc aligns with wiki and spec docs for same topic.
- [ ] Spec recommendation (DB projection only) reflected in implemented architecture docs.
- [ ] Lifecycle diagram matches task-lifecycle wiki and shared module.

### Bloat
- [ ] Engineering doc scoped to its audience; defers product detail to wiki.
- [ ] PFTasks deprecation rationale concise; avoid duplicating full old system docs.

### Security
- [ ] No secrets committed; custody boundaries explicit.
- [ ] Wallet-native signing model preserved; no server-side user seed handling.
- [ ] Encrypted IPFS mandatory for task payloads.
