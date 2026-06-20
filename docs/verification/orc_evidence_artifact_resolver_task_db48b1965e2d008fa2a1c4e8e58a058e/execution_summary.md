# Orc Evidence Artifact Resolver

Task: `task_db48b1965e2d008fa2a1c4e8e58a058e`

## What Changed

Added `scripts/orc-evidence-artifact-resolver.mjs`, an offline reviewer-facing CLI that turns a GitHub PR URL, commit SHA, and expected artifact paths into directly inspectable verifier packets.

The resolver emits:

- direct GitHub commit URL;
- direct GitHub blob URL per artifact;
- direct raw GitHub URL per artifact;
- changed-file membership per artifact;
- local worktree existence check per artifact;
- commit-object existence check per artifact;
- SHA-256 per artifact;
- compact JSON/text excerpts from each artifact;
- reviewer checklist showing whether all expected proof fields are present.

It is read-only/offline: no signing, no live API submission, no messaging, no fund movement, and no enforcement.

## Sample Command

```bash
node scripts/orc-evidence-artifact-resolver.mjs resolve \
  --pr-url https://github.com/postfiatorg/tasknodeofficial/pull/169 \
  --commit ba3b732669c7d98c0dd9dac67b3faeb6ec32e05a \
  --artifact docs/verification/submission_ingestion_accounting_tracker_task_9bbe896c161e52fd23a14556e68b82f2/outputs/status_dashboard.json \
  --artifact docs/verification/submission_ingestion_accounting_tracker_task_9bbe896c161e52fd23a14556e68b82f2/outputs/accounting_ledger.json \
  --artifact scripts/orc-submission-ingestion-tracker.mjs \
  --out docs/verification/orc_evidence_artifact_resolver_task_db48b1965e2d008fa2a1c4e8e58a058e/outputs \
  --repo-root . \
  --generated-at 2026-06-20T10:30:00.000Z
```

Result:

- `ok: true`
- `artifactCount: 3`
- `changedFileCount: 10`
- `checklistPassed: 7`
- `checklistTotal: 7`

## Generated Outputs

- `outputs/artifact_resolution_packet.json`
- `outputs/artifact_resolution_packet.md`

## Verification Commands

```bash
npm run orc-evidence-artifact-resolver-smoke
npm run lint
npm run format-check
git diff --check
```

Results:

- `orc-evidence-artifact-resolver-smoke ok`
- lint passed
- `format check ok`
- `git diff --check` passed

## Sample Packet Facts

For `docs/verification/submission_ingestion_accounting_tracker_task_9bbe896c161e52fd23a14556e68b82f2/outputs/status_dashboard.json`, the generated packet includes:

- localExists: `true`
- committedExists: `true`
- changedInCommit: `true`
- blob/raw URLs pinned to commit `ba3b732669c7d98c0dd9dac67b3faeb6ec32e05a`
- excerpt summary showing `totalRecords: 10` and `byState.accounted_for: 10`

For `outputs/accounting_ledger.json`, the generated packet includes:

- recordsCount: `10`
- firstRecord.state: `accounted_for`

These fields make the artifact independently resolvable by a reviewer instead of relying only on prose evidence.
