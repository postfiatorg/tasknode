# Overnight Comprehensive Code Review Whip

Date: 2026-05-25
Repo: `/home/pfrpc/repos/tasknodeofficial`
Expected reviewer runtime: about 8 interrupted hours
Primary output document: this file, updated continuously while reviewing

## Mission

You are creating a comprehensive code review of this repo.

Go through every single file in this repository and determine whether it is safe, coherent, documented, and production-credible. This is an overnight review job, not a 30-minute skim. Do not come back with "finished everything" unless you have genuinely covered the whole repo, updated the working notes, and left a clear residual-risk list.

The review goals are:

1. Ensure every file is of high quality for its role.
2. Ensure implemented behavior exists in docs somewhere when it belongs in docs.
3. Ensure there are no reachable P0 or P1 bugs.
4. Flag dependency risks, security risks, billing risks, state risks, and code quality issues.
5. Assume about 8 hours of interrupted work.
6. We do not have real users yet. If you find actual P0s or P1s, you may fix them.
7. If you make code changes, add them to the testing list with exactly what functionality needs to be tested.
8. Work continuously against this document so progress is auditable in the morning.

## Severity Bar

- `P0`: data loss, account leakage, wallet/seed exposure, billing or deposit miscredit, auth bypass, reward double-pay, deploy-blocking startup failure, or a normal user path that corrupts canonical state.
- `P1`: likely user-visible state mismatch, incorrect task/reward/payment state, stale projections, missing account filter, broken wallet gate, broken task submission/review flow, undocumented production behavior, or failed recovery path.
- `P2`: maintainability risk, missing observability, weak test coverage, unclear docs, dependency risk, brittle code shape, or confusing but non-corrupting UX state.
- `P3`: polish, naming, minor docs, low-risk cleanup.

Do not inflate speculative concerns into P0/P1. A P0/P1 needs a concrete code path, data boundary, account/money impact, or reachable workflow failure.

## Hard Rules

- Do not hard-code user examples, task IDs, wallet addresses, literal messages, or one-off regex product behavior as a fix.
- If a natural-language behavior is broken, fix the routing, classifier, policy, persistence, provider, or prompt boundary that failed.
- Do not delete migrations, prompts, mocks, docs, or workers unless the deletion is the actual reviewed fix and is documented.
- Do not run destructive database commands.
- Do not hide failures by loosening tests.
- If you change code, update docs when the behavior changed.
- If you change UX, inspect the actual running app and include screenshots.
- If you change PFTL/task/wallet/billing code, run the relevant smoke and record concrete evidence.
- Keep fixes small and reviewable. Large rewrites need explicit justification in the notes.

## Worktree And Merge Hygiene

- Start from current `origin/main`.
- Use a separate worktree or branch for review work. Suggested branch: `review/overnight-comprehensive-code-review`.
- Before editing:

```bash
git fetch origin main
git status --short --branch
git rev-parse --short HEAD
git rev-parse --short origin/main
```

- Do not dirty active `main` unless explicitly directed by the integration owner.
- Commit fixes in small logical commits.
- If the worktree becomes dirty from generated output, document what generated it.
- Before handoff:

```bash
git diff --check origin/main...HEAD
npm run quality
```

Run additional targeted checks for any touched surface.

## Required Ramp

Read these first:

1. `/home/pfrpc/repos/AGENTS.md`
2. `/home/pfrpc/.codex/skills/tasknodeofficial/SKILL.md`
3. `README.md`
4. `package.json`
5. `docker-compose.dev.yml`
6. `fly.toml`
7. `docs/wiki/index.md`
8. `docs/review_burndown/README.md`
9. `docs/review_burndown/composer_full_codebase_review_plan_2026-05-23.md`
10. `docs/review_burndown/recent_work_pr_review_spec_2026-05-24.md`
11. `docs/ETHEREUM_TOP_UPS.md`
12. `docs/DATABASE_ARCHITECTURE.md`

Then inventory the repo:

```bash
rg --files | sort > /tmp/tasknodeofficial_all_files.txt
wc -l /tmp/tasknodeofficial_all_files.txt
find server src shared scripts prompts schemas docs -type f | sort
git ls-files | sort
```

## Every-File Review Method

For each file, ask:

- What does this file do?
- Is it still used?
- Is it documented if it defines user-visible, operator-visible, billing, wallet, task, memory, Hive, profile, or deployment behavior?
- Does it have account ownership boundaries where needed?
- Does it have idempotency where retries can happen?
- Does it fail closed for money, wallet, auth, provider, and persistence paths?
- Does runtime-store behavior match Postgres behavior where both exist?
- Does the frontend render canonical server state, or does it invent state?
- Does async work have recovery, retry, and duplicate-prevention logic?
- Does it contain hard-coded semantic behavior that belongs in a prompt, policy, classifier, or repository boundary?
- Does it introduce dependency, bundle, build, or deploy risk?

## Coverage Plan

### 1. Entry Points And Config

Files:

- `package.json`
- `vite.config.*`
- `Dockerfile`
- `docker-compose*.yml`
- `fly.toml`
- `.github/**`
- `server/index.js`
- `server/product-contracts.js`
- `server/route-policies.js`

Look for:

- route auth mismatch
- startup config that silently falls back to unsafe defaults
- local Docker vs Fly behavior drift
- public app using ephemeral state
- routes returning misleading errors
- route contracts not matching frontend assumptions

### 2. Auth, Accounts, Wallets, Billing, Deposits

Files:

- `server/auth*.js`
- `server/runtime-store.js`
- `server/repositories/chat-billing.js`
- `server/ethereum-deposits.js`
- `server/pftl-balance.js`
- `src/features/wallet/**`
- `src/features/billing/**`
- related migrations and docs

Look for:

- account identity merge mistakes
- signed-out access to account data
- wallet unlock bypasses
- local vault, linked wallet, and signed-in account confusion
- deposit address pre-funding bugs
- billing ledger projection mistakes
- admin credits being treated as deposit proof
- provider costs charged without preflight credit gate

Required checks if touched:

```bash
npm run security-smoke
npm run runtime-smoke
npm run chat-billing-postgres-smoke
npm run route-smoke
```

### 3. Chat, Context, Memory, Providers

Files:

