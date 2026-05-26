# Task Node Production Scope

This is the working scope for getting Task Node to a credible production cut. It is a launch-readiness document, not a claim that every row is already green. A surface is production-ready only when the product behavior works for a normal signed-in user, has an operator-visible failure state, and has current docs that match the implementation.

## Launch Rule

Task Node can move from dev-only to production only when every required launch surface is green or deliberately hidden. A green surface has live evidence, a documented owner boundary, and no known blocking user workflow failure. An amber surface is implemented but missing live evidence, has partial provider configuration, or has known edge cases that an operator can tolerate temporarily. A red surface has a user-visible failure or unsafe behavior and must not be exposed as production-ready.

If a feature is implemented but out of launch scope, hide it, label it as out of scope, or keep it out of the main user path. Do not let an out-of-scope integration create a false production promise.

## Required Launch Surface Matrix

| Surface | Production scope | Green evidence required | Current docs |
| --- | --- | --- | --- |
| Login and account cloud | Email, GitHub, Telegram, and X login/linking must work. Discord is out of the initial production scope even if implementation code exists. Random normal Telegram users must be able to authenticate, not only `goodalexander`. | `npm run auth-login-state-fixture` passes; live dev callback test passes for Email, GitHub, Telegram, and X; Connected Accounts shows only launch-scoped enabled providers or clearly marks out-of-scope providers unavailable. | [Auth And Connected Accounts](#docs/auth-and-connected-accounts), [Telegram Bot Chat](#docs/telegram-bot-chat) |
| Funding and wallet | Wallet creation/link/unlock must work. USDC, USDT, and ETH on Ethereum mainnet must be accepted as custodial account top-ups. USDC must credit usage and trigger the qualifying PFT initiation grant path when eligible. USDT and ETH must be live-checked before production because they were not confirmed in the latest operator notes. | A clean deposit address is allocated; USDC live credit is observed; USDT live credit is observed; ETH live credit is observed; duplicate sync does not double-credit; wallet lock/unlock and PFT balance remain intact. | [Wallet](#docs/wallet), [Ethereum Deposit RPC](#docs/ethereum-deposit-rpc), [Deployment](#docs/deployment) |
| Context | The signed-in user can create, edit, save, and reload the current context document without needing a wallet. Publishing to PFTL remains an explicit wallet action. | Manual save/reload test passes for email and OAuth accounts; context document is injected into chat; publish path refuses locked or missing wallet state safely. | [Context](#docs/context), [Encryption](#docs/encryption), [PFTL Usage](#docs/pftl) |
| Context Refine | Context Refine must open from chat, produce a clear proposal, and apply only after explicit user acceptance. It must not silently overwrite context or publish to PFTL. | `npm run context-edit-smoke` passes; live dev user can request an edit, see the inline proposal, accept it, and observe the saved context revision update. | [Chat](#docs/chat), [Refine Context](#docs/refine-context) |
| Chat | All exposed chat settings must work end to end with persistence, billing, context injection, task context injection, memory scheduling, and visible errors. Current exposed modes are Private Instant, Private Thinking, Discount Thinking, Frontier Instant, and Frontier Thinking. If the production product should have exactly four settings, hide or merge Discount Thinking before launch; otherwise it is in scope because it is exposed. | `npm run runtime-smoke`, `npm run chat-spirit-prompt-smoke`, and a live dev send for each exposed mode pass; failed provider calls show useful errors and do not charge successful-completion prices. | [Chat](#docs/chat), [AI Providers](#docs/ai-providers), [System Status](#docs/system-status-home) |
| Hive Chat | Hive Chat must be a real durable conversation, not a transient task-manager trigger. User Hive messages must be logged. Board Manager replies must appear in that same account-scoped Hive Chat only through explicit `message_user` actions. The product must not archive random active work or create unpredictable user-facing churn. | A signed-in user gets the pinned Hive Chat; posting records chat history and Hive Context; Board Manager message delivery creates one logged assistant message and unread badge; archive actions are reversible unless operator-locked. | [Hive](#docs/hive), [Board Manager](#docs/board-manager-architecture), [Board Manager Secretary Packet](#docs/board-manager-secretary-packet) |
| Hive board and Network Tasks | Hive must show live projects, task routing, operators, and activity from real task/projection rows. Board Manager cadence must be inspectable and controlled by the scheduler, not random task-manager side effects. | System Status rows for Board Manager, Secretary Packet, Hive Secretary, Active Projects, Network Task Generation, Task Generation, and Task Review are green or have explained amber states; a project-linked Network Task can move through the normal task lifecycle. | [Hive](#docs/hive), [Network Task Generation Worker](#docs/network-task-generation-worker), [Task Lifecycle](#docs/task-lifecycle) |
| Tasks | Request, accept, refuse, cancel, submit evidence, review, and reward paths must work through signed PFTL/IPFS-backed task events with Postgres projections as the fast read model. | `npm run task-lifecycle-smoke`, `npm run task-receipt-projection-smoke`, and a live dev signed request-to-visible-task check pass. | [Tasks](#docs/tasks), [Task Async Engine](#docs/task-async-engine), [Task Generation Worker](#docs/task-generation-worker), [Task Review And Reward Worker](#docs/task-review-reward-worker) |
| Telegram bot | Linked Telegram users must be able to chat through the bot, choose available chat modes, and see useful responses. Unlinked users must get link instructions. Group chats must not run account-scoped chat. | `npm run telegram-bot-webhook-smoke` passes; live Telegram webhook status is healthy; at least one non-operator Telegram account links and sends a private bot message successfully. | [Telegram Bot Chat](#docs/telegram-bot-chat), [Auth And Connected Accounts](#docs/auth-and-connected-accounts) |
| Memory | Memory must open, render calmly, support deletion, and avoid exposing internal packet ids or provider model ids as user-facing content. Background memory failures must be auditable without blocking chat. | Memory tab opens and scrolls; delete removes account memory from the live store; failed jobs show operator-requeue status without leaking low-level internals to ordinary users. | [Memory](#docs/memory), [Turn Memory Worker](#docs/turn-memory-worker), [Deep Memory Worker](#docs/deep-memory-worker) |
| Profile and airdrop | Public profile must explain earned PFT, rewards, drops, selected PFP/NFT, aliases, and public identity without confusing private account state. Daily airdrop must be auditable and not look like a fake payout when no recipients qualify. | Public/private profile views agree on intended public fields; daily airdrop worker run with zero recipients is labeled as a no-op with reason; PFT earned math is documented. | [Profile](#docs/profile), [Daily Airdrop](#docs/daily-airdrop), [Daily Airdrop Worker](#docs/daily-airdrop-worker) |
| Search | Search must retrieve user-visible cached work without exposing unrelated accounts or raw internal identifiers as primary content. | Search returns account-scoped results with empty/error states; no cross-account leakage in route smoke or manual live check. | [Search](#docs/search), [Database](#docs/database) |
| Docs and System Status | Help must include current user-facing surface docs, architecture runbooks for every live status row, and a live System Status page with last run, next run, trigger, owner, and runbook links. | `npm run system-status-smoke` passes; every status row has a clickable architecture page; production scope page appears under Plans; stale implemented plans are under Implemented / Deprecated Plans. | [System Status](#docs/system-status-home), [Deployment](#docs/deployment), [Execution Mandate](#docs/execution-mandate) |
| Deployment and operations | Fly dev/prod deployment must start web, worker, and board-manager process groups with guarded background roles. Operators must have commands for deploy, worker guard, Board Manager guard, migrations, and data bridge. | `npm run fly:deploy` completes for dev; `npm run fly:background-guard` reports worker and board-manager guard ok; System Status generated from live app matches expected rows. | [Deployment](#docs/deployment), [Database](#docs/database), [System Status](#docs/system-status-home) |

## Explicitly Out Of Initial Production Scope

- Discord login and Discord linking as a production promise. Implementation may exist, but launch scope is Email, GitHub, Telegram, and X.
- User withdrawals from the Ethereum top-up address.
- Wallet-connect or MetaMask-based top-up authorization.
- Nostr public broadcast.
- Autonomous irreversible Hive archive actions.
- Unlogged Hive or Board Manager messages.
- Hidden legacy tools such as Motivation, Brainstorming Context, and Context Rewrite unless they are rebuilt as production surfaces.

## Immediate Work Order

1. Get login green for Email, GitHub, Telegram, and X. Hide or disable Discord for production launch unless the scope changes.
2. Get funding green with live USDC, USDT, and ETH top-up evidence. Do not treat untested asset support as green.
3. Get Context and Context Refine green because chat quality depends on current context being durable and editable.
4. Get Chat green for every exposed mode. Decide whether production exposes four modes or five modes with Discount Thinking.
5. Get Hive Chat green as a logged, durable conversation. Stop treating Hive conversation as a side effect of the task manager.
6. Get Telegram bot green for a non-operator account.
7. Get the task lifecycle and Network Task lifecycle green enough that Hive can route work without inventing fake board motion.
8. Make System Status green or honestly amber/red with runbook links for every non-green row.

## Evidence Log

```text
Date: 2026-05-26
Environment: Fly dev live app at https://tasknodeofficial-dev.fly.dev plus local operator verification command
Surface: Login and account cloud
Status: amber
Evidence: GitHub login was validated live with the GitHub account @pftchad. The live provider readiness endpoint also reports github configured=true, enabled=true, status=ready, startPath=/api/auth/start/github, and callbackPath=/api/auth/callback/github. This proves the GitHub beta login path is working as a user-facing OAuth flow.
Commands: curl -fsS https://tasknodeofficial-dev.fly.dev/api/auth/providers
Live user/account tested: GitHub @pftchad
Remaining blocker: The whole Login surface is not green until Email, Telegram for a non-operator user, and X have matching live beta evidence, and Discord is hidden/disabled or explicitly excluded from the beta provider surface.
Docs updated: docs/wiki/plans/task-node-production-scope.md
```

```text
Date: 2026-05-26
Environment: local repo / deterministic Telegram webhook smoke against Task Node Official code; Fly dev live Telegram behavior operator-reported after the Discount Thinking Telegram rollout
Surface: Telegram bot
Status: amber
Evidence: I ran the Telegram bot webhook smoke and it passed with accountId acct_oauth_de97b03526100b281c9c4333, conversationId account_acct_oauth_de97b03526100b281c9c4333_telegram_12345, chatCalls 3, sentMessages 10, sentChatActions 3, answeredCallbacks 3, and telegramBotEvents 30. That smoke exercises mode selection for Discount Thinking and verifies the next Telegram message routes to Discount Thinking. The operator also repeatedly tested Discount Thinking in live Telegram after the rollout and reported it works.
Commands: npm run telegram-bot-webhook-smoke
Live user/account tested: goodalexander linked Telegram account, operator-reported repeated live Discount Thinking chats; deterministic smoke account acct_oauth_de97b03526100b281c9c4333
Remaining blocker: Telegram bot is not green for production until at least one non-operator Telegram user links successfully and sends a private bot message through the live webhook.
Docs updated: docs/wiki/plans/task-node-production-scope.md and docs/wiki/architecture/telegram-bot-chat.md
```

## Evidence Log Format

Each production-readiness pass should append a dated evidence block using this shape:

```text
Date:
Environment:
Surface:
Status: green | amber | red
Evidence:
Commands:
Live user/account tested:
Remaining blocker:
Docs updated:
```

Do not mark a row green from code inspection alone. Green requires at least one command or live product observation that proves the user workflow.
