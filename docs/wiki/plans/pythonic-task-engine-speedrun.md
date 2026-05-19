# Pythonic Task Engine Speedrun

## Status

Stage A and Stage B are implemented and have been run live against PFTL testnet.
The Python engine can execute a real N=1 task request from the `task_sample` app
bundle through offer, acceptance, evidence submission, verification request,
verification response, AI scoring, PFT payout, replay receipt generation, and
Postgres projection import. The Stage B speedrun creates 10 wallets, shards them
across authority and allocation wallets, exercises representative evidence and
edge-case paths, writes batch receipts, and imports those receipts into the
Postgres projection cache.

This plan extends `docs/wiki/plans/getting-tasks-over-line.md`. That plan
defines the wallet-first PFTL task lifecycle and app-data request bundle. This
document scopes the next implementation lift: a raw Python task engine speedrun
that proves task request, acceptance, evidence, verification, scoring, and real
reward payout outside the React app.

## Objective

Build a reproducible Python reference flow that a Codex user can run without the
web UX and still exercise the complete Task Node lifecycle:

1. Load the existing task queue from the Postgres projection cache.
2. Request a task from a user wallet.
3. Generate a task offer from TaskNode authority.
4. Accept or refuse the task from the user wallet.
5. Submit initial evidence.
6. Generate a verification request.
7. Submit verification evidence.
8. Score the result.
9. Pay a real PFT reward from an allocation wallet.
10. Replay PFTL/IPFS state back into the task projection cache.

The engine must be chain-verifiable without Postgres. Postgres is only a fast
read model and fixture source. If the cache is deleted, PFTL pointer events plus
encrypted IPFS payloads must be enough to rebuild the task state.

Implementation order:

1. Run one live Codex-operated task from request through payout, with Codex
   submitting the evidence as the user.
2. After the N=1 path is correct, run the 10-wallet representative speedrun.

## Non-Goals

- Do not start with app UX changes.
- Do not copy PFTasks SQL-first task truth.
- Do not broaden the task JSON contract beyond what the engine actually needs.
- Do not use deterministic fallback task generation in runtime task paths.
- Do not print, log, commit, or write wallet seeds into receipts.

## Current Assets

Useful Task Node Official pieces:

- `reference_clients/python/tasknode_pftl/scenarios/task_engine_speedrun.py`
  runs the current N=1 live task engine walkthrough and dispatches Stage B with
  `--stage n10`.
- `reference_clients/python/tasknode_pftl/scenarios/task_engine_stage_b.py`
  contains the Stage B multi-wallet representative runner.
- `reference_clients/python/tasknode_pftl/engine/` contains the engine modules
  for task queue cache loading, lifecycle orchestration, evidence packet
  construction, model-based verification/scoring, and receipts.
- `reference_clients/python/tasknode_pftl/scenarios/full_lifecycle.py` already
  proves the single-wallet encrypted PFTL/IPFS lifecycle.
- `reference_clients/python/tasknode_pftl/scenarios/app_request_lifecycle.py`
  can build a request bundle from real app data such as `task_sample`.
- `reference_clients/python/tasknode_pftl/scenarios/verification_evidence_examples.py`
  proves URL, screenshot, PDF, and DOCX evidence readers.
- `reference_clients/python/tasknode_pftl/taskgen.py` has the minimal
  task-generation contract.
- `reference_clients/python/tasknode_pftl/verification.py` contains the
  evidence adapters.
- `server/db/migrations/006_task_projections.sql` and the PFTL cache migrations
  define the current projection/cache direction.
- `prompts/task_engine/` contains the simplified prompt assets.

Useful PFTasks references:

- `api/migrations/016_task_evidence_cache.sql` shows the legacy evidence cache:
  evidence type, artifact JSON, image description, file metadata, sha256,
  encrypted CID, and purged image bytes.
- `worker/src/jobs/reward_task/execution.js` shows the legacy reward processor:
  evidence bucket selection, URL content handling, submission scoring, retry
  behavior, reward history payloads, and payout jobs.
- `worker/src/jobs/reward_task/runners.js` shows submission snapshot loading,
  Gist URL handling, GitHub commit evidence handling, and reward claim locks.
