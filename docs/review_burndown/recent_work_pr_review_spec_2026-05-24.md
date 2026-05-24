# Recent Work PR Review Spec

Date: 2026-05-24
Owner: second-eyes review agent
Repo: `/home/pfrpc/repos/tasknodeofficial`

## Purpose

Task Node Official moved quickly across auth, Fly deployment, Docker/Fly data
sharing, Hive, Board Manager, network tasks, profile, airdrops, task evidence,
and docs. This spec breaks the review into small PRs so a subagent can review
and patch one boundary at a time without trampling active work.

The goal is not an omnibus rewrite. The goal is to find concrete bugs, produce
small review branches, and merge them one by one.

## Required Operating Contract

- Use the `tasknodeofficial` skill. Do not use the old PFTasks tasknode skill.
- Start every review from a clean worktree based on current `origin/main`.
- Branch name format: `review/<number>-<boundary>`.
- Keep each PR focused on one boundary. Do not combine auth, Hive, tasks, and
  profile in the same branch.
- Prefer review-only findings unless the fix is small, local, and clearly
  correct.
- Do not delete migrations, prompts, mocks, or docs to resolve conflicts.
- Do not hard-code examples, task IDs, wallet addresses, prompt fragments, or
  regex product behavior. Fix the underlying routing, state, persistence, auth,
  or provider boundary.
- Do not retarget Task Node Official to PFTasks data, PFTasks bots, or PFTasks
  services.
- Do not print secrets. Redact tokens, seeds, database passwords, and provider
  keys in all evidence.
- Every finding must include a file/line reference, severity, user impact, and a
  verification path.
- Every PR must end with `git diff --check` and at least one targeted smoke or
  route check.

## Mandatory Worktree Hygiene

The live checkout at `/home/pfrpc/repos/tasknodeofficial` is the integration
checkout. Review agents must not do exploratory work directly in that checkout.

Before starting a PR:

```bash
cd /home/pfrpc/repos/tasknodeofficial
git fetch origin main
git status --short --branch
git rev-list --left-right --count origin/main...HEAD
```

If the integration checkout is dirty, stop and ask for a checkpoint. Do not
stash or reset the integration checkout.

Create review worktrees under `/home/pfrpc/repos/worktrees/tasknodeofficial/`:

```bash
mkdir -p /home/pfrpc/repos/worktrees/tasknodeofficial
git worktree add \
  -b review/01-auth-connected-accounts \
  /home/pfrpc/repos/worktrees/tasknodeofficial/01-auth-connected-accounts \
  origin/main
cd /home/pfrpc/repos/worktrees/tasknodeofficial/01-auth-connected-accounts
```

During the review:

- Run `git status --short --branch` before editing.
- Keep all edits inside the review worktree.
- Use one branch per PR row in this spec.
- Commit the review result on that branch before handing it back.
- Do not open a second review branch from an older review branch. Always start
  from current `origin/main`.

Before handoff:

```bash
git fetch origin main
git rebase origin/main
git diff --check origin/main...HEAD
git status --short --branch
```

Then run the PR-specific checks listed below. If a rebase conflicts, stop and
report the exact conflicted files. Do not resolve by deleting other agents'
work.

## Review Cadence

Open and merge one PR at a time in this order unless a P0 blocks deployment:

1. Auth and connected accounts.
2. Deployment, Docker/Fly data bridge, and config safety.
3. Board Manager worker, leases, actions, and run audit.
4. Hive surface, Hive Chat, context, projects, routing feed.
5. Network task lifecycle, recovery, reward follow-up, and projections.
6. Task detail, evidence, copy, unlock, and verification UX.
7. Profile, daily airdrop, NFT, and public profile data.
8. Chat, context refine, Jobs prompt, pgvector, and memory packet boundaries.
9. Database, migrations, ownership constraints, and repository consistency.
10. Docs, prompts, public-readiness, and dead/legacy code.

If a PR discovers a bug outside its boundary, record it in the PR notes and add
it to the relevant later PR. Do not expand the active PR unless it is a P0.

## PR-01: Auth And Connected Accounts

Suggested branch: `review/01-auth-connected-accounts`

Files and surfaces:

- `server/auth-connected-accounts.js`
- `server/index.js`
- `server/product-contracts.js`
- `server/route-policies.js`
- `server/runtime-store.js`
- `src/main.jsx` connected account UI
- `scripts/auth-login-state-fixture.mjs`
- `docs/wiki/architecture/auth-and-connected-accounts.md`
- `docs/DEPLOYMENT.md`

