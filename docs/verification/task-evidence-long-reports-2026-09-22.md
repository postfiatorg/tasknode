# Long terminal evidence reports — 2026-09-22

## Change

The terminal evidence route inherited a 24,000-character summary cap even though the existing direct-write evidence path supports 120,000 characters. The route now accepts 120,000 characters for both initial submissions and verification responses. The 1 MiB request-body limit remains enforced.

The terminal CLI extracts citation URLs into separate evidence items. Previously those items could cause direct-write normalization to omit the report supplied in summary/value. The route now retains the complete report as the primary artifact before citation items. The existing two-artifact persistence limit remains; all citations written in the report remain in its text.

Changed implementation:
- server/request-body-contracts.js: evidence-specific summary limit.
- server/tasknode-terminal-evidence.js: report-preserving submission normalization.
- server/tasknode-terminal-routes.js: use that normalization.
- scripts/task-evidence-report-smoke.mjs: HTTP validation and captured lifecycle database-write regression.
- docs/wiki/surfaces/tasks.md and src/features/docs/docs-content.js: report limits and behavior.

## Verification

Passed:
- node scripts/task-evidence-report-smoke.mjs
- node scripts/request-validation-smoke.mjs
- node scripts/offchain-task-lifecycle-smoke.mjs
- npm run lint
- npm run public-help-check
- npm run migration-registration-smoke
- TASKNODE_CONFIRM_PRODUCTION_DEPLOY=yes node scripts/fly-deploy-preflight.mjs
- git diff --check

The report regression exercises 24,001-, 40,000-, and 120,000-character reports in both phases, with and without citation items. It checks exact report equality in the task-event database parameters, including a Unicode ending. A 120,001-character summary and a request above 1 MiB are rejected without event writes. It also covers duplicate text artifacts and legacy value-only submissions.

The same HTTP fixture passed inside the production candidate image with external networking disabled. Persistence was captured through a fixture database client, not a real user task.

## Production

Applied a targeted API image update to preserve the current production image and all unrelated local edits. No worker or database migration was changed. The frontend Help edits remain in the repository for the next frontend build.

- App: tasknodeofficial-dev (https://tasknode.postfiat.org)
- API machine: 8d4930ae156638
- Previous image: registry.fly.io/tasknodeofficial-dev:alloc-throughput-api-20260922-v12@sha256:8856a9e18e8d7aa3e76c952a85fd0ef0cfecefde037910f8a8c23ff17c3397d9
- Updated image: registry.fly.io/tasknodeofficial-dev:evidence-reports-120k-20260922@sha256:7182bdb8b9870a9efc0429cdad4d4d598eef83ce629b9effee2acfe090b72c4d
- Only the three implementation files above were overlaid onto the previous image.
- Fly machine update completed with its health check passing.
- Public GET /api/health returned ok=true.
- Read-only assertions against deployed modules confirmed summaryLimit=120000, both phases, full report and citation retention, and oversized-summary rejection; databaseWrites=0.

No real report was resubmitted, no task state was changed for verification, and no reward was issued. The source changes remain local; no Git push was performed.