- `server/chat*.js`
- `server/context*.js`
- `server/repositories/context*.js`
- `server/repositories/chat-memory.js`
- `src/features/chat/**`
- `src/features/context/**`
- `src/features/memory/**`
- `prompts/chat/**`
- `prompts/memory/**`

Look for:

- context/memory/task inputs missing from one chat surface
- stream and non-stream behavior divergence
- context refine accepting stale proposal state
- context document save saying success before persistence
- user memory injected as instructions instead of context
- prompt files not reflected in Help docs
- provider policy drift or missing ZDR/private routing

Required checks if touched:

```bash
npm run chat-attachment-smoke
npm run chat-context-status-smoke
npm run context-edit-smoke
npm run context-line-map-parity-smoke
npm run network-task-profile-smoke
```

### 4. Tasks, Evidence, PFTL, Rewards

Files:

- `server/task*.js`
- `server/network-task*.js`
- `server/pftl*.js`
- `server/repositories/tasks.js`
- `server/repositories/pftl-cache*.js`
- `src/features/tasks/**`
- `prompts/task_engine/**`
- `prompts/reward/**`
- task/PFTL migrations and docs

Look for:

- task list, detail, and forensics showing different states
- verification requested vs submitted vs awaiting review confusion
- reducer/projection divergence
- evidence packet not viewable in forensics
- duplicate reward, missing reward, or zero reward misclassified
- network allocation state confused with task lifecycle state
- cache replay missing authority/allocation wallet events
- task generation/review prompts requiring evidence types the UI cannot submit

Required checks if touched:

```bash
npm run task-lifecycle-smoke
npm run task-receipt-projection-smoke
npm run pftl-cache-reducer-replay-smoke
npm run task-evidence-drafts-smoke
npm run task-copy-payload-smoke
npm run network-task-recovery-smoke
npm run network-task-reward-followup-smoke
```

### 5. Hive, Board Manager, Network Routing

Files:

- `server/board-manager*.js`
- `server/hive*.js`
- `server/repositories/board-manager.js`
- `server/repositories/hive*.js`
- `src/features/hive/**`
- `prompts/hive/**`

Look for:

- agent action not auditable in UX
- no-action decisions without useful reasoning
- agent unable to message the correct user
- stale Hive Context or Secretary reports
- project/task/contributor state drift
- context packet bloat causing provider failures
- board manager running in the wrong environment or wrong cadence

Required checks if touched:

```bash
npm run board-manager-smoke
npm run board-manager-secretary-packet-smoke
npm run board-manager-source-packet-smoke
npm run board-manager-micro-summary-smoke
npm run board-manager-action-hooks-smoke
npm run board-manager-scheduler-smoke
npm run hive-context-smoke
npm run hive-project-planning-smoke
```

### 6. Profile, NFT, Airdrop, Discovery

Files:

- `server/profile*.js`
- `server/repositories/profile*.js`
- `src/features/profile/**`
- `prompts/profile/**`

Look for:

- public profile claims not backed by actual profile/task/airdrop data
- airdrop amount, 7-day average, reward totals, and displayed copy disagreeing
- NFT prompt privacy leak
- generated NFT media not available in gallery
- profile summary prompt producing jargon or unusable discovery text
- daily airdrop double-pay or missed-pay paths

Required checks if touched:

```bash
npm run profile-nft-prompt-smoke
npm run profile-nft-flow-smoke
npm run profile-daily-airdrop-worker-smoke
```

### 7. Frontend App Surface

Files:

- `src/main.jsx`
- `src/styles.css`
- `src/features/**`
- frontend helpers under `src/**` and `shared/**`

Look for:

- stale local state after server-side state transition
- duplicated modals or inconsistent card surfaces
- hidden buttons, broken scroll, overflow, confusing submission flows
- copy/upload/evidence controls not matching actual data model
- colors/styles that violate the app style guide
- frontend assuming data shape not guaranteed by API

Required checks if touched:

```bash
npm run build
npm run route-smoke
```

If visible UX changes, take screenshots from the running app.

### 8. Docs, Prompts, Schemas, Scripts, Migrations

Files:

- `docs/**`
- `prompts/**`
- `schemas/**`
- `scripts/**`
- `server/db/migrations/**`

Look for:

- implemented behavior missing from Help docs
- docs describing legacy or future behavior as current
- prompt files not listed in docs
- schema and reducer mismatch
- migrations not idempotent
- smoke scripts no longer exercising production code paths
- scripts requiring hidden local state without docs

Required checks if touched:

```bash
npm run quality
node server/db/migrate.js
```

Use Postgres-backed checks when repository or migration behavior changes.

## Continuous Working Notes

Update this section as you work. Do not leave it blank.

### Timeline

