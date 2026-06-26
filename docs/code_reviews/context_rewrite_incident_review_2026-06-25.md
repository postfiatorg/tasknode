# Context Rewrite Incident Review - 2026-06-25

## Scope

This review covers the live Context Rewrite job reported as stuck by `GeorgL0ngGamma` on 2026-06-25, plus the structural reliability issues in the Context Rewrite implementation.

Reviewed surfaces:

- `server/context-rewrite-worker.js`
- `server/repositories/context-rewrite.js`
- `server/context-rewrite-provider.js`
- `server/context-rewrite-actions.js`
- `server/repositories/chat-billing.js`
- `server/db/migrations/078_context_rewrite_jobs.sql`
- `server/db/migrations/001_chat_billing.sql`
- `src/main.jsx`
- `src/features/chat/ChatMessages.jsx`
- `scripts/context-rewrite-sample-smoke.mjs`
- `scripts/context-rewrite-live-smoke.mjs`
- Live Fly dev DB rows for job `ctxrw_6cbe2c3d-8036-481f-9e25-e1b000e4159f`

## Executive Summary

The job got stuck because Context Rewrite is implemented as one long-running worker invocation that holds a database lock label while it performs multiple external provider calls. The database records durable progress at stage boundaries and after provider calls return, but it does not record an in-flight provider call before dispatch. When the worker disappeared or hung while the job was in a long provider stage, the job stayed `running` with the last durable stage visible to the UI.

The immediate user-visible failure was not a bad Markdown artifact. It was a job lifecycle failure: the UI was polling a durable row that still said `running/final_rewrite`, but the worker that owned the lock was no longer making progress. The stale-running reclaim window was still too conservative at 180 minutes in the runtime path used by the incident, so the job could sit for hours before another worker was allowed to retry it.

The deeper problem is structural: retries rerun the whole pipeline, previous completed stage outputs are not treated as idempotent checkpoints, in-flight provider calls are invisible, and the UI does not surface staleness or retry state. Those design choices made the incident possible and made diagnosis harder than it should have been.

## Live Evidence

Identity:

- Reported handle: `GeorgL0ngGamma`
- Matched observability handle: `georgl0nggamma`
- Account: `acct_oauth_b6ef27e11bff20a69c5f146f`
- Conversation: `account_acct_oauth_b6ef27e11bff20a69c5f146f_chat_mqttk194_0bc2c242`

Job:

- Job id: `ctxrw_6cbe2c3d-8036-481f-9e25-e1b000e4159f`
- Queued at: `2026-06-25 18:31:53 UTC`
- Started at: `2026-06-25 18:32:01 UTC`
- Status before manual recovery: `running`
- Stage before manual recovery: `final_rewrite`
- Lock owner before recovery: `ctxrw_worker_657`
- Lock timestamp before recovery: `2026-06-25 21:34:32 UTC`
- Final status after recovery: `completed`
- Completed at: `2026-06-25 23:10:34 UTC`
- Artifact id: `ctxrw_art_5480ad01-7387-40bc-9c07-29c890c752d9`
- Final Markdown size: `28,045` chars
- Final recorded actual cost: `$0.404610`

Provider/model-run evidence:

- Expected normal scorer rows for a full run: 6
- Actual scorer rows: 12
- Expected normal research rows: 2
- Actual research rows: 3
- Final rewrite model-run rows before manual recovery: 0
- Polish model-run rows before manual recovery: 0

Timeline from durable rows:

1. `18:31:53 UTC` - job queued.
2. `18:32:01 UTC` - worker claimed job.
3. `18:32:12` through `18:33:08 UTC` - six scorer calls completed.
4. `18:33:13 UTC` - one research call completed.
5. No second research row and no final rewrite row were recorded for the first attempt.
6. `21:33:27` through `21:34:17 UTC` - a later worker reclaimed the stale job and reran all six scorer calls.
7. `21:34:22` and `21:34:32 UTC` - two research calls completed on the retry.
8. The job advanced to `final_rewrite` at `21:34:32 UTC`.
9. No final rewrite model-run row was recorded after that retry until manual recovery.
10. `22:55:55 UTC` - manual recovery final GLM call completed.
11. `23:10:34 UTC` - manual recovery polish GLM call completed and artifact was published.

