# Contributor Quality Routing Report Script Evidence

Task: `task_c17fe3003de63a047286b0dbe1c7fcee`
Title: Build Contributor Quality Routing Report Script

## What changed

- Added `scripts/orc-contributor-quality-routing-report.mjs`.
- Added sample review ledger data at `docs/verification/contributor_quality_routing_report_task_c17fe3003de63a047286b0dbe1c7fcee/sample_review_ledger.json`.
- Generated sample artifacts under `docs/verification/contributor_quality_routing_report_task_c17fe3003de63a047286b0dbe1c7fcee/outputs/`.

The script reads records compatible with `pf.orc.submitted_work_review_ledger.v1`, groups outcomes by contributor wallet/account/handle, applies configurable quality thresholds, and emits a recommend-only routing-review report. It does not execute routing pauses, bans, clawbacks, blocklists, or payment actions.

## Commands run

```bash
node scripts/orc-contributor-quality-routing-report.mjs --help
node scripts/orc-contributor-quality-routing-report.mjs batch \
  --ledger docs/verification/contributor_quality_routing_report_task_c17fe3003de63a047286b0dbe1c7fcee/sample_review_ledger.json \
  --out docs/verification/contributor_quality_routing_report_task_c17fe3003de63a047286b0dbe1c7fcee/outputs \
  --generated-by grashnuk \
  --generated-at 2026-06-20T03:00:00.000Z
node scripts/orc-contributor-quality-routing-report.mjs generate \
  --ledger docs/verification/contributor_quality_routing_report_task_c17fe3003de63a047286b0dbe1c7fcee/sample_review_ledger.json \
  --generated-by grashnuk \
  --generated-at 2026-06-20T03:00:00.000Z
git diff --check -- scripts/orc-contributor-quality-routing-report.mjs docs/verification/contributor_quality_routing_report_task_c17fe3003de63a047286b0dbe1c7fcee
./node_modules/.bin/eslint /home/pfrpc/repos/tasknode-contributor-quality-routing/scripts/orc-contributor-quality-routing-report.mjs --quiet
```

Note: `npm run lint -- --quiet` could not run inside the fresh linked worktree because that worktree does not have `node_modules` installed. The script-specific ESLint command above was run from the main worktree, where the repo lint dependencies are installed, against the absolute path to this branch's script.

## Sample data coverage

The fixture contains 17 review records across 5 contributors:

- high-quality contributor: all verified, no routing-review recommendation.
- mixed contributor: verified plus weak evidence, no threshold violation.
- low-quality contributor: repeated unverifiable submissions and low verified ratio.
- refused contributor: repeated refusals inside the configured 7-day window.
- new contributor: single self-attested record, not enough data to flag by ratio.

## Generated output

`outputs/batch_output.json`:

```json
{
  "ok": true,
  "schema": "pf.orc.contributor_quality_routing_report.v1",
  "summary": {
    "totalRecords": 17,
    "contributors": 5,
    "flaggedForRoutingReview": 2,
    "noActionRecommended": 3,
    "violationCounts": {
      "repeated_unverifiable_submissions": 1,
      "consecutive_unverifiable_submissions": 1,
      "low_verified_to_total_ratio": 1,
      "recent_refusals": 1
    }
  },
  "enforcementMode": "recommend_only_no_enforcement"
}
```

Flagged contributors in `outputs/generate_summary.json`:

```json
[
  {
    "handle": "lowquality",
    "recommendation": "routing_review_recommended",
    "rules": [
      "repeated_unverifiable_submissions",
      "consecutive_unverifiable_submissions",
      "low_verified_to_total_ratio"
    ]
  },
  {
    "handle": "refusedoperator",
    "recommendation": "routing_review_recommended",
    "rules": [
      "recent_refusals"
    ]
  }
]
```

## Discord-ready summary

```text
@goodalexander Contributor quality routing report is ready.

Mode: recommend_only_no_enforcement (no live routing changes executed)
Records reviewed: 17
Contributors evaluated: 5
Flagged for routing review: 2

Flagged contributors:
- @lowquality: repeated_unverifiable_submissions, consecutive_unverifiable_submissions, low_verified_to_total_ratio; verified ratio 0.2; tasks task_low_quality_001, task_low_quality_002, task_low_quality_003, task_low_quality_004, task_low_quality_005
- @refusedoperator: recent_refusals; verified ratio 0.3333; tasks task_refused_001, task_refused_002, task_refused_003

Recommended action: review the flagged contributors before any routing policy change.
```

## Public artifact

Public PR: to be added after branch push.

No deploy was performed.