- `2026-05-25 02:36 UTC` Started review in the existing `tasknofficial` session. Integration checkout is `main` at `f201ffe`, matching `origin/main`; only pre-existing untracked `.review_shell_out.txt` is present.
- `2026-05-25 02:36 UTC` Completed initial file inventory: `git ls-files` reports 535 tracked files. Inventory written to `/tmp/tasknodeofficial_all_files.txt`.
- `2026-05-25 02:36 UTC` Ramp docs partially read: workspace `AGENTS.md`, `tasknodeofficial` skill, `README.md`, `package.json`, `docker-compose.dev.yml`, `fly.toml`, wiki index, review burndown README, recent PR review spec, Ethereum top-up doc, and database architecture doc.
- `2026-05-25 02:58 UTC` Confirmed first P1: no-scope usage ledger reads could return account billing rows. Runtime proof created an account credit, then `usageLedger({ accountId: "", conversationId: "" })` returned that account ID.
- `2026-05-25 03:04 UTC` Patched usage ledger boundary: `/api/usage/ledger` now requires session, app state returns zero usage for signed-out users, and repository ledger helpers return an empty ledger for no-scope calls.
- `2026-05-25 03:17 UTC` Verification passed for the usage ledger patch: `npm run security-smoke`, `npm run runtime-smoke`, `npm run quality`, `npm run db:chat-billing-smoke` with local Docker `DATABASE_URL`, `npm run route-smoke`, `npm run smoke`, and `git diff --check`.
- `2026-05-25 03:31 UTC` Confirmed and patched P0 duplicate-publish risk in `server/task-review-worker.js`: stale processing leases remain retryable, but successful worker publications are no longer reclaimable for another verification request or reward scoring/payment.
- `2026-05-25 03:35 UTC` Expanded `network-task-recovery-smoke` to cover already-published verification/reward worker states and verified local Docker DB recovery logs show `will_publish=false` for those states.
- `2026-05-25 03:50 UTC` Confirmed and patched Board Manager scope-status durability bug: worker startup can no longer convert a paused or disabled scope back to enabled unless status is explicitly provided.
- `2026-05-25 04:18 UTC` Auth/account-linking sample reviewed. Email, Telegram, Discord, GitHub provider-link boundaries are documented in `docs/wiki/architecture/auth-and-connected-accounts.md`; replay fixture passed with email invalid/success, Telegram valid/reconnect/invalid/expired/stale-state, Discord link, and logout transitions.
- `2026-05-25 04:26 UTC` Tracked-secret/public-readiness scan completed without printing secret values. Real local env files are gitignored/untracked. Tracked hits for API-key/env names are docs placeholders, test env names, package scripts, or ordinary `task-...` strings, not committed live credentials.
- `2026-05-25 04:39 UTC` Confirmed and patched daily airdrop no-double-pay gap: issuance rows now move to `processing` before signing, concurrent claims fail closed, and post-submit uncertainty stays non-retryable until reconciliation/operator review.
- `2026-05-25 04:46 UTC` Verification passed for the daily airdrop issuance patch: local Docker DB `profile-daily-airdrop-issuance-smoke`, idempotent DB migration, `profile-daily-airdrop-worker-smoke`, `npm run quality`, and `git diff --check`.
- `2026-05-25 04:55 UTC` Entry-point/config review continued. `.github/` is absent in this repo. Route policy sample and top-up route handlers match handler-enforced auth. Ethereum top-up smoke path and docs reviewed; no new P0/P1 found in that pass.
- `2026-05-25 05:00 UTC` Removed one stale PFTasks wording reference from the GitHub connected-account provider note. This is a product-copy cleanup, not a behavior change. `npm run auth-login-state-fixture`, `npm run runtime-smoke`, `npm run route-smoke`, and `git diff --check` passed after the change.
- `2026-05-25 05:12 UTC` Confirmed and patched P1 destructive bridge risk: `fly-dev:data:push` can no longer truncate and reload Fly dev data unless it targets `tasknodeofficial-dev` and the operator passes an explicit confirmation flag/env var.
- `2026-05-25 03:34 UTC` Reviewed task generation/review prompts and worker contracts. Patched task-kind taxonomy drift and server-side URL evidence SSRF boundary; `npm run task-lifecycle-smoke` and quiet lint passed.
- `2026-05-25 03:34 UTC` Reviewed Board Manager action hooks. Patched `message_user` so account targets must exist in the current source packet; local Docker `board-manager-action-hooks-smoke` passed.
- `2026-05-25 21:19 UTC` Continued Board Manager action-hook review. Found `assign_contributor` still trusted model-supplied contributor wallets; patched it to require the wallet to appear in the current source packet as a validated Hive Context wallet or eligible Network Task candidate. Local Docker `board-manager-action-hooks-smoke` passed.
- `2026-05-25 21:48 UTC` Found a second Board Manager compressed-packet boundary bug: the default DeepSeek secretary packet removed the Hive Context/candidate target lists that action hooks need for validation. Patched secretary packets to include a small action-target registry and taught action hooks to validate against it. `board-manager-secretary-packet-smoke` and local Docker `board-manager-action-hooks-smoke` passed.
- `2026-05-25 22:05 UTC` Reviewed Hive project frontend data refresh. Found the active project board loaded `/api/hive/projects` only once on mount, which can leave Network Task rows stale after task projection updates. Patched the route to refresh project state quietly while Hive is open and documented the refresh behavior.
- `2026-05-25 22:20 UTC` Ran a route-policy consistency scan across `server/route-policies.js`, `server/index.js`, and route modules. Optional routes reviewed in this pass are public/product-state reads or handler-scoped paths; no additional concrete P0/P1 found in this scan.
- `[time]` Completed ramp:
- `[time]` First P0/P1 finding:
- `[time]` First patch:
- `[time]` Final handoff:

### File Coverage Ledger

Keep a coverage ledger by directory. Add counts or notes as you complete each section.

- [ ] root config files reviewed
- [x] root config files inventory started: `README.md`, `package.json`, `docker-compose.dev.yml`, `fly.toml` read for ramp.
- [x] `.github/**` reviewed: directory is absent in this checkout.
- [ ] `server/**` reviewed
- [x] high-risk server billing/auth route sample reviewed: usage ledger, app state, memory, profile, Hive, wallet balance/transactions, PFTL cache.
- [x] auth/account linking sample reviewed: email challenge, Telegram signed callback, Discord OAuth link, provider conflict rules, stale OAuth state, logout.
- [x] Ethereum top-up/account funding sample reviewed: handler-enforced login, clean-address probe, account-scoped deposit address, deposit-credit ledger idempotency, and docs.
- [x] deploy/data bridge sample reviewed and patched: Fly dev bridge push now has a confirmation guard before any proxy/database work.
- [x] high-risk server task worker duplicate-publish path reviewed and patched.
- [x] task generation/review prompt and worker sample reviewed and patched: task-kind taxonomy plus URL evidence SSRF guard.
- [x] Hive/Board Manager action-hook sample reviewed and patched: message recipients and contributor assignments are constrained to current source-packet accounts, validated Hive Context wallets, or eligible Network Task candidates; the compressed secretary packet now carries a small action-target registry so production secretary mode keeps the same validation boundary.
- [ ] `server/repositories/**` reviewed
- [ ] `server/db/migrations/**` reviewed
- [ ] `src/**` reviewed
- [x] Hive frontend sample reviewed and patched: project document now refreshes while the Hive route is open instead of requiring a full reload after task projection changes.
- [ ] `shared/**` reviewed
- [ ] `scripts/**` reviewed
- [ ] `prompts/**` reviewed
- [ ] `schemas/**` reviewed
- [ ] `docs/**` reviewed
- [x] tracked-secret/public-readiness sample reviewed: no tracked local env files or live provider secrets found in the scanned patterns; gitignored local env files remain present on disk and must stay unprinted.
- [x] profile/daily-airdrop payment boundary reviewed and patched: scoring, issuance claim, retry state, candidate selection, docs, and DB smoke.

