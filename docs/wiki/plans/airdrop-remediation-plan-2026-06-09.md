# Daily Airdrop Remediation Plan - 2026-06-09

## Objective

Make the Daily Airdrop mechanism resilient enough that a transient provider,
worker, database, or PFTL failure does not silently skip an eligible user or
strand an unpaid airdrop.

The target operating contract:

- eligible users are scored once per account per UTC day;
- failed scoring attempts retry automatically until a completed score exists or
  a hard non-retryable data error is recorded;
- PFT issuance is idempotent and fail-closed against duplicate payment;
- failures that are safe to retry are retried by the worker;
- failures that require reconciliation stay blocked but remain visible until
  resolved;
- Profile distinguishes scored airdrops from paid airdrops;
- System Status exposes unresolved airdrop debt, not only recent worker health.

## Implementation Status

Status: implemented in the Task Node Official codebase on June 9, 2026.

Implemented code paths:

- schema migration `057_profile_daily_airdrop_remediation.sql`;
- issuance state machine, stale recovery, retryable debt listing, and
  reconciliation helpers in `server/profile-daily-airdrop-issuance.js`;
- stale scoring-row recovery in
  `server/repositories/profile-daily-airdrop.js`;
- worker catch-up/retry/debt audit loop in
  `server/profile-daily-airdrop-worker.js`;
- operator commands `profile-daily-airdrop-debt` and
  `profile-daily-airdrop-reconcile`;
- System Status unresolved debt checks in `server/system-status.js`;
- Profile paid-vs-scored copy in `src/features/profile/ProfileView.jsx`;
- docs and in-app docs metadata updates.

Implemented smokes:

```bash
npm run profile-daily-airdrop-worker-smoke
npm run profile-daily-airdrop-packet-smoke
npm run profile-daily-airdrop-issuance-smoke
npm run profile-daily-airdrop-recovery-smoke
npm run profile-daily-airdrop-debt-smoke
npm run profile-daily-airdrop-reconcile-smoke
```

Verification on this workstation: `format-check`, `lint`, `build`,
`git diff --check`, `system-status-smoke`,
`profile-daily-airdrop-worker-smoke`, and the Postgres-backed airdrop smokes
pass against the local Docker Postgres database.

Fly verification on release `301`:

- `npm run db:migrate`: clean, no pending migrations;
- `profile-daily-airdrop-packet-smoke`: pass;
- `profile-daily-airdrop-issuance-smoke`: pass after one transient DB read
  timeout retry;
- `profile-daily-airdrop-recovery-smoke`: pass;
- `profile-daily-airdrop-debt-smoke`: pass;
- `profile-daily-airdrop-reconcile-smoke`: pass;
- `profile-daily-airdrop-debt -- --since-date=2026-06-07 --json`: zero
  unresolved debt;
- System Status `daily_airdrop_worker`: `ok`, `debt_unresolved=0`.

## Incident Summary

Goodalexander's airdrop appeared not to run after June 7, 2026.

Evidence from production rows showed two different failure classes:

- `2026-06-08`: scoring completed for `10000 PFT`, but issuance failed before
  PFTL submission with `PFTL websocket endpoint could not be reached.` The row
  had no `tx_hash` and no `submitted_at`.
- `2026-06-09`: the first scoring attempt failed with
  `daily_airdrop_model_output_not_json`. The worker then retried hourly, but
  the failed production scoring row still occupied the unique account/day
  boundary and caused duplicate-key errors.

The June 9 scoring retry wedge was fixed by allowing failed production scoring
rows to be reclaimed in place by the next worker tick. Remaining work is needed
to make the whole airdrop path self-healing and observable.

## Current Architecture

Primary code paths:

- Scoring packet and model call:
  `server/profile-daily-airdrop.js::runDailyAirdropScore`
- Candidate selection and run persistence:
  `server/repositories/profile-daily-airdrop.js`
- Recurring worker:
  `server/profile-daily-airdrop-worker.js::runDailyAirdropWorkerOnce`
