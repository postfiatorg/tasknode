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
   job or authorize re-publication.
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