### Findings

Use this format for every finding:

```md
#### P1: Short title

- Files: `path/to/file.js:123`, `path/to/other.js:45`
- Boundary: auth | billing | wallet | tasks | PFTL | cache | docs | UI | provider | persistence | dependency
- What breaks:
- Why it matters:
- Evidence:
- Fix status: not fixed | fixed in commit <sha> | needs owner decision
- Tests needed:
```

#### P1: Signed-out usage ledger could expose account billing rows

- Files: `server/index.js`, `server/repositories/chat-billing.js`, `server/runtime-store.js`, `server/app-state.js`, `server/route-policies.js`, `scripts/smoke.mjs`, `scripts/security-smoke.mjs`, `docs/CURRENT_SYSTEM.md`
- Boundary: auth | billing | persistence
- What breaks: `/api/usage/ledger` was an optional-auth route. When no session was present, it passed empty account and conversation scope to `usageLedger`. Both runtime and Postgres repository paths treated empty scope as aggregate scope, so a signed-out caller could receive recent billing ledger rows across accounts.
- Why it matters: Billing ledger rows include account IDs, credit/debit metadata, provider/model cost records, and operational usage details. That is account data and must not be readable without a session.
- Evidence: Runtime proof used a temp store, credited `acct_private_leak_check`, then `usageLedger({ accountId: "", conversationId: "", limit: 5 })` returned `unscopedAccountIds: ["acct_private_leak_check"]`.
- Fix status: fixed in commit `a53f9a1`.
- Tests needed: passed `npm run security-smoke`, `npm run runtime-smoke`, `npm run quality`, local Docker `npm run db:chat-billing-smoke`, `npm run route-smoke`, `npm run smoke`, and `git diff --check`.

#### P0: Task review worker could republish stale reward work after projection lag

- Files: `server/task-review-worker.js`, `scripts/network-task-recovery-smoke.mjs`, `docs/wiki/surfaces/tasks.md`, `docs/wiki/architecture/network-task-recovery.md`
- Boundary: tasks | PFTL | rewards | persistence
- What breaks: review-worker claim queries treated `published=true` as stale after `published_at` aged past the worker stale timeout. `finalizeWorkerPublish` also cleared `published` when the task projection had not yet advanced to the expected status. If PFTL accepted a reward decision/payment but cache projection lagged, the same `verification_response_submitted` task could be claimed again and publish another reward path.
- Why it matters: positive reward scoring sends a PFT payment. Republished reward scoring can double-pay a task. Republished verification requests also create duplicate task state updates and confusing forensics.
- Evidence: code path in `claimVerificationResponses` selected rows where `metadata_json.workers.reward_scoring.published = true` if `published_at` was stale; `processVerificationResponse` publishes the reward before `finalizeWorkerPublish` checks projection status.
- Fix status: fixed in this commit.
- Tests needed: passed `npm run quality`, local Docker `DATABASE_URL=postgres://tasknodeofficial:tasknodeofficial@localhost:5436/tasknodeofficial TASKNODE_DATABASE_ENABLED=true npm run network-task-recovery-smoke`, and `git diff --check`.

#### P1: Board Manager worker startup could undo an operator pause

- Files: `server/repositories/board-manager-scheduler.js`, `scripts/board-manager-scheduler-smoke.mjs`, `docs/wiki/surfaces/hive.md`
- Boundary: Hive | worker scheduling | operator controls
- What breaks: `ensureBoardManagerScope()` defaulted `status` to `enabled` and used that value on conflict. `scripts/board-manager-worker.mjs` calls the helper on startup without an explicit status, so restarting the worker could flip a paused or disabled `board_manager_scopes` row back to enabled.
- Why it matters: An operator pause is the production kill switch for Board Manager actioning. If a restart silently re-enables it, the agent can resume mutating projects, messages, or Network Task allocations after the operator intentionally stopped it.
- Evidence: direct code path from worker startup to `ensureBoardManagerScope({ scope, maxActionsPerHour })`, with `status = "enabled"` as the helper default and `status = EXCLUDED.status` in the upsert.
- Fix status: fixed in this commit.
- Tests needed: passed local Docker `DATABASE_URL=postgres://tasknodeofficial:tasknodeofficial@localhost:5436/tasknodeofficial TASKNODE_DATABASE_ENABLED=true npm run board-manager-scheduler-smoke`, `npm run quality`, and `git diff --check`.

#### P0: Daily airdrop issuance could become retryable after uncertain PFT submission

- Files: `server/profile-daily-airdrop-issuance.js`, `server/repositories/profile-daily-airdrop.js`, `server/db/migrations/045_profile_daily_airdrop_processing_status.sql`, `scripts/profile-daily-airdrop-issuance-smoke.mjs`, `docs/wiki/surfaces/daily-airdrop.md`, `docs/wiki/surfaces/profile.md`
- Boundary: profile | airdrop | wallet | PFTL | persistence
- What breaks: a completed daily airdrop run could be claimed by more than one caller because the issuance row remained `pending` until after the PFTL path ran. Errors after a PFT submission attempt could also mark the row `failed`, making a retry capable of signing another payment for the same run.
- Why it matters: daily airdrop issuance is a real PFT payment. Any retryable state after a possible submission is a double-pay risk.
- Evidence: `claimIssuance()` returned existing `pending` rows as publishable work and `issueLatestDailyAirdrop()` marked all caught errors as `failed`, including failures that could happen after `submitSignedPftTransaction()` was attempted.
- Fix status: fixed in this commit.
- Tests needed: passed local Docker `DATABASE_URL=postgres://tasknodeofficial:tasknodeofficial@localhost:5436/tasknodeofficial TASKNODE_DATABASE_ENABLED=true npm run profile-daily-airdrop-issuance-smoke`, idempotent `node server/db/migrate.js`, `npm run profile-daily-airdrop-worker-smoke`, `npm run quality`, and `git diff --check`.

#### P2: GitHub provider note still referenced PFTasks continuity

- Files: `server/auth-connected-accounts.js`
- Boundary: auth | product copy | public readiness
- What breaks: the GitHub provider note described the login as "legacy PFTasks account continuity" even though this repo and product surface are Task Node Official.
- Why it matters: not a security or state bug, but stale product copy undermines the repo boundary and the user's explicit requirement that this app not present itself as PFTasks.
- Evidence: `oauthAuthProviders()` returned the stale note for the enabled GitHub provider.
- Fix status: fixed in this commit.
- Tests needed: passed `npm run auth-login-state-fixture`, `npm run runtime-smoke`, `npm run route-smoke`, and `git diff --check`.

