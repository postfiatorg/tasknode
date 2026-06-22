# Submitted Work Review Ledger Tool

Task: `task_01ba5f1d70d620780c333693c99a0cab`

## Delivered files

- `scripts/orc-submitted-work-review-ledger.mjs` - dependency-free Node CLI for review-ledger add/query/list/report operations.
- `docs/verification/submitted_work_review_ledger_task_01ba5f1d70d620780c333693c99a0cab/sample_ledger.json` - sample ledger with all required review states.
- `docs/verification/submitted_work_review_ledger_task_01ba5f1d70d620780c333693c99a0cab/working_ledger.json` - exercised ledger after adding one extra smoke record.
- `docs/verification/submitted_work_review_ledger_task_01ba5f1d70d620780c333693c99a0cab/outputs/*.json` - captured command outputs.

## Ledger fields

Each record stores:

- `taskId`
- `reviewer`
- `reviewStatus`: `verified`, `unverified`, or `self_attested`
- `score`
- `reviewFlags`
- `archiveAction`
- `timestamp`
- `source.cid`
- `source.txHash`
- `parserOutput.taskGrade`
- `parserOutput.rewardRecommendation`
- `parserOutput.flagIndicators`
- `parserOutput.archivalInstructions`
- `parserOutput.reviewerNotes`

This shape is JSON-compatible with review-prompt/parser style outputs from `task_c47...` and `task_8df...`: parsed grade, recommendation, flags, archival instructions, and notes are preserved under `parserOutput`, while the ledger keeps normalized query fields at the top level.

## Commands run

```bash
chmod +x scripts/orc-submitted-work-review-ledger.mjs
node --check scripts/orc-submitted-work-review-ledger.mjs
node scripts/orc-submitted-work-review-ledger.mjs --help
cp docs/verification/submitted_work_review_ledger_task_01ba5f1d70d620780c333693c99a0cab/sample_ledger.json docs/verification/submitted_work_review_ledger_task_01ba5f1d70d620780c333693c99a0cab/working_ledger.json

node scripts/orc-submitted-work-review-ledger.mjs add \
  --ledger docs/verification/submitted_work_review_ledger_task_01ba5f1d70d620780c333693c99a0cab/working_ledger.json \
  --task-id task_01ba5f1d70d620780c333693c99a0cab \
  --reviewer grashnuk \
  --status verified \
  --score 88 \
  --archive-action archive_hot \
  --flag ledger_smoke_test \
  --task-grade pass \
  --reward-recommendation eligible \
  --note "Smoke record proving add operation for the submitted-work review ledger task." \
  > docs/verification/submitted_work_review_ledger_task_01ba5f1d70d620780c333693c99a0cab/outputs/add_output.json

node scripts/orc-submitted-work-review-ledger.mjs query \
  --ledger docs/verification/submitted_work_review_ledger_task_01ba5f1d70d620780c333693c99a0cab/working_ledger.json \
  --task-id task_01ba5f1d70d620780c333693c99a0cab \
  > docs/verification/submitted_work_review_ledger_task_01ba5f1d70d620780c333693c99a0cab/outputs/query_by_task_output.json

node scripts/orc-submitted-work-review-ledger.mjs query \
  --ledger docs/verification/submitted_work_review_ledger_task_01ba5f1d70d620780c333693c99a0cab/working_ledger.json \
  --reviewer grashnuk \
  > docs/verification/submitted_work_review_ledger_task_01ba5f1d70d620780c333693c99a0cab/outputs/query_by_reviewer_output.json

node scripts/orc-submitted-work-review-ledger.mjs list \
  --ledger docs/verification/submitted_work_review_ledger_task_01ba5f1d70d620780c333693c99a0cab/working_ledger.json \
  --status self_attested \
  > docs/verification/submitted_work_review_ledger_task_01ba5f1d70d620780c333693c99a0cab/outputs/list_self_attested_output.json

node scripts/orc-submitted-work-review-ledger.mjs list \
  --ledger docs/verification/submitted_work_review_ledger_task_01ba5f1d70d620780c333693c99a0cab/working_ledger.json \
  --flag money_sensitive \
  > docs/verification/submitted_work_review_ledger_task_01ba5f1d70d620780c333693c99a0cab/outputs/list_flag_output.json

node scripts/orc-submitted-work-review-ledger.mjs report \
  --ledger docs/verification/submitted_work_review_ledger_task_01ba5f1d70d620780c333693c99a0cab/working_ledger.json \
  > docs/verification/submitted_work_review_ledger_task_01ba5f1d70d620780c333693c99a0cab/outputs/report_output.json
```

## Sample input

`sample_ledger.json` contains three baseline records:

- `verified`: `task_c47...`
- `unverified`: `task_8df...`, flagged `missing_public_artifact` and `pipeline_adjacent`
- `self_attested`: `task_d77...`, flagged `money_sensitive` and `do_not_operationalize`

## Output proof

The working ledger report output shows:

```json
{
  "totalRecords": 4,
  "averageScore": 77.25,
  "byStatus": {
    "verified": 2,
    "unverified": 1,
    "self_attested": 1
  },
  "flagCounts": {
    "missing_public_artifact": 1,
    "pipeline_adjacent": 1,
    "money_sensitive": 1,
    "do_not_operationalize": 1,
    "ledger_smoke_test": 1
  },
  "archiveActions": {
    "archive_hot": 2,
    "needs_followup": 1,
    "hold": 1
  }
}
```

The captured outputs prove:

- add: inserted a verified smoke record for `task_01ba5f1d70d620780c333693c99a0cab`
- query by task: returned that exact task
- query by reviewer: returned all `grashnuk` records
- list by status: returned the self-attested record
- list by flag: returned the money-sensitive record
- report: summarized status counts, average score, flags, and archive actions

## Expected review flow

1. A reviewer or parser emits normalized review output for a submitted network task.
2. `add` stores the review with the task id, reviewer, status, score, flags, archive action, source pointers, and parser output.
3. `query` retrieves a task-specific or reviewer-specific audit trail.
4. `list` surfaces work by review state or flag for follow-up queues.
5. `report` gives @goodalexander and the operator layer a compact status/flag/archive summary.

No enforcement, ban, clawback, deployment, or money-moving action was performed by this tool. It is a local review-ledger artifact for tracking submitted-work review state.
