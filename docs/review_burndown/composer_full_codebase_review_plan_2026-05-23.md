# Composer Full Codebase Review Plan

Date: 2026-05-23
Owner: composer/review agent
Repo: `/home/pfrpc/repos/tasknodeofficial`

## Objective

Review the full Task Node Official codebase without blocking active product work. The review should find concrete P0/P1/P2 issues, produce small mergeable fixes, and avoid multi-hour wandering. The agent should first build an accurate mental model, then work through prioritized surfaces in narrow passes.

This is not a license for broad rewrites. The desired output is a sequence of small review branches with focused findings, evidence, and low-conflict patches.

## Operating Contract

- Work from a separate worktree or branch. Do not dirty `main` directly.
- Before each pass, fetch `origin/main` and rebase the review branch.
- Keep write scope narrow. One review pass should touch one surface or one boundary.
- Do not delete mocks, prompts, docs, migrations, or workers unless the task explicitly says to remove them.
- Do not run destructive database commands. Migrations must be additive or explicitly reversible.
- Do not hard-code user examples, regex product behavior, one-off task IDs, wallet addresses, or prompt patch strings as fixes.
- If a failure is semantic, fix the routing/classification/persistence boundary, not the literal example.
- Stop and report if the branch conflicts with current active work instead of resolving by deleting other work.
- Every claim must say what was actually verified: static check, smoke, Docker route, Postgres row, live PFTL tx, screenshot, or docs-only.

## Informational Ramp

Spend the first pass on orientation only. Do not edit product code during this pass.

Read in this order:

1. `AGENTS.md` at the workspace root.
2. `/home/pfrpc/.codex/skills/tasknodeofficial/SKILL.md`.
3. `README.md`, `package.json`, `docker-compose.dev.yml`.
4. `docs/wiki/index.md`.
5. `docs/wiki/architecture/database.md`.
6. `docs/wiki/surfaces/chat.md`, `tasks.md`, `wallet.md`, `context.md`, `memory.md`, `hive.md`, `profile.md`.
7. `docs/review_burndown/README.md` and `docs/review_burndown/burndown.md`.
8. `docs/code_reviews/agent_review_quality_guidelines_2026-05-23.md`.

Then map the repo:

```bash
git status --short --branch
git rev-parse --short HEAD
rg --files src server shared scripts prompts docs/wiki server/db/migrations | sort
find server -maxdepth 2 -type f | sort
find src/features -maxdepth 3 -type f | sort
```

Deliverable for the ramp pass:

- A short repo map.
- Top 10 concrete risk areas.
- Proposed first three review branches.
- No product code changes.

## Review Method

Each review slice should follow this loop:

1. State the boundary under review.
2. Read the relevant docs and code.
3. Identify concrete failure modes.
4. Run focused evidence commands.
5. Write findings with file and line references.
6. Patch only P0/P1, or P2 only when small and local.
7. Run targeted checks.
8. Update docs if behavior changed.
9. Open or hand off a small branch.

Timebox:

- Orientation pass: 45 to 75 minutes.
- Each surface review: 60 to 120 minutes.
- If no concrete P0/P1 appears after a focused pass, write the finding summary and move to the next surface.

## Merge Discipline

- Use one branch per review slice, named `review/<surface-or-boundary>`.
- Keep each branch under roughly 300 changed lines unless the user approves a larger refactor.
- Prefer commits that can be cherry-picked.
- Before handoff:

```bash
git fetch origin main
git rebase origin/main
git diff --check origin/main...HEAD
npm run quality
```

- For API/persistence changes, also run the relevant smoke command and a Postgres-backed assertion where applicable.
- For UX changes, inspect the actual local app and include screenshots.
- Do not push or merge over active work without confirming the target branch and worktree state.

## Codebase Map And Review Concerns

### Frontend Shell And Global UI

Key files:

- `src/main.jsx`
- `src/styles.css`
- `src/features/**`
- `src/chat-attachments.js`

Review for:

