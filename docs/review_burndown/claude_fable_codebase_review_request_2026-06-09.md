# Claude Fable Codebase Review Request - 2026-06-09

Reviewer: Claude Fable

Repo: `/home/pfrpc/repos/tasknodeofficial`

Product: Task Node Official

Current production-cutover target: move `https://tasknode.postfiat.org` to Task
Node Official and retire old PFTasks as a live task system.

Review target branch: `review-target/tasknode-cutover-readiness-2026-06-09`.

Review target rule: review the pushed branch HEAD for this package. Do not review
an uncommitted integration checkout or assume `origin/main` contains the current
cutover docs and deployed emergency fixes.

## Request

Perform a codebase review focused on whether Task Node Official is credible for
the PFTasks production cutover. Treat the docs as product claims and verify that
the implementation, deployment config, workers, routes, and user-visible app
states match those claims.

Do not review this as a style pass. Prioritize bugs that can break the cutover:
auth/session failures, wallet custody mistakes, task state divergence, reward or
airdrop double-writes, stale task projections, old PFTasks authority leakage,
worker restart surprises, docs that promise unavailable behavior, and user flows
that leave people unable to act.

## Required Starting Context

Read these first:

- `docs/wiki/plans/task-node-production-cutover-package-2026-06-09.md`
- `docs/wiki/plans/pftasks-transaction-shutdown-cutover-plan-2026-06-09.md`
- `docs/wiki/architecture/pftasks-cutover.md`
- `docs/wiki/plans/task-node-production-scope.md`
- `docs/wiki/index.md`
- `src/features/docs/docs-content.js`

Then review the relevant implementation docs while inspecting code:

- `docs/wiki/surfaces/tasks.md`
- `docs/wiki/architecture/task-generation-worker.md`
- `docs/wiki/architecture/task-review-reward-worker.md`
- `docs/wiki/surfaces/daily-airdrop.md`
- `docs/wiki/architecture/daily-airdrop-worker.md`
- `docs/wiki/surfaces/wallet.md`
- `docs/wiki/surfaces/profile.md`
- `docs/wiki/surfaces/context.md`
- `docs/wiki/surfaces/hive.md`
- `docs/wiki/architecture/user-observability-logging.md`
- `docs/wiki/architecture/deployment.md`
- `docs/wiki/architecture/system-status.md`

## Review Scope

### P0/P1 Boundaries

1. Production routing and deployment
   - Confirm Fly process groups, health checks, background guards, public URL
     config, OAuth callback expectations, and docs all describe the same launch
     path.
   - Look for any path where `tasknode.postfiat.org` could still point users,
     OAuth callbacks, Telegram login, or bot webhooks at old PFTasks.

2. PFTasks shutdown and authority isolation
   - Confirm the Task Node Official docs do not rely on old PFTasks runtime as
     live authority.
   - Identify any code, scripts, prompts, routes, or docs that still encourage
     PFTasks product writes after cutover.
   - Check whether old PFTasks exceptions are limited to seed backup/recovery,
     direct wallet sends, historical reads, and exact-CID preservation.

3. Task lifecycle and projection freshness
   - Review request, offer generation, accept/refuse, evidence submit,
     verification request/response, reward, and visible task projections.
   - Look for stale app-state behavior, hard-refresh dependencies, delayed task
     detail loading, missing optimistic receipts, or wallet/account mismatches.

4. Reward and airdrop money paths
   - Review reward idempotency, reward review worker ownership, daily airdrop
     scoring/issuance, debt/reconcile scripts, and system status checks.
   - Look for duplicate payout risk, failed-row wedges, hidden dry-run vs
     production confusion, and scripts that could run against production without
     clear operator intent.

5. Wallet custody and seed safety
   - Review wallet link/restore/unlock, local vault state, direct-send boundary,
     seed backup claims, and old PFTasks fallback language.
   - Look for any feature that silently moves custody, assumes wallet ownership,
     or claims seed recovery beyond what the app actually supports.

6. Context, profile NFT, and IPFS recovery
   - Review context edit/save/publish, context history restore, NFT generation
     recovery, profile NFT cache import, and IPFS gateway fallback behavior.
   - Look for lost progress, invisible recovery state, old gateway dependency
     that is not labeled legacy, and docs that overstate exact-CID preservation.

7. Hive and Board Manager task routing
   - Review Board Manager worker, Hive project state, Network Task generation,
     wallet-specific capacity, and user-facing routing explanations.
   - Look for stale Hive Chat answers, unpersisted messages, account-wide vs
     wallet-bound capacity confusion, and action hooks that can message or route
     stale users.

8. Help/docs parity
   - Compare the live Help doc registry in `src/features/docs/docs-content.js`
     with `docs/wiki/index.md` and the newly added cutover docs.
   - Flag pages that claim hidden, deprecated, or unimplemented behavior as
     current production behavior.

## Operating Rules

- Use the `tasknodeofficial` skill or equivalent repo-specific operating
  contract. Do not use the old PFTasks tasknode runtime as authority.
- Work in a separate git worktree. Do not edit the integration checkout unless
  explicitly asked.
- Do not print secrets, seeds, provider tokens, database passwords, or private
  payloads. Redact anything sensitive in evidence.
- Do not hard-code reported examples as fixes. If a bug is found, identify the
  failed boundary: routing, state, persistence, timeout, provider selection,
  permissions, policy, or user workflow.
- Default to review findings. Only patch when the fix is small, local, and
  clearly correct.
- Do not re-enable old PFTasks writers as a rollback strategy.

## Suggested Commands

Run the narrow checks that match findings. At minimum, start with:

```bash
git status --short --branch
npm run format-check
npm run lint
npm run build
npm run task-app-state-refresh-smoke
npm run task-detail-loading-state-smoke
npm run task-visible-state-smoke
npm run task-lifecycle-smoke
npm run profile-daily-airdrop-worker-smoke
npm run profile-daily-airdrop-issuance-smoke
npm run profile-daily-airdrop-debt-smoke
npm run profile-daily-airdrop-reconcile-smoke
npm run profile-nft-flow-smoke
npm run hive-context-smoke
npm run board-manager-smoke
npm run system-status-smoke
```

If a command is unavailable, fails because of missing live secrets, or is unsafe
for the current environment, report that explicitly and replace it with the
closest fixture/dry-run.

## Output Format

Write findings first, ordered by severity:

```text
P0/P1/P2/P3 - Title
File/line:
What breaks:
Why it matters for production cutover:
Evidence:
Recommended fix:
Verification:
```

Then provide:

- reviewed commit SHA and branch/worktree;
- files inspected;
- commands run and pass/fail results;
- skipped checks and why;
- docs parity notes;
- residual risks;
- explicit recommendation: `block cutover`, `cutover with listed fixes`, or
  `no cutover blocker found`.

## Review Success Condition

The review is useful only if a cutover operator can answer three questions from
the output:

1. Can Task Node Official safely become the production system at
   `https://tasknode.postfiat.org`?
2. Can old PFTasks be disabled as a live task system while preserving seed
   backup/recovery, direct wallet sends, historical reads, and asset recovery?
3. Which concrete code or docs issues must be fixed before the DNS and worker
   shutdown steps happen?