The database cannot prove whether the second attempt's final rewrite request hung upstream after dispatch or whether the worker process died immediately before/during dispatch. That uncertainty is itself a bug: there is no durable "provider call started" row for final/polish calls.

## Direct Cause

The job remained visible as stuck because the worker updated the durable job row to `final_rewrite`, then stopped making durable progress while the row still had `status = 'running'`.

Current relevant implementation shape:

- `claimContextRewriteJobs()` claims queued or stale running rows and sets `current_stage = 'source_packet'`, `locked_at = now()`, and `locked_by = worker id`.
- `processContextRewriteJob()` performs source assembly, scoring, research, final rewrite, polish rewrite, and completion inside a single async function.
- `updateContextRewriteStage()` refreshes `locked_at`, but only at stage transitions.
- `runContextRewriteFinalCall()` performs a large external OpenRouter call.
- `recordBillableModelRun()` is called only after the provider returns.
- The UI polls `GET /api/context/rewrite/jobs/:jobId` and renders whatever the job row says.

So when a provider call or worker process stopped progressing between stage updates, the app had no durable sub-stage state to show and no fast recovery path.

## Structural Findings

### 1. The job lifecycle is too coarse for a multi-call paid workflow

Severity: High

Context Rewrite is not one operation. It is source assembly, six scorer calls, two research calls, final draft, polish, validation, billing, and artifact publication. The current primary durable state is one row in `context_rewrite_jobs`, with `status`, `current_stage`, `locked_at`, and `locked_by`.

That is not enough state for this workflow. A single stage label like `final_rewrite` cannot distinguish:

- request not started;
- request dispatched and waiting;
- request returned but parsing failed;
- request returned and billing is being written;
- request timed out;
- worker died;
- lock was stolen for retry.

Impact:

- The UI can show an apparently active stage while no process is alive.
- Operators cannot determine whether provider spend may still be pending.
- Retrying requires guessing where to resume.

Recommendation:

Add a first-class `context_rewrite_attempts` and/or `context_rewrite_provider_calls` table. Every provider call should have a durable row created before dispatch with `status = 'running'`, `attempt_id`, `stage`, `call_index`, `provider`, `model`, `request_digest`, `started_at`, `timeout_at`, `heartbeat_at`, and later `completed_at`, `response_id`, usage, cost, or error.

### 2. The lock is a timestamp, not a real lease with heartbeats

Severity: High

`locked_at` is updated when a job is claimed and when `updateContextRewriteStage()` runs. It is not refreshed during a long provider call. A final/polish call can legitimately run for many minutes, and the only durable indication during that time is an old `locked_at`.

Impact:

- A dead worker and a slow but healthy provider call look the same.
- If stale reclaim is long, dead jobs sit for hours.
- If stale reclaim is short, a healthy long-running call can be reclaimed and duplicated.

Recommendation:

Separate worker lease heartbeats from stage transitions. While a provider call is in flight, refresh a per-attempt heartbeat on a short interval. Reclaim only if the heartbeat is stale past the stage timeout plus a safety margin. A better model is: lease heartbeat every 30-60 seconds, call timeout per stage, and reclaim threshold derived from both.

### 3. Reclaim retries rerun the entire pipeline from scratch

Severity: High

When `claimContextRewriteJobs()` reclaims a stale `running` job, it resets the job to `source_packet`. The worker then reassembles the source packet, reruns scoring, reruns research, and only then tries final/polish again.

Live evidence:

- This incident produced 12 scorer rows, not 6.
- It produced 3 research rows, not 2.
- The job `retry_count` ended at 1.

Impact:

- Users can be charged for duplicated completed stages.
- The second attempt can produce a different aggregate score or research packet.
- Recovery time increases exactly when the system is already failing.
- Repeated reclaims can push actual cost past the estimate.

Recommendation:

Make each stage an idempotent checkpoint:

- freeze or persist the source packet used for the job;
- reuse completed scorer packets on retry;
- reuse completed research results on retry;
- resume from the first incomplete required stage;
- use deterministic idempotency keys for ledger entries based on `job_id`, `attempt_id`, `stage`, and provider `response_id`.

### 4. The original source packet is not frozen

Severity: High

