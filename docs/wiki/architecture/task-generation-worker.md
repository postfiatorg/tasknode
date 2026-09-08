# Task Generation Worker

Current implementation reviewed September 6, 2026.

The task generator claims durable requests, reads their input bundle, calls the
shared task-generation model and writes a `pf.task.offer.v1` event with a task
projection. The current offer writer is offchain Postgres persistence. It does
not submit a signed offer pointer or wait for the PFTL reducer.

System Status row: `task_generation`.

## Runtime boundary

- Periodic process: Fly `worker-taskgen`, registered in `server/background-workers.js`.
- Worker: `server/task-generation-worker.js`.
- Claims/receipts: `server/repositories/task-requests.js`, table `task_requests`.
- Replay: `server/repositories/taskgen-replay-cache.js`, table `taskgen_replay_cache`.
- Model/input/output contract: `server/task-generation-contract.js`.
- Offer writer: `server/offchain-task-lifecycle.js::applyOffchainTaskOffer`.
- Visibility: `task_events` and `task_projections`, written together for the offer.

The five-second periodic loop is a backstop. Immediate timers are also
requested by intake/handoff code. Those scheduling helpers currently check the
enable flag rather than the process role, so they can execute outside the
periodic worker's process. A timer acknowledgement does not establish task
completion.

## Inputs and models

`postgres:` request bundles come from `task_requests.metadata_json.requestBundle`.
Other bundle references use the encrypted IPFS payload reader. Terminal input
is minimal; richer browser/network bundles use different assembly paths.

Personal work selects `prompts/task_engine/taskgen_personal_v1.md`. Network/Alpha
work selects `taskgen_network_v2.md` when the network-v2 flag is enabled, as in
current `fly.toml`; the v1 network prompt remains a compatibility branch.
Vercel `zai/glm-5.3` is primary through the shared `strict_json` capability,
with Ambient backup. Requested model/configuration and actual completion
provider/model are separate provenance.

Taskgen projects bounded context, history, memory, task queue and network
routing facts into `pf.taskgen.input.v1`. Network packets retain project,
operator, badge, policy, prior-output and lineage context. The model authors
concrete title, steps, submission requirement and verification policy; the
worker validates the task-output contract. Titles, descriptions, steps and
submission criteria have explicit text bounds; evidence types and verification
flags are checked without coercion. Punctuation fragments, missing fields,
object-valued text and truncated completions cannot become offers.

Before publication, a separate structured GLM 5.3 Flash readiness check verifies
that the task is coherent, the submission instructions name concrete evidence,
and the two agree. It receives only the candidate title, description, steps and
submission requirement. Failed checks retry through the existing bounded queue;
they do not publish a placeholder task. The review prompt is
`prompts/task_engine/taskgen_readiness_v1.md`, and approval provenance is stored
in generation metadata.

## Claim, retry and replay

The shared request queue claims `published` or `queued` rows with
`FOR UPDATE SKIP LOCKED`, worker/attempt IDs and attempt counts. Updates check
ownership. Heartbeats occur at stage boundaries; transient failures use durable
backoff and stale claims can be reclaimed. Claimed batches are processed
sequentially by the loop.

Replay identity includes bundle CID/digest, source/input digests, prompt digest,
model, class and policy versions. Stored normalized output is reused before
calling the model again. Unpublished cached output is revalidated and receives
the readiness check if absent. Invalid cached output is regenerated only after
checking for an already-published offer. Recorded offers are reused rather than generating a
new live task for an unchanged replay identity. Generated output is stored
before offer persistence, and a retry can search for the corresponding offer
when publication metadata is incomplete.

The provider timeout defaults to 240 seconds per provider attempt. Shared
inference may try Vercel then Ambient with separate attempt deadlines. This is
not a single 240-second outer deadline. The generation request allows 65,536
output tokens by default (minimum configured allowance 32,768). Readiness has a
separate 45-second provider/60-second total deadline and an 8,192-token allowance.

After the offer transaction, replay publication metadata, request completion
and network allocation links are written separately. These boundaries require
reconciliation after a crash; atomic offer/projection persistence alone does
not prove every receipt/link has completed.

## Status and diagnosis

Status reports stale pending requests and recent failures. A green/empty queue
does not prove that an upstream selector is creating work. Trace the request,
attempt, replay output, offer event, projection and any network allocation.

Network requests that fail before an offer can be closed through
`fail_network_task_generation_chain`. Such repair rows are operator audit
records and are hidden from the user's actionable request strip. User-created
failed requests retain their own recovery state.

Inspect `task_requests.last_error`, attempt ownership, durable retry time,
request bundle source, replay state and authoritative event/projection. For
IPFS inputs inspect fetch/decryption separately. Use PFTL replay repair only
when a historical signed pointer/reducer boundary actually failed. Do not
invent a task projection or describe an offchain reference as a ledger receipt.

Related checks: `task-generation-reliability-smoke`, `taskgen-replay-smoke`,
`network-task-generation-recovery-smoke`, and `task-lifecycle-smoke`.
See [task async engine](task-async-engine.md),
[network generation](network-task-generation-worker.md), and
[terminal contract](tasknode-terminal-contract.md).