Review questions:

- Does every auth start/callback route have the correct session or OAuth-state
  policy?
- Does Telegram use the exact configured bot username, token, and BotFather
  domain without accepting mismatched hostnames?
- Does Telegram reject invalid signatures, expired payloads, stale OAuth state,
  and missing state?
- Does Discord link into the current account when a session exists instead of
  creating a second account cloud?
- Does email login/linking avoid account takeover through reused or expired
  tokens?
- Does provider readiness match reality in `/api/auth/providers`?
- Are token, seed, and OAuth secret values absent from logs, errors, docs, and
  smoke output?
- Does the Settings UI distinguish sign-in from account-link behavior clearly?

Required checks:

```bash
npm run quality
node scripts/auth-login-state-fixture.mjs
npm run security-smoke
curl -sS https://tasknodeofficial-dev.fly.dev/api/auth/providers
```

Manual evidence:

- Browser test on `https://tasknodeofficial-dev.fly.dev/settings` for Telegram
  authorize page after BotFather domain is set.
- Redacted screenshot or log excerpt proving Telegram widget loads the current
  Task Node bot, not an old PFTasks bot.

Done criteria:

- Findings are documented.
- Any P0/P1 is fixed or explicitly blocked with the exact missing external
  setup.
- No provider can link to the wrong account or silently create a duplicate
  identity cloud.

## PR-02: Deployment, Docker/Fly Data Bridge, And Config Safety

Suggested branch: `review/02-deploy-docker-fly-data`

Files and surfaces:

- `fly.toml`
- `docker-compose.dev.yml`
- `docker-compose.fly-data.yml`
- `scripts/fly-dev-data-bridge.mjs`
- `server/db/pool.js`
- `server/db/migrate.js`
- `docs/DEPLOYMENT.md`
- `docs/DOCKER_DEV.md`

Review questions:

- Does local Docker use the Fly dev Postgres bridge only when explicitly
  requested?
- Does the bridge target the Task Node Official database only, never PFTasks?
- Are generated env files gitignored and free of accidental committed secrets?
- Does host networking in the compose override behave correctly on this machine?
- Does the app fail closed when the Fly proxy is unavailable?
- Are app, worker, and board-manager process roles separated cleanly?
- Are migrations idempotent and safe to run in Docker and Fly?
- Does documentation explain that browser wallet vaults remain origin-local?

Required checks:

```bash
npm run fly-dev:data:status
npm run route-smoke
npm run security-smoke
git diff --check
```

Manual evidence:

- `http://localhost:8080/health` while Docker is pointed at Fly dev data.
- Matching row counts for Docker and Fly dev on a small set of tables.

Done criteria:

- The review proves local Docker can safely test against Fly dev data without
  pretending browser vaults or Telegram localhost auth are shared.
- No secret-bearing generated file is tracked.

## PR-03: Board Manager Worker, Leases, Actions, And Audit

Suggested branch: `review/03-board-manager-worker`

Files and surfaces:

- `server/background-workers.js`
- `server/board-manager-actions.js`
- `server/repositories/board-manager.js`
- `server/repositories/board-manager-health.js`
- `server/repositories/board-manager-run-summary.js`
- `server/repositories/board-manager-scheduler.js`
- `scripts/board-manager-worker.mjs`
- `scripts/board-manager-*-smoke.mjs`
- `prompts/hive/board_manager_v1.md`
- `prompts/hive/board_manager_secretary_v1.md`
- `docs/wiki/plans/board-manager.md`

Review questions:

- Is only one manager allowed to mutate the same board scope at a time?
- Do job claims, leases, and action budgets prevent duplicate project/task/user
  messages?
- Does every run produce an auditable reason, confidence, input digest, action
  result, and micro-summary?
- Does a no-action run explain why no action was chosen and what would change
  that decision?
- Does the manager have a bias toward useful movement on empty projects while
  avoiding duplicate or impossible work?
- Are action hooks validated before they mutate state?
- Are model/provider failures recorded in the run feed instead of disappearing?
- Are Qwen/OpenRouter and DeepSeek secretary packets bounded by useful
  summaries rather than arbitrary truncation?

Required checks:

```bash
npm run board-manager-scheduler-smoke
node scripts/board-manager-action-hooks-smoke.mjs
node scripts/board-manager-v0-smoke.mjs
node scripts/board-manager-message-delivery-repair.mjs
git diff --check
```

Manual evidence:

- Hive Mind Agent feed showing one run with a decision reason and one action
  result.
- Postgres query or route output showing claimed job state and run summary row.

Done criteria:

- The review can explain whether two board-manager machines can run without
  double-mutating the board.
- The UX has enough audit detail to understand why the agent acted or did not
  act.

## PR-04: Hive Surface, Hive Chat, Context, Projects, And Routing Feed

Suggested branch: `review/04-hive-surface-routing`

Files and surfaces:

- `server/hive-routes.js`
- `server/app-state.js`
- `server/repositories/board-manager.js`
- `server/repositories/chat-conversations.js`
- `src/features/hive/HiveView.jsx`
- `src/features/chat/ChatMessages.jsx`
- `src/main.jsx`
- `src/styles.css`
- `docs/wiki/surfaces/hive.md`
- `docs/wiki/plans/making-functional-network-tasks.md`

Review questions:

- Does every user have one default Hive Chat instead of fragmented Hive Input
  modal chats?
- Do Hive acknowledgments render as system status, not normal user/agent
  content?
- Can the Board Manager message a user back into the correct Hive Chat?
- Do failed message deliveries surface in the Hive Mind Agent feed with a real
  cause?
- Are Hive Context raw inputs collapsible and grouped by contributor without
  leaking unrelated users?
- Do project cards show real project IDs, concise descriptions, contributors,
  tasks, and routing events?
- Is the routing feed ordered newest first and visually calm?
- Do project Product Documents render as expandable status sections rather than
  giant always-open blobs?

Required checks:

```bash
npm run build
npm run route-smoke
node scripts/hive-project-planning-smoke.mjs
git diff --check
```

Manual evidence:

- Screenshot of Hive page with Hive Context, Hive Mind Agent feed, one project
  card, and routing feed.
- Screenshot of Hive Chat receiving a Board Manager response.

Done criteria:

- Hive no longer relies on a hidden or confusing message area for user/agent
  conversation.
- Project/task state shown in Hive agrees with task projection state.

## PR-05: Network Task Lifecycle, Recovery, Reward Follow-Up, And Projections

Suggested branch: `review/05-network-task-lifecycle`

Files and surfaces:

- `server/network-task-recovery.js`
- `scripts/network-task-recovery.mjs`
- `scripts/network-task-recovery-smoke.mjs`
- `scripts/network-task-reward-followup-smoke.mjs`
- `server/repositories/network-task-reward-followup.js`
- `server/repositories/tasks.js`
- `server/app-state.js`
- `server/task-*.js`
- `src/features/tasks/**`
- `docs/wiki/architecture/network-task-recovery.md`
- `docs/wiki/architecture/task-lifecycle.md`

Review questions:

- Can accepted, submitted, verification-requested, and reward-pending network
  tasks recover after process restart without duplicate transitions?
- Does recovery know the difference between allocation failure, refused task,
  rewarded zero PFT, and paid reward?
- Are task list and task detail backed by the same projection state?
- Does a reward event trigger Board Manager follow-up when needed without
  causing duplicate agent runs?
- Are lifecycle event IDs, CIDs, transactions, ledgers, and reward amounts
  visible in forensics?
- Do stale projections get repaired from the full task event set, not a
  wallet-scoped partial replay?
- Does Hive project task status update from the same projection as Tasks?

Required checks:

```bash
npm run network-task-lifecycle-fixture
node scripts/network-task-recovery-smoke.mjs
node scripts/network-task-reward-followup-smoke.mjs
npm run route-smoke
git diff --check
```

Manual evidence:

- One task detail page showing offered, accepted, submitted, review, and reward
  events.
- One Hive project card showing the same task in the same final state.

Done criteria:

- The review proves recovery is deterministic and cannot republish duplicate
  verification requests or reward scoring events.

## PR-06: Task Detail, Evidence, Copy, Unlock, And Verification UX

Suggested branch: `review/06-task-ux-evidence`

Files and surfaces:

- `src/main.jsx`
- `src/features/tasks/**`
- `src/styles.css`
- `server/product-contracts.js`
- `server/task-request.js`
- `docs/wiki/surfaces/tasks.md`
- `docs/wiki/architecture/style-guide.md`

Review questions:

- Does task detail open as a smooth workspace cover inside the Tasks surface
  instead of a mismatched detached page?
- Do status tabs, cards, and detail headers use the same state vocabulary?
- Does verification state foreground the current verification ask and keep
  original task details expandable?
- Does evidence submission add a second evidence block only when the user clicks
  Add evidence?