The job stores a source packet digest and selected metadata, but the worker assembles the source packet during processing. If a stale running job is reclaimed later, source assembly runs again against the user's current context, memory, chat, task state, profile, and Jobs retrieval.

Impact:

- A retry may not be rewriting the same input the user started with.
- Score/research/final prompts can drift between attempts.
- Auditing exact model input after an incident is difficult.

Recommendation:

Persist a private source snapshot or a structured source artifact at first assembly. If storing the full packet is too large or too sensitive, store it in a private internal artifact table with clear retention rules. At minimum, store a stage checkpoint sufficient to guarantee retry equivalence.

### 5. Provider calls are only billed after completion, not audited before dispatch

Severity: High

`recordBillableModelRun()` inserts `chat_model_runs` after the provider result exists. Score and research rows are also inserted after success or after a caught failure. Final and polish have no dedicated stage rows at all; they rely on `chat_model_runs` after the model returns.

Impact:

- No row exists for an in-flight final or polish call.
- If the process dies after dispatch but before writing the result, the system has no local record of that request.
- Operators cannot tell whether missing rows mean "not started" or "started and lost".

Recommendation:

Create a provider-call row before `fetchOpenRouter()`. Transition it through `running`, `completed`, `failed`, `timed_out`, or `orphaned`. Then use the completed row to drive billing, score/search persistence, and artifact metadata.

### 6. Billing has no job-stage retry budget or reservation

Severity: Medium-High

The route preflight checks available credit against the estimate, but it does not reserve a maximum charge for the job. Retries can duplicate billable stages. The billing ledger has idempotency support generally, but Context Rewrite model runs currently rely on fresh random model-run ids and do not pass a stage-level unique key into the ledger path.

Impact:

- Actual cost can exceed the estimate after retries.
- Duplicate stages are not automatically collapsed.
- A job can consume credit unexpectedly if a provider or worker repeatedly fails after billable work.

Recommendation:

Add a per-job spend cap and retry budget:

- reserve `CONTEXT_REWRITE_ESTIMATE_USD` or a configured max at job creation;
- block retry stages when the remaining job budget is insufficient;
- expose retry cost in progress metadata;
- use idempotency keys for stage/provider ledger entries.

### 7. The UI renders progress but not staleness

Severity: Medium

The frontend polls every four seconds and displays the latest `progress_json` trace. It does not compute or display:

- last update age;
- retry count;
- whether the worker lease is stale;
- whether the job is being reclaimed;
- whether a provider call is running or timed out.

Impact:

- A stuck job looks like a slow healthy job.
- Users have to ask whether "Draft Markdown artifact" for hours is expected.
- Operators have to inspect the database to distinguish normal and abnormal latency.

Recommendation:

Return safe public status fields from the job read endpoint:

- `lastProgressAt`
- `elapsedSinceProgressMs`
- `staleAfter`
- `retryCount`
- `attempt`
- `stalled: true|false`
- `statusMessage`

Then render explicit states like "Provider call still running", "Worker interrupted, retrying", or "Stalled; recovery will retry shortly."

### 8. There is no operational watchdog or alert for stuck paid jobs

Severity: Medium

Recovery currently depends on the normal worker reclaim path or manual operator inspection. There is no separate watchdog that scans paid async jobs for stale lock age, emits an observability event, and reports pending user-visible failures.

Impact:

- Stuck paid workflows are discovered by users.
- A failed worker deploy can leave jobs in limbo until stale reclaim fires.
- There is no compact operator queue of "jobs needing intervention".

Recommendation:

Add a lightweight scheduled watchdog:

- scan `context_rewrite_jobs where status='running'`;
- classify normal, long-running, stale, over-timeout, and orphaned;
- emit `user_observability_events` and server logs;
- optionally requeue or fail with a user-visible recovery message;
- expose counts in system status.

### 9. Tests cover happy path and cancellation, not the incident class

Severity: Medium

The sample smoke verifies full mock completion and cancellation terminal safety. It does not simulate:

- worker death after stage update;
- provider hang after dispatch;
- stale reclaim;
- retry without duplicating already completed scorer/search runs;
- billing idempotency after retry;
- UI rendering of stale jobs.

Impact:

- The exact failure class escaped.
- Fixes can regress because no test asserts "do not rerun completed paid stages".