- `shared/network_assets/normalize.js` shows artifact URL extraction and
  classification patterns.

PFTasks is reference material only. The new Python engine should be smaller,
wallet-native, and replayable.

## Architecture

### Python Package Shape

Add a small engine package under `reference_clients/python/tasknode_pftl/engine/`:

```text
engine/
  cache.py              # Postgres task projection and chat/context loaders
  lifecycle.py          # request, offer, accept/refuse, submit, verify, reward
  evidence_suite.py     # canonical evidence fixtures and adapters
  scoring.py            # reward scoring prompt call and deterministic validation
  rewards.py            # allocation wallet payout and idempotency helpers
  receipts.py           # markdown/json receipts
```

Add one scenario entrypoint:

```text
reference_clients/python/tasknode_pftl/scenarios/task_engine_speedrun.py
```

The scenario should compose existing modules instead of duplicating pointer,
encryption, IPFS, wallet, reducer, or taskgen code.

The N=1 implementation currently supports:

- `--stage n1`;
- `--provider frontier` with OpenAI `chat-latest`;
- `--provider private` with OpenRouter `deepseek/deepseek-v4-pro` and ZDR
  provider routing;
- app-backed bundle loading from `task_sample`;
- mixed, URL, screenshot, text, file, code, and GitHub commit evidence packet
  construction;
- real model calls for task generation, verification request generation, and
  reward scoring;
- fail-closed behavior when model providers fail;
- public receipt import into `task_projections`.

The Stage B implementation currently supports:

- `--stage n10`;
- 10 generated user wallets by default;
- authority wallet sharding;
- allocation/reward wallet sharding;
- shared queue locks per signing wallet;
- real model calls for task generation, verification request generation, and
  scoring;
- URL, screenshot, text, code, file, mixed evidence, faulty evidence,
  wrong-evidence, refusal/re-request, and duplicate-guard cases;
- batch public receipts with per-task public receipts;
- batch receipt import into `task_projections`.

### Wallet Model

PFTL wallets are synchronous. The speedrun should run many users concurrently,
while serializing transactions per signing wallet.

Roles:

- `user_wallet`: signs task request, accept/refuse, submissions, verification
  responses.
- `task_authority_wallet`: signs task offers and verification requests.
- `allocation_wallet`: pays rewards for one user or a small shard.
- `treasury_or_faucet_wallet`: funds test wallets and tops up allocation
  wallets for testnet only.

V1 speedrun parameters:

```text
--wallet-count 10
--authority-count 2
--allocation-shard-size 5
--reward-pft 0.75
```

Execution rule:

- one queue and lock per signing wallet;
- parallelism across different wallets;
- no parallel submissions from the same wallet;
- idempotency key for every pointer and reward transaction;
- retry only safe network failures, not semantic failures.

## Postgres Cache Contract

The Python engine must reference the Postgres cache before task generation.

Minimum reads:

- linked account and wallet, when using an app-backed fixture;
- current context document;
- last 3 deep memories;
- last 36 recent memory records;
- recent chat window or selected `task_sample`;
- current task queue from `task_projections`.

Task queue use:

- outstanding and pending verification tasks prevent duplicate task offers;
- refused and rewarded tasks are included as bounded history;
- cache rows are included in the request bundle as advisory context;
- if the cache is unavailable, the run may fall back to direct replay but must
  mark the receipt as `cache_unavailable`.

Postgres writes:

- importing replay receipts into `task_projections` is allowed after chain
  events exist;
- inserting canonical task truth directly into task tables is not allowed.

## Provider Policy

Task generation defaults:

- app Frontier request: OpenAI `chat-latest`;
- app Private request: OpenRouter `deepseek/deepseek-v4-pro` with ZDR provider
  routing;
- task interface later: user-selectable provider/mode;
- Python speedrun default: OpenAI `chat-latest` unless `--provider private` is
  passed.
- provider costs for this protocol milestone are paid by the project and
  recorded in receipts, not billed to the user.

CLI shape:

```bash
python3 -m tasknode_pftl.scenarios.task_engine_speedrun \
  --wallet-count 10 \
  --provider frontier \
  --taskgen-model chat-latest \
  --evidence-suite all \
  --real-rewards
```

Private-mode CLI shape:

```bash
python3 -m tasknode_pftl.scenarios.task_engine_speedrun \
  --provider private \
  --taskgen-model deepseek/deepseek-v4-pro \
  --openrouter-zdr-only
```

Verification and scoring may use the same provider selection. Screenshot
evidence uses OpenAI vision in v1, even when task generation uses the private
OpenRouter path. This can be revisited later.

## Prompt Migration

Keep prompt migration deliberately small.

Existing prompt assets:

- `taskgen_minimal_v1.md`: generate one task from request/context/memory/chat.
- `verification_request_v1.md`: ask one follow-up verification request.
- `evidence_screenshot_read_v1.md`: read screenshot evidence.
- `reward_scoring_v1.md`: score completion against task offer and evidence.

Required changes before live reward scoring:

1. Promote `reward_scoring_v1.md` from reserved to runtime-loaded.
2. Add a Python `score_submission` adapter that returns:
   - `decision`: `reward`, `partial_reward`, or `reject`;
   - `reward_pft`;
   - `completion`;
   - `evidence_quality`;
   - `reason`;
   - `user_feedback`.
3. Keep the output schema small and strict.
4. Store prompt version, digest, input digest, output digest, model, latency, and
   parse status in the encrypted scoring payload.
5. Do not add PFTasks legacy fields such as broad rationale essays, tactic score
   essays, or unrelated alignment summaries.

## Evidence Surface Matrix

The speedrun should cover the major PFTasks-style submission surfaces through
canonical Python evidence packets.

| Surface | Initial submission | Verification response | Reader/check |
| --- | --- | --- | --- |
| Text body | User writes an attestation or concise artifact summary. | User answers a specific follow-up question. | Direct text digest and criteria match. |
| Public URL | User submits a public URL or GitHub Gist. | User answers about a detail found at the URL. | `read_external_url_evidence`, Gist aggregation, bounded HTML/text extraction. |
| Screenshot | User submits a PNG/JPG screenshot. | User answers about visible state in the screenshot. | Vision description through `evidence_screenshot_read_v1.md`. |
| Code sample | User submits code text, diff, commit URL, or repository URL. | User identifies files changed, behavior, and test result. | Text/code reader plus GitHub URL normalization where public. |
| File | User submits PDF, DOCX, Markdown, TXT, JSON, or CSV. | User answers about a specific extracted detail. | `read_file_evidence` with PDF/DOCX/plain-text paths. |
| Mixed | User submits URL plus screenshot or file plus text. | User reconciles details across artifacts. | Multi-packet evidence bundle. |

Canonical fixtures should live under:

```text
reference_clients/python/fixtures/evidence/
```

Generated run artifacts should live under:

```text
reference_clients/python/runs/<run_id>/
```

The committed fixture set should include at least one screenshot PNG so Codex can
inspect the expected evidence surface without using the web UX.

## Representative Live Dataset

The 10-wallet run should be representative of real app usage, not a toy fixture.

Before the 10-wallet run:

- fund 10 different PFTL user wallets;
- create 10 different canonical context documents;
- publish/cache those context documents through the same IPFS and chain pointer
  path used by the app;
- generate representative chat history and memory history for each user in the
  same bundle shape the app passes to task generation;
- allocate different task and verification types across the 10 users;
- include URL evidence, screenshot evidence, code evidence, text evidence, file
  evidence, and mixed evidence;
- use public Gists for representative URL evidence when useful;
- record every generated context document, memory bundle, chat bundle, task
  request, evidence packet, verification prompt, and reward decision in the run
  receipt.

The N=1 run should use the same data shape, but only one funded wallet and one
canonical app-style bundle. That run is the human-readable walkthrough that
proves the lifecycle before scaling to 10 wallets.

## Required Edge Cases

Each run should include positive and negative paths.