- PFT issuance:
  `server/profile-daily-airdrop-issuance.js::issueLatestDailyAirdrop`
- System Status:
  `server/system-status.js::dailyAirdropItem`
- Profile UI:
  `src/features/profile/ProfileView.jsx`
- Runbook:
  `docs/wiki/surfaces/daily-airdrop.md`
  `docs/wiki/architecture/daily-airdrop-worker.md`

Important tables:

- `profile_daily_airdrop_runs`
- `profile_daily_airdrop_issuances`
- `task_projections`
- `task_events`
- `pftl_sync_wallets`
- `board_manager_runs`
- `board_manager_action_results`

## Failure Classes

### 1. Scoring Provider Failure

Examples:

- non-JSON model output;
- provider timeout;
- OpenRouter HTTP failure;
- model unavailable;
- malformed response payload.

Expected behavior:

- retry inside the same worker tick when the failure is provider/transient;
- if all attempts fail, persist `status = failed` with reason and retry on the
  next tick by reclaiming the same run row;
- alert if the account/day remains unresolved past the worker cadence.

### 2. Scoring Worker Crash

Examples:

- process dies after creating a `running` row but before marking failed;
- deploy restart during model call;
- database connection dies before `failDailyAirdropRun`.

Expected behavior:

- stale `running` rows older than a configured threshold are reclaimed;
- the reclaimed row records a retry attempt and prior error/stale reason;
- completed production rows are never overwritten.

### 3. Issuance Failure Before Submission

Examples:

- PFTL websocket unreachable during transaction preparation;
- IPFS pin failure before signing/submitting;
- recipient public key lookup failure;
- local encryption failure;
- missing source seed.

Expected behavior:

- mark issuance as `failed_before_submit`;
- auto-retry with a bounded attempt count after the root cause clears;
- keep an operator-visible row until submitted or intentionally cancelled.

### 4. Issuance Unknown After Submission Attempt

Examples:

- process dies after signing but before persisting tx result;
- `submitAndWait` times out after the blob may have reached PFTL;
- PFTL returns an ambiguous response;
- database write fails after a successful submission.

Expected behavior:

- mark issuance as `submit_unknown`;
- do not auto-retry signing;
- reconcile by searching source wallet and recipient wallet transactions for the
  deterministic pointer memo, run id, issuance id, payload digest, and amount;
- only mark `submitted` after chain proof is found;
- only release for manual retry after reconciliation proves no payment.

### 5. Visibility Failure

Examples:

- Profile shows a scored amount as the headline even when no submitted issuance
  exists;
- System Status returns green because recent failures aged out;
- Hive audit card says zero users paid but unresolved payout debt exists.

Expected behavior:

- Profile clearly separates `scored` and `paid`;
- System Status stays warning or critical until unresolved scoring/issuance debt
  is resolved;
- operator packets include account id, run id, issuance id, amount, recipient
  wallet, status, and exact last error.

## P0 Work

### P0.1 Add Issuance State Machine

Replace the ambiguous issuance `failed` state with explicit money-path states:

- `pending`
- `processing_pre_submit`
- `failed_before_submit`
- `submitting`
- `submit_unknown`
- `submitted`
- `cancelled`

Implementation notes:

- Add a migration that expands the status check constraint.
- Keep compatibility reads for existing `failed` rows by treating rows with
  empty `tx_hash` and null `submitted_at` as `failed_before_submit`.
- Record `attempt_count`, `last_attempt_at`, `last_error_code`, and
  `last_error_message`.
- Record `submission_attempted_at` before calling `submitSignedPftTransaction`.
- Record the signed transaction hash if available from the signed blob before
  submission, so reconciliation has a deterministic handle even if persistence
  fails later.

Acceptance criteria:

- pre-submit failures are retried automatically by the worker;
- post-submit unknowns block duplicate payment;
- existing June 8-style rows are classified as retryable only when
  `tx_hash = ''` and `submitted_at IS NULL`.

### P0.2 Add Stale Row Recovery