#### P1: Fly dev data bridge push could overwrite Fly dev data without confirmation

- Files: `scripts/fly-dev-data-bridge.mjs`, `docs/DOCKER_DEV.md`, `docs/DEPLOYMENT.md`, `docs/wiki/architecture/deployment.md`
- Boundary: deployment | persistence | operator workflow
- What breaks: `npm run fly-dev:data:push` truncates reloadable Fly dev Postgres tables and restores local Docker data into Fly dev. Before this patch it did not require an explicit destructive-operation confirmation before starting the Fly proxy and touching databases.
- Why it matters: even though this is a dev deployment, Fly dev is currently the shared source of truth for local/Fly QA. An accidental push can wipe or replace current chats, memory, tasks, Hive, profile, billing, and PFTL cache rows.
- Evidence: `push()` immediately started the Fly proxy, dumped local data, called `truncateReloadableTables(flyDb)`, and restored local data with no confirmation gate.
- Fix status: fixed in this commit.
- Tests needed: direct guard checks passed: unconfirmed `node scripts/fly-dev-data-bridge.mjs push` exits before proxy/database work, and `TASKNODE_ALLOW_FLY_DEV_DATA_PUSH=true TASKNODE_FLY_APP=not-tasknodeofficial-dev node scripts/fly-dev-data-bridge.mjs push` is refused.

#### P2: Task generation taxonomy still allowed implementation categories

- Files: `server/task-generation-worker.js`, `prompts/task_engine/taskgen_minimal_v1.md`, `prompts/task_engine/block_contract_v1.md`, `prompts/task_engine/taskgen_repair_v1.md`, `scripts/task-lifecycle-smoke.mjs`
- Boundary: task generation | prompt contract | UI taxonomy
- What breaks: Tasks docs and UX now treat task type as `Personal`, `Network`, or `Alpha`, but the task-generation prompt and structured schema still allowed `engineering` and `system`. Those values could persist into generated payload metadata and downstream task/profile summaries even when the visible list normalized them.
- Why it matters: not a canonical-state corruption bug, but it reintroduces confusing implementation categories into user-facing and downstream LLM context.
- Evidence: `taskgen_minimal_v1.md` listed `system` and `engineering`; `taskgenResponseFormat` accepted any string for `task_kind`.
- Fix status: fixed in commit `9272ac6`.
- Tests needed: passed `npm run task-lifecycle-smoke`.

#### P1: URL evidence review worker could fetch private network targets

- Files: `server/task-review-worker.js`, `scripts/task-lifecycle-smoke.mjs`, `docs/wiki/surfaces/tasks.md`
- Boundary: task evidence | provider/review worker | network security
- What breaks: URL evidence was fetched server-side by the review worker without checking the scheme, credentials, localhost/private IP ranges, cloud metadata IPs, DNS resolution, or redirects.
- Why it matters: A user-controlled evidence URL could make the server request internal services or metadata endpoints during task review.
- Evidence: `processedEvidenceFromPayload()` passed URL evidence directly to `fetchUrlExcerpt()`, which called `fetch(value)` with the default redirect behavior.
- Fix status: fixed in commit `9272ac6`.
- Tests needed: passed `npm run task-lifecycle-smoke` literal URL safety assertions.

#### P1: Board Manager `message_user` could target an account outside its source packet

- Files: `server/board-manager-actions.js`, `scripts/board-manager-action-hooks-smoke.mjs`, `docs/wiki/surfaces/hive.md`
- Boundary: Hive | agent action hooks | account/message routing
- What breaks: For `target_type: "account"`, `message_user` used the model-supplied `target_id` as an account id and would create/use that account's Hive chat even if the account was not present in the live Board Manager source packet.
- Why it matters: Action hooks are the trust boundary between model output and app mutation. A malformed or prompt-injected decision should not be able to address arbitrary accounts.
- Evidence: `resolveMessageTarget()` validated `hive_context_entry` targets against the packet, but accepted arbitrary account targets.
- Fix status: fixed in commit `9272ac6`.
- Tests needed: passed local Docker `DATABASE_URL=postgres://tasknodeofficial:tasknodeofficial@localhost:5436/tasknodeofficial TASKNODE_DATABASE_ENABLED=true npm run board-manager-action-hooks-smoke`.

#### P1: Board Manager `assign_contributor` could assign a wallet outside its source packet

- Files: `server/board-manager-actions.js`, `scripts/board-manager-action-hooks-smoke.mjs`, `docs/wiki/surfaces/hive.md`
- Boundary: Hive | agent action hooks | contributor/project routing
- What breaks: `assign_contributor` accepted the model-supplied `wallet_address` and `account_id` after checking only that the project existed. A malformed model decision could add an arbitrary wallet as a project contributor even if that wallet was not part of the current Hive Context, source-packet candidate list, or eligible Network Task routing set.
- Why it matters: contributor assignment changes the visible Hive board and the routing context for future Network Task work. Action hooks must constrain model mutations to the actual state packet the agent was authorized to inspect.
- Evidence: `executeAssignContributor()` read `decision.payload.contributor.wallet_address`, checked `network_projects`, then inserted into `network_project_contributors` without validating the wallet against `sourcePacket`.
- Fix status: fixed in this review patch.
- Tests needed: passed local Docker `DATABASE_URL=postgres://tasknodeofficial:tasknodeofficial@localhost:5436/tasknodeofficial TASKNODE_DATABASE_ENABLED=true npm run board-manager-action-hooks-smoke`, `npm run quality`, and `git diff --check`.

#### P1: Board Manager secretary compression stripped action-hook target state