- Does the file picker match the app style and avoid browser-default ugly
  controls where possible?
- Does copy task brief copy the title, description, steps, verification
  requirement, task ID, request ID, reward, deadline, and requested output in a
  Codex-friendly format?
- Does the UI allow both accept and refuse when a task is proposed?
- Does wallet unlock avoid duplicate unlock buttons and route through a single
  deterministic modal?
- Are task kinds restricted to Product values: personal, network, alpha?

Required checks:

```bash
npm run build
npm run task-request-unlock-smoke
npm run chat-markdown-smoke
git diff --check
```

Manual evidence:

- Screenshots for proposed, accepted, verification requested, awaiting review,
  and rewarded task detail states.
- Screenshot after copy action showing the acknowledgment state.

Done criteria:

- The review can follow a user's next action from every task state without
  needing hidden knowledge of the protocol.

## PR-07: Profile, Daily Airdrop, NFT, And Public Profile Data

Suggested branch: `review/07-profile-airdrop-nft`

Files and surfaces:

- `server/profile-daily-airdrop-worker.js`
- `server/repositories/profile-daily-airdrop.js`
- `scripts/profile-daily-airdrop-worker.mjs`
- `scripts/profile-daily-airdrop-worker-smoke.mjs`
- `src/main.jsx` profile surfaces
- `src/styles.css`
- `prompts/profile/**`
- `docs/wiki/surfaces/profile.md`
- `docs/wiki/surfaces/daily-airdrop.md`
- `docs/wiki/plans/daily-airdrop-migration-plan.md`

Review questions:

- Is there exactly one daily airdrop per identity cloud per run date?
- Does the recipient wallet selection use the most active linked wallet by task
  count without double-paying linked identities?
- Is the airdrop amount actually paid before the UX says "The network paid you"?
- Is alignment calculated as captured trailing seven-day airdrop divided by max
  possible trailing seven-day airdrop?
- Are task rewards and daily drops separated but summed clearly in the profile
  charts?
- Does the Hive Mind Agent feed include a visible daily airdrop run card?
- Does the public profile omit vapor fields and use generated text from task
  proposal/reward summaries only?
- Does NFT generation keep prompts private, preserve image references, and make
  minted/generated gallery items render real images?

Required checks:

```bash
node scripts/profile-daily-airdrop-worker-smoke.mjs
npm run build
npm run route-smoke
git diff --check
```

Manual evidence:

- Private profile screenshot after a real or dry-run airdrop with tx status
  clearly labeled.
- Public profile screenshot showing generated ability summary, alignment score,
  NFT gallery image, and no Sybil score.

Done criteria:

- No profile field claims payment, generation, or minting unless a real backing
  row, transaction, or image exists.

## PR-08: Chat, Context Refine, Jobs Prompt, Pgvector, And Memory Packets

Suggested branch: `review/08-chat-context-memory`

Files and surfaces:

- `server/chat-router.js`
- `server/chat-memory.js`
- `server/repositories/chat-billing.js`
- `server/repositories/chat-conversations.js`
- `server/context-edit-chat.js`
- `src/features/chat/**`
- `src/features/context/**`
- `prompts/chat/**`
- `prompts/jobs/**`
- `docs/wiki/surfaces/chat.md`
- `docs/wiki/surfaces/context.md`
- `docs/wiki/surfaces/memory.md`
- `docs/wiki/plans/jobs-chat-spirit.md`
- `docs/wiki/plans/network-task-profile-memory-plan.md`

Review questions:

- Does chat load context document, memory, task awareness, and Jobs XML without
  one surface hard-coding a separate prompt copy?
- Does Jobs pgvector retrieval inject chunks when relevant and expose status in
  run metadata?
- Does markdown render ordered lists correctly in chat output?
- Does Context Refine live inside chat mode and persist accepted edits exactly
  once?
- Does navigating away clear accepted edit actions that are no longer valid?
- Does context history use cached readable previews instead of repeatedly
  showing "encrypted preview loading" for already-decrypted revisions?
- Does Network Task Profile memory combine live task inputs with the latest
  generated diagnostic report without bloated unknown-task spam?
- Do chat history ownership and signed-out behavior remain account-scoped?

Required checks:

```bash
npm run chat-markdown-smoke
node scripts/chat-context-status-smoke.mjs
npm run chat-attachment-smoke
npm run security-smoke
git diff --check
```

Manual evidence:

- Chat screenshot asking a Jobs-relevant question with retrieval status visible
  in metadata or logs.
