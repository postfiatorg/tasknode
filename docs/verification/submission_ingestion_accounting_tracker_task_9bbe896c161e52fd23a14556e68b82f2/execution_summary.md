# Submission Ingestion Accounting Tracker

Task: `task_9bbe896c161e52fd23a14556e68b82f2`

## What Changed

Added a runnable offline tracker at `scripts/orc-submission-ingestion-tracker.mjs` with:

- `run`: processes submission packets through ingest, review, ledger, feedback, delivery, and secretary-update stages.
- `catch-up`: processes only submissions missing from the persistent ledger or still non-terminal.
- `dashboard`: regenerates status/dashboard artifacts from an existing ledger.

The tracker writes a persistent JSON accounting ledger using states `pending`, `in_review`, `reviewed`, `accounted_for`, and `failed`. Each record includes timestamps, state history, stage completion details, mock feedback payloads, and Hive Secretary context-update payloads.

## Sample Input

- `mock_submissions.json`: 10 mock rewarded submission packets with task IDs, contributor identities, reward amounts, evidence references, review dispositions, and recommended actions.

## Sample Outputs

- `outputs/accounting_ledger.json`: persistent ledger for the sample run.
- `outputs/status_dashboard.json`: dashboard summary with state and stage counts.
- `outputs/feedback_delivery_payloads.json`: mock feedback payloads for reviewed submissions.
- `outputs/hive_secretary_context_updates.json`: Hive Secretary context-update payloads.
- `outputs/discord_summary.md`: Discord-ready summary for `@goodalexander`.

Key output facts from the sample run:

- Source submissions: 10
- Processed this run: 10
- Final `accounted_for` records: 10
- Failed records: 0
- Feedback payloads ready: 10
- Hive Secretary updates ready: 10
- Accounted reward total: 113000 PFT
- Each stage completed for all 10 records: ingest, review, ledger, feedback, delivery, secretary_update

## Commands Run

```bash
npm run orc-submission-ingestion-tracker-smoke
```

Result: `orc-submission-ingestion-tracker-smoke ok`

```bash
node scripts/orc-submission-ingestion-tracker.mjs run \
  --submissions docs/verification/submission_ingestion_accounting_tracker_task_9bbe896c161e52fd23a14556e68b82f2/mock_submissions.json \
  --ledger docs/verification/submission_ingestion_accounting_tracker_task_9bbe896c161e52fd23a14556e68b82f2/outputs/accounting_ledger.json \
  --out docs/verification/submission_ingestion_accounting_tracker_task_9bbe896c161e52fd23a14556e68b82f2/outputs \
  --generated-by grashnuk \
  --generated-at 2026-06-20T07:30:00.000Z
```

Result: generated the sample ledger, dashboard, feedback payloads, Secretary updates, and Discord summary listed above.

## Safety

This bundle is offline and reviewable. It does not sign transactions, submit to live APIs, move funds, send Hive messages, or execute enforcement.
