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

- `[time]` Started review:
- `[time]` Completed ramp:
- `[time]` Completed file inventory:
- `[time]` First P0/P1 finding:
- `[time]` First patch:
- `[time]` Final handoff:

### File Coverage Ledger

Keep a coverage ledger by directory. Add counts or notes as you complete each section.

- [ ] root config files reviewed
- [ ] `.github/**` reviewed
- [ ] `server/**` reviewed
- [ ] `server/repositories/**` reviewed
- [ ] `server/db/migrations/**` reviewed
- [ ] `src/**` reviewed
- [ ] `shared/**` reviewed
- [ ] `scripts/**` reviewed
- [ ] `prompts/**` reviewed
- [ ] `schemas/**` reviewed
- [ ] `docs/**` reviewed

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

### Code Changes Made

For every code change, add:

- Commit:
- Files changed:
- Why changed:
- Risk:
- Tests already run:
- Tests still needed manually:

### Testing List For The Integration Owner

If you changed code, list functionality that must be tested before accepting the branch.

- [ ] Item:
  - Why:
  - How:
  - Expected result:

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

- Not reviewed:
- Reviewed lightly:
- Needs deeper follow-up:
- Reasons:

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