| Case | Expected state |
| --- | --- |
| User refuses task | `refused`; no submission accepted; no reward. |
| User refuses then re-requests | first task remains `refused`; new request receives a new task id. |
| User submits faulty evidence | verification request is still issued; the verification should become more specific or harder; no full reward unless the verification response passes. |
| User submits correct evidence | verification response scores rewardable; PFT reward paid. |
| User submits wrong evidence type | verification request asks for the missing required evidence; state does not become rewarded until the correct surface is submitted. |
| Duplicate request | duplicate guard references existing queue and either refuses generation or creates distinct task with explicit reason. |
| Replay after cache wipe | projection rebuilds from PFTL/IPFS. |
| Allocation wallet low balance | reward job waits for top-up or fails visibly without corrupting task state. |
| Provider failure | task generation/scoring fails closed; no fake task or reward pointer. |

## Speedrun Scenario

### Stage A: N=1 Live Codex Walkthrough

First, run one live task with Codex acting as the user submitting evidence.

The run should:

- use one funded PFTL user wallet;
- load one app-style request bundle containing context document, memory, deep
  memory, recent chat, and task queue cache;
- request a task through the same Python engine that the 10-wallet run will use;
- generate the task with OpenAI `chat-latest` by default;
- accept the task;
- submit real evidence from one canonical evidence surface;
- generate a verification request;
- submit verification evidence;
- score the task;
- pay a real PFT reward from an allocation wallet;
- import the replay into the projection cache so the app can show the task ex
  post;
- write a complete markdown receipt that a new Codex session can follow step by
  step.

### Stage B: 10-Wallet Representative Run

After Stage A works, the canonical multi-wallet run should exercise 10 wallets at
once:

```text
wallet 01: correct URL task -> rewarded
wallet 02: correct screenshot task -> rewarded
wallet 03: correct text task -> rewarded
wallet 04: correct code sample task -> rewarded
wallet 05: correct PDF/DOCX task -> rewarded
wallet 06: mixed evidence task -> rewarded
wallet 07: faulty evidence -> verification requested -> rejected or partial reward
wallet 08: wrong evidence type -> rejected
wallet 09: refuses task -> re-requests -> accepts -> rewarded
wallet 10: duplicate-like request -> duplicate guard path -> distinct/rejected by policy
```

Concurrency requirements:

- all 10 user flows start in the same run;
- each wallet queue is serialized;
- authority and allocation wallets use their own queues;
- receipt includes per-wallet queue timing, tx count, and final status;
- final projection summary shows counts by `outstanding`, `verification`,
  `refused`, and `rewarded`.

## Canonical Lifecycle Event Schemas

Reuse the existing pointer/payload conventions and keep each payload small:

- `pf.task.request_bundle.v1`
- `pf.task.offer.v1`
- `pf.task.acceptance.v1`
- `pf.task.refusal.v1`
- `pf.task.submission.v1`
- `pf.task.verification_request.v1`
- `pf.task.verification_response.v1`
- `pf.task.reward_decision.v1`
- `pf.reward.v1`

Every payload must include:

- `schema`;
- `task_id` when known;
- `request_id` or `submission_id` where applicable;
- `subject_wallet`;
- `created_at`;
- relevant CIDs and digests;
- prompt metadata when a model was used.

Every PFTL pointer must include enough memo metadata for the reducer to route it
without decrypting the payload first.

## Receipt Requirements

Each speedrun writes:

```text
reference_clients/python/runs/<run_id>/
  TASK_ENGINE_SPEEDRUN.md
  receipt.json
  projections.json
  queue_report.json
  evidence/
  payloads_public_redacted/
```

The markdown receipt must include:

- run id and timestamp;
- provider/model choices;
- user wallet addresses, authority wallets, allocation wallets;
- no seeds;
- task ids;
- evidence type per task;
- IPFS CIDs;
- PFTL tx hashes;
- reward tx hashes and amounts;
- before/after PFT balances;
- cache import command;
- final reduced projection table;
- failures and retry counts.

## Implementation Phases

### Phase 0: PFTasks Evidence Parity Audit

Confirm exact PFTasks evidence and reward surfaces before coding. Produce a short
markdown note listing the legacy evidence types, required adapters, and what is
intentionally not carried forward.

