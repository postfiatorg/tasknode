# Dirty checkout reconciliation inventory

Date: 2026-09-01
Base branch: `main`
Base commit before reconciliation: `6707d1a`

No file in this inventory was discarded. Existing changes were grouped into reviewable preservation commits before the isolated Deep Research commit was integrated.

## Committed versus stashed

The dirty checkout shown below was committed, not stashed:

- `d5e9add` preserves board-manager and network-policy work.
- `b7fed69` preserves multi-account authentication and wallet isolation.
- `0e5aebc` preserves Team Context report work.
- `62b4760` preserves shared product integration work.
- `7c091a2` adds the isolated Deep Research workflow.
- `4252cac` aligns the wallet runtime smoke with the ownership-isolation contract.

No new stash was created during this reconciliation. The repository still contains 16 older named stashes dated before this work; they were neither applied nor deleted because they are separate recoverable user history. The working tree and index are clean.

## Categories

- **Multi-account authentication and wallet isolation:** password login, account switching, challenge/session binding, device account sets, wallet ownership, migration 128, related UI and verification.
- **Team Context reports:** report contract/worker/repository, migration 130, prompts, Team UI, screenshots, and report-specific tests/docs.
- **Board Manager and contributor/network policy:** BM runtime hardening, core-contributor authorization, network eligibility/profile/badge behavior, policy prompt, and related tests/docs.
- **Shared integration and chat/document provider work:** common server/app boundaries touched by multiple groups, attachment policy, Vercel inference adapter, generated reference/docs, package metadata, and remaining cross-cutting tests.

## Original status snapshot

```text
 M docs/api-reference.md
 M docs/wiki/architecture/ai-providers.md
 M docs/wiki/architecture/auth-and-connected-accounts.md
 M docs/wiki/architecture/auth-wallet-boundary.md
 M docs/wiki/architecture/database.md
 M docs/wiki/surfaces/agents.md
 M docs/wiki/surfaces/chat.md
 M docs/wiki/surfaces/context.md
 M docs/wiki/surfaces/hive.md
 M docs/wiki/surfaces/memory.md
 M docs/wiki/surfaces/tasks.md
 M docs/wiki/surfaces/team.md
 M docs/wiki/surfaces/user-guide.md
 M fly.toml
 M ops/bm-runtime/bm-env.sh
 M ops/bm-runtime/bm-install-skills.sh
 M ops/bm-runtime/bm-launch.sh
 M ops/bm-runtime/bm-proxy.sh
 M ops/bm-runtime/bm-whip.sh
 M ops/bm-runtime/skills/board-pfterminal/SKILL.md
 M package-lock.json
 M package.json
 M prompts/chat/help_mode_v1.md
 M prompts/hive/hive_network_task_routing_policy_v1.md
 M scripts/account-wallet-repository-smoke.mjs
 M scripts/auth-login-state-fixture.mjs
 M scripts/auth-session-repository-smoke.mjs
 M scripts/background-worker-liveness-smoke.mjs
 M scripts/chat-attachment-smoke.mjs
 M scripts/chat-spirit-prompt-smoke.mjs
 M scripts/collaboration-contract-smoke.mjs
 M scripts/hive-context-smoke.mjs
 M scripts/hive-state-integrity-smoke.mjs
 M scripts/network-badge-profile-smoke.mjs
 M scripts/network-task-badge-gate-smoke.mjs
 M scripts/network-task-eligibility-panel-smoke.mjs
 M scripts/network-task-profile-smoke.mjs
 M scripts/request-validation-smoke.mjs
 M scripts/route-auth-policy-smoke.mjs
 M scripts/runtime-store-smoke.mjs
 M scripts/team-task-popout-smoke.mjs
 M scripts/wallet-state-regression.mjs
 M server/account-identity.js
 M server/ambient-attachments.js
 M server/app-state.js
 M server/auth-connected-accounts.js
 M server/background-workers.js
 M server/chat-attachment-utils.js
 M server/chat-context-load.js
 M server/chat-memory-worker.js
 M server/collaboration-routes.js
 M server/evidence-file-extraction.js
 M server/index.js
 M server/offchain-task-lifecycle.js
 M server/product-contracts.js
 M server/product-wallet-contracts.js
 M server/repositories/account-wallets.js
 M server/repositories/accounts.js
 M server/repositories/auth-challenges.js
 M server/repositories/auth-sessions.js
 M server/repositories/network-badges.js
 M server/repositories/network-task-eligibility.js
 M server/repositories/network-task-profile.js
 M server/repositories/pftl-cache.js
 M server/repositories/task-replay-import.js
 M server/request-body-contracts.js
 M server/route-policies.js
 M server/runtime-store-auth-challenges.js
 M server/runtime-store-wallet.js
 M server/runtime-store.js
 M server/server-http-boundary.js
 M src/app/App.jsx
 M src/app/app-shell-shared.jsx
 M src/features/chat/ChatSurface.jsx
 M src/features/docs/docs-content.js
 M src/features/memory/MemoryView.jsx
 M src/features/profile/ProfileIdentityPanels.jsx
 M src/features/settings/AppDialogs.jsx
 M src/features/tasks/network-task-eligibility-state.js
 M src/features/team/TeamView.jsx
 M src/features/team/team.css
 M src/features/wallet/WalletComponents.jsx
 M src/features/wallet/WalletView.jsx
 M src/features/wallet/wallet-state.js
 M src/styles-composer.css
 M src/styles-settings.css
 M src/styles-shell.css
?? docs/verification/
?? docs/wiki/architecture/multi-account-password-wallet-spec.md
?? docs/wiki/architecture/team-context-report-plan.md
?? prompts/team/
?? scripts/bm-runtime-harness-smoke.mjs
?? scripts/core-contributor-allowlist-smoke.mjs
?? scripts/multi-account-password-wallet-smoke.mjs
?? scripts/team-context-smoke.mjs
?? scripts/team-context-state-smoke.mjs
?? scripts/team-context-visual-smoke.mjs
?? scripts/wallet-account-isolation-audit.mjs
?? scripts/wallet-challenge-account-binding-smoke.mjs
?? server/account-auth-routes.js
?? server/account-password-auth.js
?? server/account-switching.js
?? server/core-contributor-authorization.js
?? server/db/migrations/128_multi_account_password_wallet_isolation.sql
?? server/db/migrations/130_team_context_reports.sql
?? server/repositories/account-passwords.js
?? server/repositories/device-account-sets.js
?? server/repositories/team-context.js
?? server/runtime-store-account-login.js
?? server/team-context-contract.js
?? server/team-context-worker.js
?? server/vercel-inference.js
?? shared/chat-attachment-policy.js
?? src/features/settings/ProfileAccountSwitcher.jsx
?? src/features/settings/account-switch-client.js
?? src/features/settings/account-transition-boundary.js
?? src/features/team/team-context-refresh.js
```