Recommendation:

Add deterministic tests:

- "stale running job is reclaimed and resumes from incomplete stage";
- "completed scorer/search rows are reused after retry";
- "final call started row exists before provider promise resolves";
- "provider timeout marks call timed_out and job failed/retryable";
- "cancelled job cannot be revived by late worker";
- "public API marks stale running jobs as stalled".

### 10. Configuration still has dangerous escape hatches

Severity: Medium

The provider timeout helper allows `0`, `none`, `false`, `off`, or `no` to disable timeouts. That is useful for manual experiments, but dangerous for a production paid workflow unless it is explicitly gated to development.

Impact:

- A misconfigured environment can restore the original infinite-wait failure mode.
- Operators may set no timeout while testing high-context calls and accidentally leave it live.

Recommendation:

In production-shaped environments, enforce bounded nonzero timeouts. Allow timeout disablement only when `NODE_ENV !== 'production'` or an explicit unsafe dev flag is set.

### 11. Completion is now guarded, but the artifact model still lacks uniqueness

Severity: Low-Medium

Current code checks terminal status and lock owner before stage updates, failure updates, and completion. That prevents a late cancelled worker from publishing an artifact. However, `context_rewrite_artifacts` allows multiple `final_markdown` rows for a job, and no schema-level unique constraint protects the "one current final artifact" invariant.

Impact:

- The app reads the newest artifact, but duplicate final artifacts are possible if a future code path bypasses current guards.
- Operational cleanup becomes harder.

Recommendation:

Add a partial unique index for one current final artifact per job, or explicitly model artifact revisions with `is_current`.

## Why The Incident Was Expensive

The duplicate scoring/research happened because the retry path did not reuse completed stage outputs. A stale reclaim starts at `source_packet`, which creates a clean retry but not an economical or deterministic retry.

In this incident, normal pipeline spend would have included one set of scorers, two searches, final, and polish. The live DB shows one extra full scoring set and one extra research result before manual recovery. The final cost still landed under the rough `$0.50` estimate, but that was luck and input-size dependent. Another job with larger output or another retry could exceed the estimate.

## Immediate Mitigations Already Applied

- The live stuck job was manually recovered and completed.
- Live Fly dev env was set to `CONTEXT_REWRITE_RUNNING_STALE_MINUTES=60`.
- Local code default for stale-running reclaim was changed from 180 minutes to 60 minutes.
- Context Rewrite docs were updated to match the 60-minute default.
- Focused checks passed:
  - `node --check server/repositories/context-rewrite.js`
  - `git diff --check`
  - `npm run format-check`
  - `npm run lint`

These mitigations reduce the amount of time a dead lock can sit, but they do not fix the deeper stage checkpoint, audit, retry, or billing issues.

## Recommended Fix Plan

Priority 0: stop silent limbo

1. Add public stale detection fields to the job read endpoint.
2. Add a watchdog query/report for running Context Rewrite jobs older than expected stage windows.
3. Emit observability events when a job becomes stale or is reclaimed.

Priority 1: make provider calls auditable

1. Add `context_rewrite_provider_calls`.
2. Insert `running` call rows before each OpenRouter dispatch.
3. Update those rows on success, failure, timeout, or orphan detection.
4. Drive billing and score/search/final metadata from those rows.

Priority 2: make retries deterministic and cheaper

1. Persist/freeze the source packet on first assembly.
2. Persist aggregate score and selected research as checkpointed stage outputs.
3. On reclaim, resume from the first incomplete required stage instead of restarting from `source_packet`.
4. Add unique constraints/idempotency for stage outputs and ledger entries.

Priority 3: tighten product semantics

1. Add a per-job max spend cap and retry budget.
2. Show retry/stale state in the artifact card.
3. Add smoke tests for provider timeout, stale reclaim, retry resume, duplicate billing prevention, and stale UI status.

## Bottom Line

This happened because Context Rewrite was treated like a single long async task, while in reality it is a paid distributed workflow with many expensive subcalls. The current implementation had enough durability to show "where it last got to", but not enough durability to know "what exactly is running now" or to resume without repeating completed work.

The one-line fix is not "make the timeout shorter." The real fix is to make each provider call and each pipeline stage a durable, idempotent, auditable unit of work.