Acceptance:

- evidence matrix is confirmed against PFTasks files;
- no new Task Node behavior depends on PFTasks tables.

### Phase 1: Engine Skeleton

Create `tasknode_pftl.engine` and the `task_engine_speedrun` scenario. Wire
configuration, wallet creation, queue assignment, and receipt generation.

Status: complete for N=1 and Stage B.

Acceptance:

- `--wallet-count 2 --dry-run` builds queue assignments and receipts without
  network writes;
- no seeds in logs or receipts.

### Phase 2: Cache Loader And Representative Data

Load app-backed context, memory, chat, and `task_projections` into the request
bundle. Support both `task_sample` and synthetic users. Build the representative
dataset for the live test: 10 funded wallets, 10 canonical context docs, 10
app-shaped chat/memory bundles, and task-type assignments.

Status: complete for app-backed N=1 bundle, task queue cache, and representative
Stage B wallet-specific bundles.

Acceptance:

- goodalexander `task_sample` can be loaded by title;
- one canonical N=1 bundle can be loaded without the app UX;
- 10 canonical bundles can be generated and cached through IPFS/PFTL pointers;
- existing queue summary is present in taskgen input;
- cache unavailable is explicit.

### Phase 3: Evidence Suite

Move canonical evidence fixtures into `fixtures/evidence/` and normalize every
surface into `pf.task.evidence.v1` packets.

Status: complete for generated runtime fixtures and normalized packets.
Committed static fixtures remain optional.

Acceptance:

- URL, screenshot, code sample, text, PDF, DOCX, and mixed packets are generated;
- screenshot fixture is inspectable and described by the selected vision path;
- faulty evidence packets are generated deliberately.

### Phase 4: Single-Wallet Real Lifecycle

Run one wallet through request, offer, accept, submission, verification,
verification response, score, reward, and replay. Codex should perform the user
side of the run by submitting real evidence and verification evidence.

Status: complete. Live runs have covered both wrong-evidence and reward paths,
including a rewarded mixed-evidence run imported into Postgres.

Acceptance:

- one correct task reaches `rewarded`;
- one faulty task reaches rejected or partial state;
- all events have CIDs and tx hashes.
- the markdown receipt is readable as a step-by-step walkthrough.

### Phase 5: Multi-Wallet Concurrent Speedrun

Run the 10-wallet matrix with real PFTL transactions and real scoring.

Status: complete. Live run `task_engine_n10_2026-05-18T200932453687` produced
11 task receipts across 10 wallets: 8 rewarded, 1 refused, and 2
verification-response-submitted negative paths.

Acceptance:

- 10 user wallets complete the assigned paths;
- at least 6 rewards are paid;
- refused and faulty paths are represented;
- no wallet sends overlapping transactions from the same signing key;
- final projection rebuilds from chain/IPFS.

### Phase 6: Cache Import And App Visibility

Import the speedrun replay into the existing projection cache so the app can show
the tasks ex post.

Status: complete for receipt import. The Stage B public receipt was imported
into `task_projections` through `scripts/import-task-replay-receipts.mjs`.

Acceptance:

- `/api/tasks` shows the speedrun tasks for linked wallets;
- deleting projection rows and replaying restores the same final state;
- no fake task rows are inserted.

## Open Decisions

Resolved:

- First implementation target is N=1 first: one live Codex-operated walkthrough
  through request, evidence, verification, scoring, and real payout. The
  10-wallet representative run comes after that works.
- Screenshot evidence uses OpenAI vision in v1, even when task generation uses
  the private OpenRouter path. This can be revisited later.
- The 10-wallet run should use 10 funded wallets, 10 canonical context docs,
  representative chat/memory bundles, and IPFS/PFTL cache paths.
- Faulty evidence should still receive a verification request. The verification
  should become more specific or harder rather than short-circuiting directly to
  rejection.
- Provider costs are paid by the project during this protocol milestone and
  recorded in receipts.
- Stage B uses allocation shards by default: one allocation wallet per five user
  wallets unless the operator passes `--allocation-count`.