- Files: `server/board-manager-secretary-packets.js`, `server/board-manager-actions.js`, `scripts/board-manager-secretary-packet-smoke.mjs`, `scripts/board-manager-action-hooks-smoke.mjs`, `docs/wiki/surfaces/hive.md`
- Boundary: Hive | agent action hooks | packet compression | account/message routing
- What breaks: the normal Board Manager model path uses a DeepSeek secretary packet before the downstream decision model. That compressed packet did not include the Hive Context entry IDs, source conversation IDs, validated wallets, or eligible contributor wallets that `message_user` and `assign_contributor` need for source-packet validation. Valid model actions could therefore fail after model selection even though the raw source packet had the needed state.
- Why it matters: this is a production-path reliability bug for the Hive agent. The agent can decide to respond or assign a contributor, but execution fails because compression dropped the allowed target registry. It also creates pressure to bypass validation, which would be the wrong fix.
- Evidence: `buildBoardManagerSecretaryDecisionPacket()` returned only secretary summary state. `executeBoardManagerDecision()` receives that compressed packet in the default secretary path, while `resolveMessageTarget()` and `sourceContributorCandidates()` looked only at `hiveContext` and `networkTaskCandidates`.
- Fix status: fixed in this review patch.
- Tests needed: passed `npm run board-manager-secretary-packet-smoke`, local Docker `DATABASE_URL=postgres://tasknodeofficial:tasknodeofficial@localhost:5436/tasknodeofficial TASKNODE_DATABASE_ENABLED=true npm run board-manager-action-hooks-smoke`, `npm run quality`, and `git diff --check`.

#### P1: Hive project board could show stale Network Task state until reload

- Files: `src/features/hive/HiveView.jsx`, `docs/wiki/surfaces/hive.md`
- Boundary: Hive | UI state | task projection
- What breaks: `HiveView` loaded `/api/hive/projects` only once when the route mounted. If a project-linked Network Task changed state after the page loaded, the project detail task rows, routing feed, and contributor/task counts could remain stale until the user manually reloaded the app.
- Why it matters: Hive is the coordination surface for Network Tasks. Showing a task as proposed/accepted after the task projection has advanced to submitted/rewarded is a user-visible state mismatch and undermines trust in the board.
- Evidence: the only `/api/hive/projects` call lived in a one-shot `useEffect(..., [])`; the existing polling loop refreshed only `/api/hive/context`.
- Fix status: fixed in this review patch.
- Tests needed: passed `npm run quality`, `npm run build`, and `git diff --check`. Manual browser check still needed with a live project-linked task transition.

### Code Changes Made

For every code change, add:

- Commit:
- Files changed:
- Why changed:
- Risk:
- Tests already run:
- Tests still needed manually:

- Commit: `a53f9a1`
- Files changed: `server/index.js`, `server/route-policies.js`, `server/app-state.js`, `server/runtime-store.js`, `server/repositories/chat-billing.js`, `scripts/smoke.mjs`, `scripts/security-smoke.mjs`, `docs/CURRENT_SYSTEM.md`
- Why changed: close the signed-out/no-scope usage ledger leakage class and document that ledger reads are account-scoped session reads.
- Risk: low to moderate. Signed-out ledger calls now return `401`; the app should rely on signed-out app state for zero balance and signed-in ledger for detailed rows.
- Tests already run: direct runtime proof after patch confirmed scoped ledger still returns one row and unscoped ledger returns zero rows; `npm run security-smoke`; `npm run runtime-smoke`; `npm run quality`; `DATABASE_URL=postgres://tasknodeofficial:tasknodeofficial@localhost:5436/tasknodeofficial TASKNODE_DATABASE_ENABLED=true npm run db:chat-billing-smoke`; `npm run route-smoke`; `npm run smoke`; `git diff --check`.
- Tests still needed manually: browser billing page spot-check if this moves through a PR, because detailed ledger visibility is UI-only after login.

- Commit: this commit
- Files changed: `server/task-review-worker.js`, `scripts/network-task-recovery-smoke.mjs`, `docs/wiki/surfaces/tasks.md`, `docs/wiki/architecture/network-task-recovery.md`
- Why changed: prevent duplicate verification-request publications and duplicate reward scoring/payment when PFTL publication succeeds but projection lags.
- Risk: moderate. If a publication succeeds but projection never catches up, the task will wait for cache/reducer repair instead of republishing. That is the correct failure mode for money and on-chain state.
- Tests already run: `npm run quality`; `DATABASE_URL=postgres://tasknodeofficial:tasknodeofficial@localhost:5436/tasknodeofficial TASKNODE_DATABASE_ENABLED=true npm run network-task-recovery-smoke`; `git diff --check`.
- Tests still needed manually: inspect any active `submitted` or `verification_response_submitted` tasks with `metadata_json.workers.*.published=true` and confirm the board/task UI shows indexing lag instead of creating another update/payment.

- Commit: this commit
- Files changed: `server/repositories/board-manager-scheduler.js`, `scripts/board-manager-scheduler-smoke.mjs`, `docs/wiki/surfaces/hive.md`
- Why changed: make Board Manager pause/disable state durable across worker restarts.
- Risk: low. Existing callers that need to enable the scope must pass `status: "enabled"` explicitly; worker startup only ensures the row and updates cadence/budget.
- Tests already run: `DATABASE_URL=postgres://tasknodeofficial:tasknodeofficial@localhost:5436/tasknodeofficial TASKNODE_DATABASE_ENABLED=true npm run board-manager-scheduler-smoke`; `npm run quality`; `git diff --check`.
- Tests still needed manually: pause the live `global_hive` scope, restart the board-manager container, and confirm it remains paused.

- Commit: this commit
- Files changed: `server/profile-daily-airdrop-issuance.js`, `server/repositories/profile-daily-airdrop.js`, `server/db/migrate.js`, `server/db/migrations/045_profile_daily_airdrop_processing_status.sql`, `scripts/profile-daily-airdrop-issuance-smoke.mjs`, `package.json`, `docs/wiki/surfaces/daily-airdrop.md`, `docs/wiki/surfaces/profile.md`
- Why changed: prevent duplicate daily airdrop payment attempts by claiming issuance rows as `processing` before signing and keeping post-submit uncertainty non-retryable.
- Risk: moderate. A submission timeout after signing now leaves the row in `processing` for reconciliation/operator review instead of immediate retry. That can delay a payout, but it is the correct money-safe failure mode.
- Tests already run: `DATABASE_URL=postgres://tasknodeofficial:tasknodeofficial@localhost:5436/tasknodeofficial TASKNODE_DATABASE_ENABLED=true npm run profile-daily-airdrop-issuance-smoke`; idempotent `DATABASE_URL=postgres://tasknodeofficial:tasknodeofficial@localhost:5436/tasknodeofficial TASKNODE_DATABASE_ENABLED=true node server/db/migrate.js`; `npm run profile-daily-airdrop-worker-smoke`; `npm run quality`; `git diff --check`.
- Tests still needed manually: inspect any live `profile_daily_airdrop_issuances.status = 'processing'` rows before retrying payout; reconcile against PFTL/cache by source wallet, destination wallet, amount, pointer CID, payload digest, and tx hash where available.