- Context Refine screenshot showing proposal and accepted edit persisted after
  navigation.

Done criteria:

- Chat behavior is not split across four separate prompt implementations and no
  context/memory/task packet silently disappears.

## PR-09: Database, Migrations, Ownership Constraints, And Repository Consistency

Suggested branch: `review/09-database-repositories`

Files and surfaces:

- `server/db/migrations/*.sql`
- `server/db/pool.js`
- `server/db/migrate.js`
- `server/repositories/*.js`
- `docs/wiki/architecture/database.md`
- `docs/wiki/plans/data-architecture-hardening-plan.md`

Review questions:

- Are all new tables documented with owner surface, key columns, and app
  dependency?
- Do account-scoped reads filter by `account_id` or identity-cloud equivalent?
- Are project/task/agent rows idempotent where workers can retry?
- Are unique constraints sufficient to prevent duplicate daily drops, duplicate
  provider identities, duplicate agent actions, and duplicate task transitions?
- Are migrations ordered, idempotent, and compatible with existing Fly data?
- Do repositories avoid raw string SQL assembly for untrusted values?
- Does the database architecture document describe current reality, not removed
  legacy paths?

Required checks:

```bash
npm run quality
npm run route-smoke
npm run security-smoke
git diff --check
```

Manual evidence:

- `psql` table list or route output proving key new tables exist in Fly dev and
  Docker/Fly-data mode.
- One query proving provider identity uniqueness and daily airdrop uniqueness.

Done criteria:

- The review can explain where every major stateful feature is stored and which
  account/project/task boundary owns it.

## PR-10: Docs, Prompts, Public Readiness, And Legacy Cleanup

Suggested branch: `review/10-docs-prompts-public-readiness`

Files and surfaces:

- `docs/wiki/**`
- `docs/review_burndown/**`
- `src/features/docs/docs-content.js`
- `prompts/**`
- `RULES*` or prompt-policy docs if present
- root config files and gitignored env examples

Review questions:

- Are docs visible in Help for all newly shipped behavior: auth, Hive, Board
  Manager, daily airdrop, profile, network tasks, recovery, Docker/Fly data?
- Do prompts live in files loaded by the prompt registry rather than inline
  string blobs?
- Are prompt instructions clear, non-jargony, and free of user-specific
  hard-coding?
- Is public-readiness clean: no seeds, tokens, private URLs, private prompts, or
  accidental secret file paths committed?
- Are legacy PFTasks references clearly labeled historical or removed where they
  imply current behavior?
- Are deleted/disabled surfaces such as Brainstorming, Motivation, and Context
  Rewrite absent from active navigation if they are not meant to ship?
- Does the review burndown itself match the actual docs tree?

Required checks:

```bash
npm run quality
git diff --check
rg -n "sEd|TELEGRAM_AUTH_BOT_TOKEN|OPENAI_API_KEY|DEEPSEEK_API_KEY|RESEND_API_KEY|DATABASE_URL=.*://" .
```

Manual evidence:

- Help page screenshot showing the updated Code Review Burndown.
- Redacted scan output showing no committed secret values.

Done criteria:

- The repo can be made public without obvious secrets or misleading shipped
  claims.

## Per-PR Evidence Template

Each review PR should include this block in its final message:

```text
Review PR:
Boundary:
Branch:
Changed files:
Findings:
- P0:
- P1:
- P2:
Fixes included:
Checks run:
Manual app evidence:
Residual risks:
Merge recommendation:
```

## Current Known Hot Spots

- Telegram auth depends on BotFather `/setdomain` for
  `tasknodeofficial-dev.fly.dev`; local Docker cannot fully test the widget.
- Docker can be pointed at Fly dev Postgres through
  `docker-compose.fly-data.yml`, but browser wallet vaults are origin-local and
  cannot be shared between localhost and Fly.
- Board Manager now has real worker/action infrastructure; review duplicate
  action protection before increasing process count.
- Hive Chat should be the user-visible conversation surface for Hive, not a
  hidden feed or a plus-menu Hive Input mode.
- Network task state must be read from the same projection in Tasks and Hive.
- Daily airdrop UX must not say "paid" until there is a persisted run and
  payment evidence.
- Profile and Network Task Profile generated summaries must be human-readable,
  outcome-focused, and loaded from prompt files.
- Old `/home/pfrpc/tasknodedata/cache/jsonl` ledger cache was deleted after
  stopping legacy daemons; it is not current Task Node Official canonical state.
