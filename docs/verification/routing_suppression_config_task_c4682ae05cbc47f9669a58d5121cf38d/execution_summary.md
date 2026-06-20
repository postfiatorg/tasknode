# Contributor Routing Suppression Config Generator Evidence

Task: `task_c4682ae05cbc47f9669a58d5121cf38d`
Title: Build Contributor Routing Suppression Config Generator

## What changed

- Added `scripts/orc-contributor-routing-suppression-config.mjs`, a dependency-free Node CLI that consumes `pf.orc.contributor_quality_routing_report.v1` reports and emits `pf.orc.contributor_routing_suppression_config.v1` artifacts.
- Added sample input report data with five mock contributors recommended for routing suppression review.
- Added an existing dry-run suppression config fixture to prove added, removed, unchanged, and changed reconciliation paths.
- Generated config, dry-run, reconciliation, and Discord-ready output artifacts under `docs/verification/routing_suppression_config_task_c4682ae05cbc47f9669a58d5121cf38d/outputs/`.

This is recommend-only tooling. It does not mutate live routing, execute bans, sign enforcement transactions, move funds, claw back rewards, or deploy.

## Commands run

```bash
chmod +x scripts/orc-contributor-routing-suppression-config.mjs
node --check scripts/orc-contributor-routing-suppression-config.mjs
node scripts/orc-contributor-routing-suppression-config.mjs --help \
  > docs/verification/routing_suppression_config_task_c4682ae05cbc47f9669a58d5121cf38d/help_output.txt
node scripts/orc-contributor-routing-suppression-config.mjs batch \
  --report docs/verification/routing_suppression_config_task_c4682ae05cbc47f9669a58d5121cf38d/sample_quality_routing_report.json \
  --existing-config docs/verification/routing_suppression_config_task_c4682ae05cbc47f9669a58d5121cf38d/existing_suppression_config.json \
  --out docs/verification/routing_suppression_config_task_c4682ae05cbc47f9669a58d5121cf38d/outputs \
  --generated-by grashnuk \
  --generated-at 2026-06-20T04:00:00.000Z \
  --expiry-days 14 \
  > docs/verification/routing_suppression_config_task_c4682ae05cbc47f9669a58d5121cf38d/outputs/batch_output.json
node scripts/orc-contributor-routing-suppression-config.mjs generate \
  --report docs/verification/routing_suppression_config_task_c4682ae05cbc47f9669a58d5121cf38d/sample_quality_routing_report.json \
  --out docs/verification/routing_suppression_config_task_c4682ae05cbc47f9669a58d5121cf38d/outputs/suppression_config_generate.json \
  --dry-run \
  --generated-by grashnuk \
  --generated-at 2026-06-20T04:00:00.000Z \
  --expiry-days 14 \
  > docs/verification/routing_suppression_config_task_c4682ae05cbc47f9669a58d5121cf38d/outputs/generate_dry_run_output.json
node scripts/orc-contributor-routing-suppression-config.mjs reconcile \
  --existing-config docs/verification/routing_suppression_config_task_c4682ae05cbc47f9669a58d5121cf38d/existing_suppression_config.json \
  --report docs/verification/routing_suppression_config_task_c4682ae05cbc47f9669a58d5121cf38d/sample_quality_routing_report.json \
  --out docs/verification/routing_suppression_config_task_c4682ae05cbc47f9669a58d5121cf38d/outputs/reconciliation_output_command.json \
  --generated-by grashnuk \
  --generated-at 2026-06-20T04:00:00.000Z \
  --expiry-days 14 \
  > docs/verification/routing_suppression_config_task_c4682ae05cbc47f9669a58d5121cf38d/outputs/reconcile_stdout.json
git diff --check
./node_modules/.bin/eslint /home/pfrpc/repos/tasknode-routing-suppression-config/scripts/orc-contributor-routing-suppression-config.mjs --quiet
```

Note: script-specific ESLint was run from `/home/pfrpc/repos/tasknodeofficial`, where dependencies are installed, against the absolute path in this linked worktree.

## Generated output summary

`outputs/batch_output.json`:

```json
{
  "ok": true,
  "schema": "pf.orc.contributor_routing_suppression_config.v1",
  "summary": {
    "contributorsEvaluated": 7,
    "flaggedForRoutingReview": 5,
    "suppressionEntryCount": 5,
    "expiresAt": "2026-07-04T04:00:00.000Z",
    "violationCounts": {
      "repeated_unverifiable_submissions": 3,
      "consecutive_unverifiable_submissions": 2,
      "low_verified_to_total_ratio": 3,
      "recent_refusals": 1,
      "self_attested_only_pattern": 1
    }
  },
  "reconciliation": {
    "existing": 3,
    "next": 5,
    "added": 3,
    "removed": 1,
    "unchanged": 1,
    "changed": 1
  },
  "mode": "recommend_only_no_enforcement"
}
```

Config safety proof:

```json
{
  "mode": "recommend_only_no_enforcement",
  "dryRunOnly": true,
  "operationalUseAllowed": false,
  "entries": 5,
  "entryOperationalFlags": [
    false
  ],
  "requiresHumanApproval": [
    true
  ]
}
```

Dry-run proof:

```json
{
  "schema": "pf.orc.contributor_routing_suppression_dry_run.v1",
  "wouldWrite": true,
  "wouldMutateLiveRouting": false,
  "proposedSuppressionCount": 5
}
```

Reconciliation proof:

```json
{
  "schema": "pf.orc.contributor_routing_suppression_reconciliation.v1",
  "counts": {
    "existing": 3,
    "next": 5,
    "added": 3,
    "removed": 1,
    "unchanged": 1,
    "changed": 1
  },
  "added": [
    "clusterwallet",
    "selfattested",
    "thinreviewer"
  ],
  "removed": [
    "legacystale"
  ],
  "unchanged": [
    "lowquality"
  ],
  "changed": [
    "refusedoperator"
  ]
}
```

## Discord-ready summary excerpt

```text
@goodalexander Contributor routing suppression config is ready for review.

Mode: recommend_only_no_enforcement (dry-run only; no live routing changes executed)
Suppression entries recommended: 5
Contributors evaluated upstream: 7
Expiry for recommendations: 2026-07-04T04:00:00.000Z

Reconciliation vs existing config:
- Added: 3
- Removed: 1
- Unchanged: 1
- Changed: 1
```

## Public artifact

Public PR: https://github.com/postfiatorg/tasknodeofficial/pull/138

Commit: https://github.com/postfiatorg/tasknodeofficial/commit/388d73923a1d1173a948290edc564efbf60a8377

Branch: `codex/routing-suppression-config-generator`

No deploy was performed.