- Commit: this commit
- Files changed: `server/auth-connected-accounts.js`
- Why changed: remove stale PFTasks product wording from the enabled GitHub provider note.
- Risk: low. Product copy only.
- Tests already run: `npm run auth-login-state-fixture`; `npm run runtime-smoke`; `npm run route-smoke`; `git diff --check`.
- Tests still needed manually: none.

- Commit: this commit
- Files changed: `scripts/fly-dev-data-bridge.mjs`, `docs/DOCKER_DEV.md`, `docs/DEPLOYMENT.md`, `docs/wiki/architecture/deployment.md`
- Why changed: prevent accidental destructive replacement of Fly dev data from local Docker.
- Risk: low to moderate. Operators now need one explicit confirmation when intentionally pushing local data to Fly dev.
- Tests already run: direct guard commands for missing confirmation and wrong app target; `npm run route-smoke`.
- Tests still needed manually: an intentional `fly-dev:data:push` dry operator rehearsal with a disposable Fly dev backup, using `--confirm-dev-push`, before relying on the push command for real recovery.

- Commit: `9272ac6`
- Files changed: `server/task-generation-worker.js`, `prompts/task_engine/taskgen_minimal_v1.md`, `prompts/task_engine/block_contract_v1.md`, `prompts/task_engine/taskgen_repair_v1.md`, `scripts/task-lifecycle-smoke.mjs`
- Why changed: align future generated task payloads with the product taxonomy of `personal`, `network`, or `alpha` instead of leaking implementation categories such as `engineering`.
- Risk: low. Existing tasks are not rewritten; future malformed or legacy `engineering` output normalizes to `personal` unless a network/alpha policy is present.
- Tests already run: `npm run task-lifecycle-smoke`.
- Tests still needed manually: request one personal task and one Network Task in the running app before declaring the full generation path verified.

- Commit: `9272ac6`
- Files changed: `server/task-review-worker.js`, `scripts/task-lifecycle-smoke.mjs`, `docs/wiki/surfaces/tasks.md`
- Why changed: fail closed on URL evidence extraction before the review worker can fetch localhost, private IP ranges, metadata addresses, credentialed URLs, unsafe schemes, DNS names resolving to private addresses, or redirects.
- Risk: moderate. Some public evidence URLs that only work through redirects may no longer be auto-extracted; the user can still submit text, screenshots, files, or a direct public URL.
- Tests already run: `npm run task-lifecycle-smoke`.
- Tests still needed manually: submit one public URL evidence task and one blocked local/private URL in local Docker to confirm user-facing review behavior and forensics wording are clear.

- Commit: `9272ac6`
- Files changed: `server/board-manager-actions.js`, `scripts/board-manager-action-hooks-smoke.mjs`, `docs/wiki/surfaces/hive.md`
- Why changed: constrain Board Manager chat replies to source-packet accounts or concrete Hive Context entries, instead of trusting a model-supplied arbitrary account id.
- Risk: low. Valid Hive Context replies and source-packet candidate/account replies still work; invented account targets now fail and are recorded as failed action results.
- Tests already run: `DATABASE_URL=postgres://tasknodeofficial:tasknodeofficial@localhost:5436/tasknodeofficial TASKNODE_DATABASE_ENABLED=true npm run board-manager-action-hooks-smoke`; `npm run quality`; `git diff --check`.
- Tests still needed manually: send a Hive Chat message, run one Board Manager turn, and confirm any reply lands in that same Hive Chat thread.

- Commit: this review patch
- Files changed: `server/board-manager-actions.js`, `scripts/board-manager-action-hooks-smoke.mjs`, `docs/wiki/surfaces/hive.md`
- Why changed: constrain Board Manager contributor assignments to wallets present in the current source packet as validated Hive Context wallets or eligible Network Task candidates.
- Risk: low. Legitimate assignments from current source context still work; invented contributor wallets now fail and are recorded as failed action results.
- Tests already run: `DATABASE_URL=postgres://tasknodeofficial:tasknodeofficial@localhost:5436/tasknodeofficial TASKNODE_DATABASE_ENABLED=true npm run board-manager-action-hooks-smoke`.
- Tests still needed manually: run one Board Manager turn that assigns a real eligible contributor to a real active project and confirm the Hive project contributor list updates without introducing unrelated accounts.

- Commit: this review patch
- Files changed: `server/board-manager-secretary-packets.js`, `server/board-manager-actions.js`, `scripts/board-manager-secretary-packet-smoke.mjs`, `scripts/board-manager-action-hooks-smoke.mjs`, `docs/wiki/surfaces/hive.md`
- Why changed: preserve a minimal action-target registry through DeepSeek secretary packet compression so `message_user` and `assign_contributor` can execute in the normal compressed-packet path without accepting arbitrary model-supplied targets.
- Risk: low to moderate. The compressed packet is slightly larger and exposes only routing IDs/conversation IDs/wallets needed for action validation, not the full raw packet. The benefit is that production secretary mode and uncompressed mode share the same hook boundary.
- Tests already run: `npm run board-manager-secretary-packet-smoke`; `DATABASE_URL=postgres://tasknodeofficial:tasknodeofficial@localhost:5436/tasknodeofficial TASKNODE_DATABASE_ENABLED=true npm run board-manager-action-hooks-smoke`; `npm run quality`; `git diff --check`.
- Tests still needed manually: run one secretary-enabled Board Manager turn that sends a Hive Chat response and confirm the message lands in the originating Hive Chat conversation.

- Commit: this review patch
- Files changed: `src/features/hive/HiveView.jsx`, `docs/wiki/surfaces/hive.md`
- Why changed: keep the Hive project board synchronized with server-side project/task projections while the route is open.
- Risk: low. The route now polls `/api/hive/projects` every 10 seconds without resetting the loading state; this adds a small read load while Hive is mounted.
- Tests already run: `npm run quality`; `npm run build`; `git diff --check`.
- Tests still needed manually: open Hive on a project-linked Network Task, move the task through a state transition, and confirm the project row updates without a browser reload.

