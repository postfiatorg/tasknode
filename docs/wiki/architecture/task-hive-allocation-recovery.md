# Task Hive allocation recovery

The September 19 repair covers the host supervisor, candidate discovery, network
intent assessment, exhausted ordinary requests and lifecycle allocation mirrors.
Kimi remains the board manager and GLM remains the downstream writer.

## Inspect before acting

Use the scoped board API for manager operations. Keep its existing credential,
round ID and command receipts. A fresh terminal heartbeat proves readiness, not
completed duties. Inspect the pending round's results, the supervisor's last
delivery and next recovery time, generation job status, and canonical task state.
Do not replace the round or delete failed jobs to make a dashboard appear clear.

The supervisor retries unanswered work after three deliveries with cooldowns of
15, 30, 60, 120, 240 and then 360 minutes. It waits while the terminal is busy,
its status is stale, or an inbox item already exists. Partial durable progress
resets the retry budget; the delivery sequence remains monotonic.

Candidate discovery includes every eligible idle contributor on every round.
There is no first-100 account or first-12 eligible cutoff. Board constraints
still apply, followed by work-fit, current-wallet, capacity and budget validation
at assignment. A candidate being visible does not promise an assignment.

## Recover the affected boundary

1. Deploy the API before restarting the host supervisor so the public runtime
   status accepts cooldown, attempt count and next retry time. Restart only
   `tasknode-kimi-supervisor.service`; the existing terminal/thread and pending
   work order remain intact. Confirm a recovery delivery followed by actual
   scoped command/duty results.
2. Deploy generation changes to the active worker and its stopped standby.
   The queue reclaimer marks exhausted published/queued requests failed only
   when no generated task or canonical offer exists. Confirm their Retry action
   is available and lifetime attempt count is unchanged. Owners explicitly
   retry; operators do not submit or retry private work for other accounts.
3. Distinguish `generationFailure.code` and `causeCode` from a recorded
   `intentAssessment.relationship`. Provider/schema failures use bounded
   retries; genuine duplicate/uncertain judgments stop for manager review.
   Qualifying the provider on an earlier input does not change that historical
   job or authorize re-publication. The board packet's `generation_queue`
   separates queued/running work from historical failures and exposes both typed
   and legacy provider causes. A normal replay of a failed job reports
   `executed: false` and requires explicit recovery.

   For a still-needed task that failed during intent assessment before any
   request existed, repeat its original `task create` parameters with
   `--retry-failed`, inspect the dry run, then add `--execute`. The selected
   need, badge/work type, reward band and candidate are in the failure packet.
   The command reruns normal scope, routing and badge checks, then serializes
   capacity and recovery under the account lock. It requires a retryable provider
   cause and no existing request, offer or linked task. It reuses the job,
   allocation and intent IDs, preserves lifetime attempts and diagnostic history,
   and grants a new three-attempt cycle. Concurrent retries reuse the single
   requeue. Changed parameters do not silently create a new task in retry mode.
   Genuine semantic holds cannot use this infrastructure recovery. Copy the
   stored need text exactly: a paraphrase has a different intent key and returns
   `409 network_task_retry_target_not_found`. Changed arguments need a new command
   receipt key; use the saved key only for an unchanged command replay.
4. Deploy lifecycle mirror updates to API and review workers. For historical
   mismatches, lock each canonical projection inside `transactionCommand`
   before invoking `syncNetworkTaskProjection`. Recheck mismatch count and
   canonical status afterward. This repair must emit no acceptance, cancellation,
   evidence or reward action.
5. Let the existing manager inspect task details/contact history and perform
   stale follow-up through scoped commands. Never bulk cancel by age alone.
   Submitted, rewarded and recently active work retain their guards.

The repair evidence directory contains a repeatable source-hash probe, read-only
routing/progress probes, and the narrowly scoped canonical mirror reconciliation
script. Review its candidate output against canonical rows before applying it.

## Verify and roll back

Run `node scripts/task-hive-allocation-repair-smoke.mjs` against its dedicated
local fixture database, plus the focused queue, capacity, direct-intake, board
command, lifecycle and staleness fixtures. Lint and format checks remain required.
Scoped command reads serialize before entering the PostgreSQL client queue, so
waiting behind another read does not consume a statement's execution timeout.
Board-agent commands have a bounded 15-second per-statement budget for cold
context reads; other command callers retain their configured default budget.
The command and its receipt still share one transaction; slow statements still
fail and roll back. Hive task-reference joins include explicit nonempty job and
allocation ID predicates so PostgreSQL can use the existing partial indexes;
preserve these predicates when changing the board source query. Migration 143
adds two GIN lookup indexes for account/wallet board history. Its candidate lookup
retains the original account/wallet predicates as the final filter. Apply that
migration before deploying the account-history query; it is safe to retain the
indexes during an application rollback. Run `node scripts/command-transaction-queue-smoke.mjs` to
verify this boundary, alongside board command retry/rollback tests.
Production verification must separately record: image/source hashes, full candidate
coverage, request failures with Retry available, mirror agreement, recovery
delivery, durable duty outcomes, new jobs and visible offers. An inbox receipt
alone is not successful routing.

Use the previous image recorded in the deployment evidence for each process;
do not roll unrelated machines back to a global release. Restore the previous
supervisor file from its recorded commit and restart that service if required.
Keep pending JSON, command receipts, completed duty results, task projections and
request attempt counts. Do not revert a reconciled mirror or reset exhausted
requests to queued: both can recreate the incident. Stopped standbys stay stopped.

Source and image digests, commands, observations and remaining limitations for
the September 19 deployment are in
`docs/verification/task-hive-allocation-repair-2026-09-19/`.
