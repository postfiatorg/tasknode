# Routing Suppression Enforcement Verifier Evidence

Task: `task_06376269c285c93f098d02f585d2dc92`
Title: Build Routing Suppression Enforcement Verifier Script

## What changed

- Added `scripts/orc-routing-suppression-enforcement-verifier.mjs`, a dependency-free Node CLI that reads a `pf.orc.contributor_routing_suppression_config.v1` suppression config and board allocation records.
- Added sample board allocation data with suppressed and unsuppressed contributors.
- Generated a structured JSON verification report and Discord-ready summary under `docs/verification/routing_suppression_verifier_task_06376269c285c93f098d02f585d2dc92/outputs/`.

This is verification-only tooling. It does not mutate live routing, execute bans, sign enforcement transactions, move funds, claw back rewards, or deploy.

## Commands run

```bash
chmod +x scripts/orc-routing-suppression-enforcement-verifier.mjs
node --check scripts/orc-routing-suppression-enforcement-verifier.mjs
node scripts/orc-routing-suppression-enforcement-verifier.mjs --help \
  > docs/verification/routing_suppression_verifier_task_06376269c285c93f098d02f585d2dc92/help_output.txt
node scripts/orc-routing-suppression-enforcement-verifier.mjs batch \
  --config docs/verification/routing_suppression_config_task_c4682ae05cbc47f9669a58d5121cf38d/outputs/suppression_config.json \
  --allocations docs/verification/routing_suppression_verifier_task_06376269c285c93f098d02f585d2dc92/sample_board_allocations.json \
  --out docs/verification/routing_suppression_verifier_task_06376269c285c93f098d02f585d2dc92/outputs \
  --generated-by grashnuk \
  --generated-at 2026-06-20T04:50:00.000Z
node scripts/orc-routing-suppression-enforcement-verifier.mjs verify \
  --config docs/verification/routing_suppression_config_task_c4682ae05cbc47f9669a58d5121cf38d/outputs/suppression_config.json \
  --allocations docs/verification/routing_suppression_verifier_task_06376269c285c93f098d02f585d2dc92/sample_board_allocations.json \
  --out docs/verification/routing_suppression_verifier_task_06376269c285c93f098d02f585d2dc92/outputs/verification_report_command.json \
  --summary-out docs/verification/routing_suppression_verifier_task_06376269c285c93f098d02f585d2dc92/outputs/discord_summary_command.md \
  --generated-by grashnuk \
  --generated-at 2026-06-20T04:50:00.000Z
git diff --check
./node_modules/.bin/eslint /home/pfrpc/repos/tasknode-routing-suppression-verifier/scripts/orc-routing-suppression-enforcement-verifier.mjs --quiet
find docs/verification/routing_suppression_verifier_task_06376269c285c93f098d02f585d2dc92 -type f -name '*.json' -print0 | \
  xargs -0 -n1 node -e "const fs=require('fs'); JSON.parse(fs.readFileSync(process.argv[1],'utf8'));"
```

Note: script-specific ESLint was run from `/home/pfrpc/repos/tasknodeofficial`, where dependencies are installed, against the absolute path in this linked worktree.

## Sample data coverage

The sample allocation fixture contains 6 board allocation records:

- `@lowquality`: pre-suppression allocation plus post-suppression blocked allocation attempt.
- `@clusterwallet`: post-suppression active proposed allocation, classified as a violation.
- `@refusedoperator`: only pre-suppression allocation, classified as enforced.
- `@thinreviewer`: post-suppression suppressed allocation attempt, classified as enforced.
- `@selfattested`: suppressed contributor with no matching board allocation evidence, classified as not tested.
- `@normaloperator`: unsuppressed contributor allocation, counted separately as non-suppressed board activity.

## Generated report summary

`outputs/batch_output.json`:

```json
{
  "ok": true,
  "schema": "pf.orc.routing_suppression_enforcement_verification.v1",
  "summary": {
    "suppressedContributors": 5,
    "allocationRecords": 6,
    "enforced": 3,
    "violated": 1,
    "notTested": 1,
    "nonSuppressedAllocationRecords": 1,
    "violationContributorHandles": [
      "clusterwallet"
    ]
  },
  "mode": "verification_only_no_enforcement"
}
```

Safety flags from `outputs/verification_report.json`:

```json
{
  "mode": "verification_only_no_enforcement",
  "readOnly": true,
  "wouldMutateLiveRouting": false,
  "wouldMoveFunds": false,
  "wouldBanAccounts": false,
  "wouldDeploy": false
}
```

Per-contributor classifications:

```json
[
  {
    "handle": "clusterwallet",
    "status": "violated",
    "activePost": 1,
    "blockedPost": 0,
    "total": 1
  },
  {
    "handle": "lowquality",
    "status": "enforced",
    "activePost": 0,
    "blockedPost": 1,
    "total": 2
  },
  {
    "handle": "refusedoperator",
    "status": "enforced",
    "activePost": 0,
    "blockedPost": 0,
    "total": 1
  },
  {
    "handle": "selfattested",
    "status": "not_tested",
    "activePost": 0,
    "blockedPost": 0,
    "total": 0
  },
  {
    "handle": "thinreviewer",
    "status": "enforced",
    "activePost": 0,
    "blockedPost": 1,
    "total": 1
  }
]
```

## Discord-ready summary excerpt

```text
@goodalexander Routing suppression verification report is ready.

Mode: verification_only_no_enforcement (read-only; no routing changes executed)
Suppressed contributors checked: 5
Board allocation records scanned: 6
Enforced: 3
Violated: 1
Not tested: 1

Escalation recommended: clusterwallet had active post-suppression allocation evidence. Human review required before any routing action.

No enforcement, bans, clawbacks, fund movement, signing, deployment, or live routing mutation occurred.
```

## Public artifact

Public PR: https://github.com/postfiatorg/tasknodeofficial/pull/142

Commit: https://github.com/postfiatorg/tasknodeofficial/commit/1effacade9eaf8c9762727fbceed9312bb3d9df6

Branch: `codex/routing-suppression-enforcement-verifier`

No deploy was performed.