Add a recovery step before candidate selection:

- reclaim `profile_daily_airdrop_runs.status = 'running'` rows older than the
  stale threshold by marking them `failed` with
  `daily_airdrop_stale_running_reclaimed`;
- reclaim `processing_pre_submit` issuance rows older than the stale threshold
  by marking them `failed_before_submit`;
- move stale `submitting` rows to `submit_unknown`, never back to retryable.

Recommended defaults:

- scoring running stale threshold: `45 minutes`;
- pre-submit issuance stale threshold: `30 minutes`;
- submitting unknown threshold: `30 minutes`.

Acceptance criteria:

- a killed worker cannot block an account/day forever;
- stale post-submit state cannot sign a duplicate payment;
- System Status lists recovered stale rows.

### P0.3 Add Worker Catch-Up

The worker should process unresolved run dates, not only current UTC day.

Algorithm:

1. Build candidate run dates from today plus the previous two UTC days.
2. For each date, select accounts with positive rewarded work and unresolved
   airdrop state.
3. Prioritize:
   - unresolved `submit_unknown`;
   - retryable `failed_before_submit`;
   - missing score for eligible account/day;
   - failed scoring row.
4. Enforce one lease for the whole catch-up pass.

Acceptance criteria:

- a provider failure at 23:59 UTC can still be completed after midnight;
- a prior-day pre-submit outage is retried without a manual command;
- worker summary reports `runDatesChecked`.

### P0.4 Add Reconciliation For Submit-Unknown

Create an operator and worker-safe reconciliation function:

```bash
npm run profile-daily-airdrop-reconcile -- --run-id=<run_id>
```

Required matching facts:

- source wallet;
- recipient wallet;
- amount drops;
- pointer memo CID or run id;
- issuance id;
- payload digest when available;
- ledger index and tx hash.

Behavior:

- if matching transaction is found, mark issuance `submitted`;
- if no matching transaction is found inside the relevant ledger window, leave
  state as `submit_unknown` and report `not_found`;
- require an explicit operator flag to demote a `submit_unknown` row to
  `failed_before_submit`.

Acceptance criteria:

- reconciliation cannot accidentally re-sign;
- every `submit_unknown` row has an inspectable reconciliation report.

### P0.5 Make System Status Track Airdrop Debt

Update `daily_airdrop_worker` status to include unresolved debt regardless of
age.

Critical conditions:

- any `submit_unknown` issuance;
- any stale `submitting` or `processing_pre_submit` issuance;
- any stale `running` scoring row;
- any failed scoring row older than two worker cadences with positive candidate
  evidence.

Warning conditions:

- any `failed_before_submit` issuance with retry attempts remaining;
- any failed scoring row from the current or previous UTC day;
- worker has not recorded a successful audit run within the freshness window.

Details should include:

- unresolved scoring count;
- unresolved issuance count;
- oldest unresolved age;
- account id and run id for the oldest unresolved row;
- total unpaid PFT from retryable issuance rows.

Acceptance criteria:

- June 8-style unpaid issuance remains visible until paid, cancelled, or
  reconciled;
- System Status cannot go green while unresolved airdrop debt exists.

## P1 Work

### P1.1 Profile Paid-vs-Scored UI

Change Profile Daily Airdrop display:

- show `Daily airdrop paid` only when issuance status is `submitted`;
- show `Daily airdrop scored` for completed score without submitted issuance;
- show payout state badges: `Queued`, `Retrying`, `Needs reconciliation`,
  `Failed before submit`, `Paid`;
- keep range totals based only on submitted issuance rows;
- expose tx hash and recipient wallet when paid.

Acceptance criteria:

- users cannot mistake an unpaid score for a paid airdrop;
- support can ask for a screenshot and identify the exact state.

### P1.2 Operator Debt Report

Add a read-only operator report:

```bash
npm run profile-daily-airdrop-debt -- --since 7d --json
```

Report columns:

- account id;
- public handle when resolvable;
- run date;
- run id;
- issuance id;
- amount PFT;
- recipient wallet;
- status;
- retryable;
- last error;
- next action.

Acceptance criteria:

- "who missed an airdrop?" is answerable in one command;
- output can be pasted into an incident note.

### P1.3 Hive Audit Detail

Extend the Daily Airdrop Hive Mind Agent card:

- total paid PFT;
- users paid;
- users scored but unpaid;
- retryable failures;
- reconciliation-required failures;
- link or id for the debt report.

Acceptance criteria:

- a zero-payout audit card cannot hide unpaid positive scores.

## Tests And Smokes

Required focused tests:

- scoring failed row is reclaimed in place;
- completed production scoring row cannot be replaced;
- stale `running` scoring row is reclaimed;
- pre-submit issuance failure is retried;
- post-submit unknown blocks retry;
- reconciliation marks a found payment as submitted;
- reconciliation leaves unknown state unchanged when no proof is found;
- candidate selection includes retryable pre-submit failures;
- candidate selection excludes submitted and submit-unknown rows;
- System Status is critical for submit-unknown;
- System Status is warning for retryable failed-before-submit;
- Profile renders unpaid score differently from paid issuance.

Existing useful smokes:

```bash
npm run profile-daily-airdrop-packet-smoke
npm run profile-daily-airdrop-issuance-smoke
npm run profile-daily-airdrop-worker-smoke
```

New recommended smokes:

```bash
npm run profile-daily-airdrop-recovery-smoke
npm run profile-daily-airdrop-debt-smoke
npm run profile-daily-airdrop-reconcile-smoke
```

## Rollout Plan

1. Add schema migration and compatibility reads.
2. Add state-machine helpers and tests without enabling auto-retry.
3. Add System Status unresolved debt checks.
4. Add debt report command.
5. Enable auto-retry for `failed_before_submit` only.
6. Add stale recovery for scoring and pre-submit issuance.
7. Add reconciliation command for `submit_unknown`.
8. Add worker catch-up for prior UTC days.
9. Update Profile paid-vs-scored UI.
10. Deploy to Fly and verify with remote DB-backed smokes.

## Production Verification Checklist

Before deploy:

```bash
npm run lint
npm run format-check
npm run profile-daily-airdrop-worker-smoke
npm run profile-daily-airdrop-packet-smoke
npm run profile-daily-airdrop-issuance-smoke
npm run build
git diff --check
```

After deploy:

```bash
fly releases -a tasknodeofficial-dev
curl -fsS https://tasknodeofficial-dev.fly.dev/api/system/status
fly ssh console -a tasknodeofficial-dev --process-group app -C 'npm run profile-daily-airdrop-packet-smoke'
fly ssh console -a tasknodeofficial-dev --process-group app -C 'npm run profile-daily-airdrop-issuance-smoke'
fly ssh console -a tasknodeofficial-dev --process-group app -C 'npm run profile-daily-airdrop-debt -- --since 7d --json'
```

Success criteria:

- no unresolved stale `running` scoring rows;
- no stale pre-submit `processing` rows;
- no `submit_unknown` rows without a reconciliation report;
- retryable failed-before-submit rows are either paid or queued for retry;
- System Status is green only when no unresolved airdrop debt remains.

## Guardrails

- Never delete a production scoring or issuance row as the repair mechanism.
- Never auto-retry a state where a signed PFT transaction may have reached the
  network.
- Never count scored-but-unpaid amounts as paid airdrop totals.
- Never let a failure age out of System Status while money is unresolved.
- Keep one production scoring boundary per account per UTC day.
- Keep one submitted issuance boundary per account per UTC day.

## Open Questions

- Should retryable pre-submit failures retry immediately on the next tick or use
  exponential backoff?
- What is the maximum daily catch-up window: two days, seven days, or all
  unresolved rows?
- Should operators be able to intentionally cancel a retryable airdrop debt row,
  and what approval/audit field should that require?
- Should Profile show unpaid scored airdrops to users at all, or only operator
  surfaces?