- State duplicated between global app state, feature local state, URL hash, and server state.
- Large components hiding unrelated behavior.
- Modals that stay stale after state transitions.
- Copy/upload/evidence controls that do not match actual workflow.
- Rendering claims that are not backed by server data.
- Accessibility and mobile overflow only where it affects core workflows.

Checks:

- `npm run build`
- `npm run chat-markdown-smoke`
- Screenshot any changed surface in `http://localhost:5174`.

### API Routes And Product Contracts

Key files:

- `server/index.js`
- `server/product-contracts.js`
- `server/route-policies.js`

Review for:

- Route auth mismatches.
- Optional-auth routes accidentally exposing account data.
- Contract responses whose shape differs between dry-run, send, stream, and failure paths.
- Error responses that hide the actionable failure.
- Route code doing business logic that should live in a service/repository.

Checks:

- `npm run route-smoke`
- `npm run security-smoke`
- Targeted curl route checks where a response contract changes.

### Chat, Providers, Attachments, And Billing

Key files:

- `server/chat-router.js`
- `server/chat-estimate.js`
- `server/chat-search-tools.js`
- `server/chat-attachment-utils.js`
- `server/chat-context-load.js`
- `server/chat-context-status.js`
- `server/repositories/chat-billing.js`
- `server/context-edit-chat.js`

Review for:

- Estimate, credit gate, execution, and ledger divergence.
- Web-search tool cost not represented in preflight.
- Attachment accepted in UI but silently dropped server-side.
- Context/memory/task state loaded in one path but missing in stream or Context Refine.
- Provider-specific history shape drifting without tests.
- Postgres persistence not matching runtime-store behavior.

Checks:

- `npm run chat-attachment-smoke`
- `npm run chat-context-status-smoke`
- `DATABASE_URL=postgres://tasknodeofficial:tasknodeofficial@localhost:5436/tasknodeofficial node scripts/chat-context-status-smoke.mjs`
- Stream SSE spot-check when stream payload changes.

### Auth, Identity, Wallet Linking, And Unlock

Key files:

- `server/product-contracts.js`
- `server/runtime-store.js`
- `src/features/wallet/**`
- `src/features/tasks/task-request-unlock-policy.js`
- `server/repositories/*account*`

Review for:

- Signup identity, linked wallet, local seed vault, and unlocked wallet being conflated.
- Delinked wallets still owning account-scoped data.
- Wallet unlock policy bypasses in task request flows.
- Email accounts receiving wallet grants incorrectly.
- Seed backup or wallet export paths leaking server-side.

Checks:

- `npm run security-smoke`
- `npm run task-request-unlock-policy-smoke`
- Manual wallet lock/unlock UX only if touched.

### Context Document And Context Refine

Key files:

- `server/repositories/context.js`
- `server/context-edit-chat.js`
- `server/context-edit-prompts.js`
- `server/context-line-map.js`
- `src/features/context/**`

Review for:

- Current context draft and PFTL revision history being conflated.
- Native editor save claiming success before persistence.
- Context Refine proposal remaining active after accept/reject/navigation.
- Line-number mappings corrupting accepted edits.
- History hydration relying on wallet unlock when current context should not.

Checks:

- `npm run context-edit-smoke`
- Postgres query for context rows after save/apply where applicable.
- Local app path for edit, navigate away, restore.

### Tasks, Evidence, Verification, And Rewards

Key files:

- `src/features/tasks/**`
- `server/task-request.js`
- `server/task-generation-worker.js`
- `server/task-review-worker.js`
- `server/task-payloads.js`
- `server/task-evidence-processing.js`
- `server/task-forensics-format.js`
- `server/repositories/tasks.js`
- `prompts/task_engine/**`

Review for:

- UI state not matching `task_projections`.
- Ambiguous states such as submitted vs awaiting review vs verification requested.
- Evidence packet content not shown in forensics.
- Multiple evidence submission behavior.
- Reward decision and reward payment divergence.
- Prompt-level behavior accidentally implemented with hard-coded rules.
- PFTL event order, reducer state, and UX tab state disagreement.