### Testing List For The Integration Owner

If you changed code, list functionality that must be tested before accepting the branch.

- [ ] Signed-out billing boundaries:
  - Why: patched a P1 account data exposure in no-scope ledger reads.
  - How: call `/api/app-state` signed out and `/api/usage/ledger` signed out; then call `/api/usage/ledger` with a signed-in session.
  - Expected result: signed-out app state has zero usage totals; signed-out ledger is `401 usage_ledger_login_required`; signed-in ledger returns only the caller account's rows.
- [ ] Task review duplicate-publish boundary:
  - Why: patched a P0 path that could republish reward scoring/payment after projection lag.
  - How: use the recovery smoke output and inspect a task whose worker metadata says `published=true`.
  - Expected result: recovery says `will_publish=false`; worker does not issue another verification request or reward payment for that worker.
- [ ] Board Manager pause durability:
  - Why: patched worker startup so it cannot silently re-enable a paused/disabled Board Manager scope.
  - How: set `board_manager_scopes.status = 'paused'`, restart the board-manager worker, and read scheduler status.
  - Expected result: status remains `paused` until an explicit operator command sets it back to `enabled`.
- [ ] Auth connected-account smoke:
  - Why: reviewed as a high-risk account merge/link boundary.
  - How: run `npm run auth-login-state-fixture` after any auth/provider changes.
  - Expected result: fixture ends with `auth_login_state_fixture_passed transitions=13`.
- [ ] Daily airdrop no-double-pay boundary:
  - Why: patched a P0 payment retry risk in live daily airdrop issuance.
  - How: run `DATABASE_URL=postgres://tasknodeofficial:tasknodeofficial@localhost:5436/tasknodeofficial TASKNODE_DATABASE_ENABLED=true npm run profile-daily-airdrop-issuance-smoke`.
  - Expected result: first claim moves to `processing`, second claim rejects with `daily_airdrop_issuance_in_progress`, post-submit failure remains non-retryable, pre-submit failure can be reclaimed, and submitted replay returns `alreadySubmitted`.
- [ ] Fly dev bridge push guard:
  - Why: patched a P1 destructive data-bridge workflow.
  - How: run `node scripts/fly-dev-data-bridge.mjs push` without confirmation and with `TASKNODE_ALLOW_FLY_DEV_DATA_PUSH=true TASKNODE_FLY_APP=not-tasknodeofficial-dev`.
  - Expected result: both commands fail before any Fly proxy or database mutation.
- [ ] Task generation taxonomy:
  - Why: patched prompt/schema validation so future generated tasks stay in the `personal` / `network` / `alpha` taxonomy.
  - How: run `npm run task-lifecycle-smoke`, then manually request one personal task and one Network Task in the app.
  - Expected result: generated task metadata uses `personal` for user-requested work and `network` or `alpha` only when that routing context is present.
- [ ] URL evidence safety:
  - Why: patched server-side evidence extraction to avoid SSRF-style private network fetches.
  - How: submit URL evidence using a direct public URL, then test a localhost/private URL in a non-production account.
  - Expected result: public URL extraction works or reports a normal public fetch error; localhost/private/metadata URLs produce a blocked extraction artifact and do not get fetched.
- [ ] Board Manager message recipient boundary:
  - Why: patched `message_user` to reject account targets not present in the current source packet.
  - How: run the action-hook smoke and manually send one Hive Chat input followed by a Board Manager turn.
  - Expected result: the smoke records the rejected invented-account action, and the manual reply appears only in the source user's Hive Chat.
- [ ] Board Manager contributor assignment boundary:
  - Why: patched `assign_contributor` to reject wallets that are not present in the Board Manager source packet.
  - How: run the action-hook smoke and manually allow one Board Manager run to assign a real eligible contributor to a project.
  - Expected result: the smoke records the rejected invented-wallet action, and the manual assignment only adds a contributor from validated Hive Context or eligible Network Task candidates.
- [ ] Board Manager secretary compressed-packet action path:
  - Why: patched compressed secretary packets to preserve minimal action-target state for hooks.
  - How: run one secretary-enabled Board Manager turn with `--execute` that chooses `message_user` or `assign_contributor`.
  - Expected result: the action validates against the compressed packet's action-target registry and executes without bypassing the source-packet boundary.
- [ ] Hive project board refresh:
  - Why: patched one-shot Hive project loading so Network Task state changes are reflected while the page is open.
  - How: keep `#hive` open on a project detail, move a project-linked task through a task lifecycle transition, and wait for the next project refresh.
  - Expected result: the task row, project counts, and routing feed reflect the server state without a full reload.

### Dependency And Supply-Chain Risks

Record:

- dependency name
- where used
- risk
- whether it is deploy-blocking
- suggested action

### Docs Parity Gaps

Record behavior that exists in code but is missing or stale in docs:

- code path:
- missing/stale doc:
- suggested docs location:

### Residual Risk

Before stopping, write what you did not finish. Do not imply full coverage if it did not happen.

- Not reviewed: full every-file pass is not complete. Remaining broad areas include complete migration review, remaining frontend feature modules outside Hive/Tasks/Chat/Profile samples, every script, every prompt, and every docs page.
- Reviewed lightly: route-policy consistency scan, Hive frontend, Board Manager secretary/action path, startup/background worker boundaries, profile/airdrop samples, auth/deposit samples, chat/context samples, task worker samples.
- Needs deeper follow-up: full database migration idempotency audit; full docs parity audit; full frontend visual pass in browser; production/Fly process-group smoke; manual Board Manager secretary-enabled action run; manual Hive project state transition refresh test.
- Reasons: the review is being run incrementally while fixing concrete P0/P1 issues as found. Current commits fix the highest-risk reachable issues discovered so far, but this file should not be treated as a claim that all 535 tracked files have been exhaustively reviewed.

## Minimum Handoff Standard

At the end of the overnight run, provide:

1. Branch name and latest commit.
2. Whether every tracked file was covered.
3. Top findings by severity.
4. Fixes made.
5. Tests run.
6. Tests still required.
7. Docs updated or docs gaps.
8. Residual risk list.

If you only completed part of the repo, say exactly which part. This review is valuable only if the remaining unknowns are visible.
