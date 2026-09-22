# Production repair completed — 2026-09-10

Release 733 is deployed to https://tasknode.postfiat.org.
Image: registry.fly.io/tasknodeofficial-dev:deployment-01M25XPPGGG99ZKJE3TJV3PKH0
Digest: sha256:68dfb1c5be6d9a357a7f78ed926d642bc6eac57b42bc5522363ca77a7cffc7c3

## Results

- Restored Core Contributor's durable badge from existing authorization; routing
  reports available_for_routing with one free slot.
- Recovered request req_cf56f893b039a59e402b2e96952eb28478059fba3fbe476783fbccc99b7412c0
  as task_8cdd1e8c38daa39bf7ae7495746328a3, proposed:
  “Implement UNL V2 Section C Paired Adversarial and Liveness Gate”.
  The description preserves preregistration before trials, the offline deterministic
  V2-only experiment, frozen V1/A/B/amendment/whitepaper artifacts, SHADOW_ONLY,
  no validator mutation, and stopping before section D.
- Closed duplicate req_6948d1976ba592b3462ccf2b6f646346f34d9650dfffbbacada8cf3c76a2113d
  with a retained dismissal receipt pointing to the recovered task. No duplicate
  offer was created. listTaskRequests reports zero needsAttention records.
- Restored goodalexander's prior authenticated browser membership to the affected
  postfiatchad browser set. Source set 885c1b3b-a690-40ad-abb1-bdc9c97e1e24 already
  contained both accounts. Target 89599f12-d228-4693-810b-10d870685bbb had been split
  by the defective list path. The repair required the exact active password
  session created at 2026-09-10T14:36:55.445Z and an unrevoked source membership;
  the target set now contains both accounts. Recovery provenance is recorded in
  device_account_sets.metadata_json.profileListRecovery.

## Causes and fixes

GET /api/auth/accounts previously re-registered the selected account and rotated
its device cookie every time the menu loaded. Concurrent responses invalidated
one another's tokens and silently created one-account sets. Lists are now reads:
no cookie rotation, no resurrecting removed memberships, no silent replacement
for an invalid token. Add-account start likewise waits for independent
authentication before rotating. Fresh authentication and selection still rotate
credentials. Concurrent selections revalidate the token under a row lock.

The client ignored unsuccessful logout HTTP responses and failed to clear its
transition overlay on network errors. Password login and switching also lacked
complete network-error handling. The UI now reports failures and permits retry,
keeps the last successfully loaded profiles, labels Switch profile explicitly,
and reloads after successful login. Successful account transitions remain
isolated until navigation completes.

Manual Retry previously left worker_attempt_count at the exhausted limit while
requeuing, so the worker would never claim the request. The new manual retry base
renews the bounded automatic attempt budget while lifetime attempts remain
monotonic. Stale retry commands cannot restart a later failure. The recovered
request succeeded on lifetime attempt 4, the first attempt of its renewed cycle.
Typed validation reasons and final failure attempts are now retained.

## Verification

- npm run lint; npm run build; git diff --check.
- npm run auth-login-state-fixture: 20 provider/identity/logout transitions.
- node scripts/multi-account-password-wallet-smoke.mjs.
- node scripts/device-account-concurrency-smoke.mjs with runtime and local
  PostgreSQL: concurrent lists, credential rotation, simultaneous selections,
  scoped logout, stale-read rejection and logout-all revocation.
- node scripts/task-generation-manual-retry-smoke.mjs against local PostgreSQL:
  two exhausted/retried cycles, stale recovery, monotonic idempotency guards.
  The fixture transaction rolls back all writes.
- node scripts/task-generation-reliability-smoke.mjs; network-task-badge-gate-smoke.
  The standalone reliability run skipped its optional DB ownership portion;
  the two targeted PostgreSQL fixtures above exercised the changed DB boundaries.
- npm run inference-no-regex-check: 238 files passed.
- account-switch-browser-smoke.mjs against both local App and the deployed
  production frontend: real Chrome/React with fixture HTTP responses.
  See auth-browser-local.json and auth-browser-production.json.
- Separate real production HTTP test: temporary private fixture accounts,
  actual password login, add-account start, five concurrent lists, switch,
  old-session rejection, current logout, logout-all and login again.
  See auth-production-http.json. Fixture account/session/credential rows removed.
- Deployed web source hashes equal the tested local files; see
  deployed-source-hashes.json. All nine background groups pass the Fly guard,
  including taskgen and the NFT renderer; the public web app passed HTTP and
  rendered-frontend checks.

The initial post-deploy guard caught taskgen during a restart following database
connection timeouts. It recovered under restart=always. The aggregate guard and
a subsequent focused taskgen guard passed; taskgen then generated the recovered
request successfully. No manual fleet restart or duplicate worker was needed.

Deployment used npm run fly:deploy:prod under explicit user authorization.
Changes were deployed from the working tree; no Git push was performed.
