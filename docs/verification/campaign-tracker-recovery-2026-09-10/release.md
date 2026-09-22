# Campaign Tracker validation repair — 2026-09-10

Production release **736** completed at **17:27:39 UTC** on `tasknodeofficial-dev` (https://tasknode.postfiat.org). Image: `registry.fly.io/tasknodeofficial-dev:deployment-01M265QP2RC44MJ8AB7DNX39C3`.

The reported `tracker text invalid` response hid the failing field and the correction needed. Validation now retains the existing error code while returning allowlisted field, reason and byte-limit metadata. Missing recording credentials receive `tracker_credential_required` with Providers guidance before any gateway request. Error responses contain no submitted values or credentials.

Validation passed: contract smoke (required/type/size and multibyte boundaries, safe metadata, missing credentials before gateway access), tracker database/route smoke (47 checks in an isolated schema), body-envelope smoke, lint, formatting and production build. The deployment completed and all nine worker guards passed. The deployed validation module returned the expected oversized-title and absent-credential responses; see [deployed-validation.json](deployed-validation.json). That canary performed no gateway, database or wallet writes.

The reviewed report is `/home/pfrpc/repos/campaign-tracker-error-report-2026-09-10.md`. Its diagnostic limit remains: the original failing operation was not supplied. This release repairs the confirmed validation boundary; it does not claim that a missing credential caused that incident.

Companion Corbanu Terminal changes preserve failed read routes and form drafts, resolve supported credential aliases, and fix provider-tab model assignment. Those changes passed 25 focused tests and actual PTY workflows in the isolated `fix/0.1.41-wallet-daemon-launch` worktree. They remain an unpublished terminal candidate; release 736 deploys only the backend changes.