Checks:

- `npm run task-lifecycle-smoke`
- `npm run task-evidence-drafts-smoke`
- `npm run task-copy-payload-smoke`
- If chain-affecting: record task ID, CID, tx hash, and projection row.

### PFTL Cache, IPFS, Encryption, And Chain Replay

Key files:

- `server/pftl-cache-*.js`
- `server/repositories/pftl-cache.js`
- `server/pftl-transactions.js`
- `server/context-publish.js`
- `server/context-ipfs.js`
- `server/task-payloads.js`
- `server/db/migrations/*pftl*`

Review for:

- Cache treated as canonical instead of replayable projection.
- Wallet-scoped replay missing authority/allocation wallet events.
- Archive/backfill code pulling stale blank pointers into current projections.
- Encrypted IPFS payloads not decryptable by expected task node key.
- RPC limit behavior not documented or bounded.
- Idempotency failures causing duplicate projections or payments.

Checks:

- `npm run pftl-cache-smoke`
- `npm run pftl-cache-watcher-smoke`
- DB row assertions for cache/reducer changes.
- Live protocol smoke only with explicit permission and clear tx/CID output.

### Memory And Network Task Profile

Key files:

- `server/chat-memory-worker.js`
- `server/repositories/chat-memory.js`
- `server/chat-memory-context.js`
- `server/repositories/network-task-profile.js`
- `prompts/memory/**`
- `src/features/memory/**`

Review for:

- Memory writes blocking chat.
- User-derived memory injected as instructions without clear boundary.
- Deep memory block scheduling duplicates.
- Network routing context bloated by stale tasks or unknown states.
- User-visible memory not matching what is injected into chat.

Checks:

- `npm run network-task-profile-smoke`
- Query memory rows for account/block uniqueness.
- Verify prompt input packet size and contents.

### Hive, Board Manager, And Network Tasks

Key files:

- `src/features/hive/**`
- `server/hive-routes.js`
- `server/hive-secretary-worker.js`
- `server/hive-project-worker.js`
- `server/board-manager-actions.js`
- `server/repositories/board-manager.js`
- `server/repositories/hive-projects.js`
- `server/network-task-generation-worker.js`
- `prompts/hive/**`

Review for:

- Agent run state not visible or not auditable.
- Board Manager actions bypassing policy or user targeting.
- Project/task state duplicated between Hive UI and task projections.
- Network task allocation state confused with task lifecycle state.
- Agent context packet bloat.
- Missing reasoning for "no action" decisions.

Checks:

- `npm run board-manager-smoke`
- `npm run board-manager-source-packet-smoke`
- `npm run board-manager-micro-summary-smoke`
- `npm run board-manager-action-hooks-smoke`
- `npm run hive-context-smoke`
- `npm run hive-project-planning-smoke`

### Profile, NFT, Daily Airdrop, And Public Discovery

Key files:

- `src/features/profile/**`
- `server/profile-*.js`
- `server/repositories/profile-*.js`
- `prompts/profile/**`

Review for:

- Public profile claims not backed by real profile/task/airdrop data.
- Airdrop paid amount, task rewards, and 7-day averages disagreeing.
- Prompt outputs using jargon that is not useful for discovery.
- NFT generation prompt privacy leaks.
- Minted/generated NFT gallery state not matching media availability.

Checks:

- `npm run profile-nft-prompt-smoke`
- `npm run profile-nft-flow-smoke`
- DB query for daily airdrop rows and NFT rows when touched.

### Database, Migrations, And Repositories

Key files:

- `server/db/migrations/**`
- `server/db/migrate.js`
- `server/repositories/**`
- `docs/wiki/architecture/database.md`

Review for:

- Missing account ownership filters.
- Runtime-store fallback semantics differing from Postgres.
- Non-idempotent upserts.
- Duplicate materialized state without invalidation.
- Missing indexes on hot reads.
- Migration order or rollback hazards.

Checks:

- `DATABASE_URL=postgres://tasknodeofficial:tasknodeofficial@localhost:5436/tasknodeofficial node server/db/migrate.js`
- Targeted SQL `EXPLAIN` only for observed slow queries.
- Existing repository smoke for the affected feature.

### Prompts And Model Policy

Key files:

- `prompts/**`
- `server/prompt-registry.js`
- `server/chat-memory-context.js`
- task/reward/profile/hive workers that call providers.

Review for:

- Prompt behavior implemented with hidden regex or literal hard-coding in code.
- Prompts containing meaningless meta-instructions for models.
- Private/ZDR provider policy not reflected in request bodies.
- Prompt files not listed in Help docs.
- Prompt changes without smoke coverage.

Checks:

- `npm run chat-spirit-prompt-smoke`
- Prompt-specific smoke if present.
- Inspect request body builder for provider policy.

### Docs, Help Surface, And Review Burndown

Key files:

- `docs/wiki/**`
- `src/features/docs/docs-content.js`
- `docs/review_burndown/**`
- `docs/code_reviews/**`

Review for:

- Docs saying future/planned work exists now.
- Help navigation missing new surfaces.
- Review briefs stale after major architecture changes.
- Diagrams not rendering in the app.
- Tables or code blocks overflowing.

Checks:

- Open Help docs in local app after visible docs changes.
- `npm run build`.

## Cross-Cutting Checklist

Use this checklist for every slice:

- [ ] Account ownership enforced at repository boundary, not only route boundary.
- [ ] Signed-out behavior returns empty or 401, never shared dev data.
- [ ] Wallet-required actions fail before producing fake state.
- [ ] Local seed or private prompt material does not leave the intended boundary.
- [ ] Billing estimate includes all costs the request can incur.
- [ ] Post-execution ledger writes match provider usage.
- [ ] Runtime-store fallback and Postgres behavior are equivalent enough for tests.
- [ ] Async workers are idempotent and can retry without duplicate side effects.
- [ ] UI tabs/cards/modals read from the same projection as detail/forensics.
- [ ] Cache is labeled and treated as cache, not canonical chain truth.
- [ ] Prompts live in `prompts/**`; code does not hard-code semantic behavior.
- [ ] Regex or literal checks are only mechanical protocol guards.
- [ ] Docs describe implemented behavior, not aspirational behavior.
- [ ] Tests prove behavior class, not only one exact user example.

## Completion Evidence

Each completed review branch must include:

- Review brief or code review markdown updated with findings.
- Changed files listed.
- Commands run with pass/fail.
- Screenshots for visible UX changes.
- DB query or smoke output for persistence changes.
- Transaction/CID/task ID evidence for PFTL changes.
- Clear statement of remaining gaps.

## Burn Down List

### Phase 0 - Ramp And Repo Map

- [ ] Read required ramp docs.
- [ ] Produce repo map.
- [ ] Identify top 10 concrete risks.
- [ ] Propose first three review branches.

### Phase 1 - Highest Risk User And Money Paths

- [ ] Chat/provider/billing review.
- [ ] Tasks/evidence/reward review.
- [ ] Wallet/auth/unlock review.
- [ ] PFTL cache/projection review.
- [ ] Database ownership/index review.

### Phase 2 - Context, Memory, And Agentic State

- [ ] Context document and Context Refine review.
- [ ] Memory/deep memory/network profile review.
- [ ] Hive/Board Manager/network task review.
- [ ] Prompt registry and provider policy review.

### Phase 3 - Profile, Docs, And Product Coherence

- [ ] Profile/NFT/daily airdrop review.
- [ ] Docs/help surface review.
- [ ] Frontend shell/UI state review.
- [ ] Smoke command coverage review.

### Phase 4 - Merge And Stabilize

- [ ] Rebase all open review branches onto current `origin/main`.
- [ ] Merge completed P0/P1 fixes first.
- [ ] Run `npm run quality` on merged main.
- [ ] Run targeted Postgres and Docker checks for merged server changes.
- [ ] Update `docs/review_burndown/burndown.md` statuses.
- [ ] Write final residual-risk summary.
