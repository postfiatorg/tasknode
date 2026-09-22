# Production task generation and routing investigation — 2026-09-10

Initial investigation snapshot. **Resolved in release 733**; see [release.md](release.md) for the completed deployment, recovered task and profile repair.

Account: `acct_oauth_b259edff110c43d66cb95267`, public handle `0xpostfiatchad`.
Active wallet: `rpHvzMCKZ7JrzGfRseXohC3RsMWqcnEKkA`.
Resolved through app_accounts, account_linked_wallets, provider identity and
pftl_sync_wallets/task_projections. One active wallet; 72 task records.
Production app: tasknodeofficial-dev (tasknode.postfiat.org), release 732.

## Failed requests

- `req_cf56f893b039a59e402b2e96952eb28478059fba3fbe476783fbccc99b7412c0`:
  detailed Section C request; created 2026-09-08 11:21:44 UTC, failed 11:23:04 UTC.
- `req_6948d1976ba592b3462ccf2b6f646346f34d9650dfffbbacada8cf3c76a2113d`:
  shorter Section C request; created 2026-09-08 11:27:42 UTC, failed 11:28:49 UTC.

Both exhausted three worker attempts with taskgen_provider_output_invalid.
The persisted lastProviderFailure only recorded attempt 2, code and maxAttempts;
validationError and the rejected response were not retained. The exact historical
validation condition cannot be established. Neither request produced a task.
Since September 7 the request table had 136 proposed requests, two failed
provider-output requests and two cancelled provider-output requests at query time.
The worker is running, and this account successfully generated another task on
September 9.

Diagnostic generation used the shorter request's original stored bundle, projected
by production code: 24,622 characters, GLM 5.3 through Vercel, xhigh reasoning.
Response `gen_01M25WEDQ6S68XFD1HD7JT2QXE` passed output validation; readiness response
`gen_01M25WES4XYHEJBZVSV6MRPTY5` passed all three readiness checks. Total elapsed
13,648 ms. Reported gateway cost: $0.01334455 across both calls. This was a
provider-only diagnostic: no offer, projection, request retry or dismissal.
Both original requests remain failed.

## Badge contradiction and production repair

Profile's current badge projection recognized existing verified GitHub Core
Contributor authorization. account_network_badges had zero rows for the account.
Candidate routing queried only that table and returned no_verified_badge, while
the Tasks summary independently displayed the projected Core Contributor badge.

Ran the existing refreshIdentityApprovalsFromProjection for this account/wallet
with operator marker production_badge_projection_repair_20260910. It materialized
core_contributor from existing authorization. The production eligibility function
then returned available_for_routing, freeSlots=1, available=true, no blockers.
No new privilege rule or allowlist entry was introduced.

## Local recurrence fixes (not deployed)

- Routing candidate validation now uses Profile's canonical current badge projection.
- The board pool discovers linked/synced wallet accounts in addition to stored badge
  holders, then applies the canonical eligibility and existing capacity checks.
- Generation failure metadata preserves typed validation reasons and the final
  attempt, including exhausted personal requests. JSON syntax errors use a fixed
  code so parser messages cannot embed rejected model content.

Validation: network-task-badge-gate-smoke, task-generation-reliability-smoke,
npm run lint, inference-no-regex-check (238 files), git diff --check.
The reliability smoke's database ownership portion was skipped because the local
invocation had no DATABASE_URL. No production code deployment or browser
verification was performed; the production proof above is backend eligibility.
