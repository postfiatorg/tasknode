# Task Node Production Scope

Date: 2026-06-02

Status: production is live at `https://tasknode.postfiat.org` (cutover executed
2026-06-10). This page remains the readiness ledger for the launch-surface
matrix and the P0/P1 work items below; per the operating evidence rule, items
move to green only with live evidence, not code inspection.

Progress note (2026-06-11): P0-5 (contributor eligibility explainable) is
implemented — the Tasks surface ships a Network Task Eligibility Panel backed
by one shared capacity predicate, and Hive Chat answers eligibility from packet
data; live non-operator evidence is still owed. P0-2 (Context Refine save
durability) and P0-6 (reward/review idempotency) have hardened implementations
and passing smokes; the live-evidence bar still applies. P0-1 (non-operator
Telegram), P0-3/P0-4 (board clarity and consolidation), and P0-7 (provider
failure UX) remain open.

Contributor trust task: `task_2fa17202f941537b166cef01ee6b66c8`

This is the one remaining active plan for Task Node. Older implementation plans
have either been deleted from the docs surface or moved into the current
surface/architecture docs that now own the behavior.

The goal is an acceptable beta, not a perfect production system. Acceptable beta
means a normal signed-in user can use the core loop, understand what state the
system is in, and avoid unsafe money, wallet, or reward behavior.

## Launch Rule

Task Node can be called beta-ready when every required launch surface is either:

- **Green**: the workflow works for a normal signed-in user, has live or command
  evidence, and has docs/runbooks that match the implementation;
- **Amber accepted**: the workflow is implemented and safe, but has a known
  limitation that is clearly documented and tolerable for beta;
- **Hidden**: the feature is not promised in the main user path.

Red surfaces must not be presented as beta-ready. A red surface is one that
misleads the user, loses durable state, charges or rewards incorrectly, leaks
private data, blocks core navigation, or produces stale authoritative state.

## Beta Acceptance Gates

These four gates are the product boundary for the restored core Task Node beta.
If a surface cannot pass its sentence, it does not ship as beta-ready.

| Gate | Acceptance sentence | Current state | Remaining beta work |
| --- | --- | --- | --- |
| Telegram | A user sends a message, gets a clarifying response that references their context, and leaves sharper about what to do next. | Implemented and smoke-tested. Telegram can route linked private bot chats through configured chat modes, including Discount Thinking. | Prove at least one non-operator Telegram user can link and get a useful live reply. Keep provider failure messages actionable. |
| Task generation | A user asks for a task in plain language, sees one task clearly connected to their values and strategy, and knows why it is the right thing to do. | Implemented through signed task request, task generation worker, PFTL/IPFS offer, projection, Tasks UI, and Network Task generation bridge. | Keep generated tasks from mirroring user input without adding judgment. Make task rationale and next action obvious in every path. |
| Context editing | A user asks the system to review their context, it identifies a specific weakness and proposes a concrete edit, and the user accepts it because it is tighter than what they would produce alone. | Implemented as Context Refine with explicit proposal/apply behavior. Context save/publish boundaries are documented. | Re-run live save/refresh evidence after recent context changes. Ordinary draft refinement must never require wallet signing. |
| Hive board | A user opens the board, sees what core contributors are working on and why, and can spot the single next task to earn rewards and advance shared goals. | Partially implemented. Hive has live project/task rows, project activity, Board Manager feed, full logs, state-aware message preconditions, and Network Task routing. | Highest-risk gate. Consolidate Task Node boards, prevent stale/opaque board messages, make contributor eligibility visible, and route validation tasks without confusing personal tasks and Network Tasks. |

## What Is Already Done

These items should not remain standalone plans. Their current truth lives in
the linked docs.

| Area | Done state | Current owner docs |
| --- | --- | --- |
| Task lifecycle UX | Request, offer, accept, refuse, cancel, submit evidence, verification, and reward states are implemented as the task product model. | [Tasks](#docs/tasks), [Task Generation](#docs/task-generation) |
| Task review and reward | Review, verification request, verification response, and terminal `pf.reward.v1` reward outcome are implemented. Duplicate reward hardening is documented in the task generation architecture. | [Task Generation](#docs/task-generation) |
| Network Task bridge | Board Manager can initiate project-linked Network Task allocation/generation jobs; the task engine writes the concrete task offer. | [Hive](#docs/hive), [Hive & Board Operations](#docs/hive-operations), [Task Generation](#docs/task-generation) |
| Board Manager v0 | Leased Board Manager jobs, action registry, user-message delivery, follow-ups, project restore/archive, and action audit feed exist. | [Hive & Board Operations](#docs/hive-operations), [Hive](#docs/hive), [Deployment](#docs/deployment) |
| Board Manager secretary packets | DeepSeek secretary packet compression exists and is documented as part of the Board Manager path. | [Hive & Board Operations](#docs/hive-operations) |
| Hive project professionalism | Hive cards, project details, task/activity rows, live contributor rollups, and agent feed are implemented. | [Hive](#docs/hive), [Hive & Board Operations](#docs/hive-operations) |
| Hive stale-message guard | Task-action `message_user` decisions require runtime preconditions and are skipped if fresh account state contradicts the message. | [Hive & Board Operations](#docs/hive-operations), [Hive](#docs/hive) |
| Context Refine | Context editing via proposal/apply flow is implemented. | [Refine Context](#docs/refine-context), [Context](#docs/context), [Chat](#docs/chat) |
| Jobs chat spirit and retrieval | Standard chat uses the Jobs-calibrated prompt with context, task awareness, memory, and Jobs pgvector retrieval. | [Chat](#docs/chat), [AI Providers](#docs/ai-providers), [Jobs PGVector Corpus](#docs/jobs-pgvector-corpus) |
| Memory and Network Diagnostic Report | Turn memory, deep memory, and Network Task profile workers exist; Memory surfaces the compressed context. | [Memory](#docs/memory), [Profile](#docs/profile) |
| Profile and daily airdrop | Public/private profile, profile NFT/PFP handling, and daily airdrop worker docs exist. | [Profile](#docs/profile), [Daily Airdrop](#docs/daily-airdrop) |
| PFTL transaction cache | PFTL cache, hot sync, archive sync, WSS watcher, reducer, and retention runbooks exist. | [PFTL](#docs/pftl) |
| Contributor trust framework | Beta stance is defined: no heavy upfront Sybil gate; trust is earned through task history, linked-account signals, evidence quality, and targeted Board Manager validation tasks when risk warrants it. | This plan, plus [Hive & Board Operations](#docs/hive-operations) and [Task Generation](#docs/task-generation) |

## Contributor Trust And Sybil Verification Policy

Beta should not start with a heavy Sybil gate. A new user's first experience
should be a useful task or a clear reason no task is available, not a generic
proof-of-personhood checkpoint. Trust should emerge from work output first, then
shape routing, reward caps, and review depth.

The default beta eligibility rule is:

1. The user has a Task Node account.
2. The user has a linked wallet for reward-bearing work.
3. The user has enough context and task history to generate a Network Diagnostic
   Report, or has explicit operator authorization from `agticorp` or
   `goodalexander`.
4. The user has no active Network Task capacity blocker and no unresolved
   operator hold.

This means wallet-link plus Network Diagnostic Report is the normal beta path.
Linked accounts, Telegram, GitHub, email, X, wallet age, and public handle are
signals, not hard proof-of-personhood requirements.

### Trust Inputs

Board Manager should receive a compact contributor trust packet, not full raw
private history. The packet should include:

- linked-account count and provider mix;
- explicit operator authorization or testing exemption;
- wallet age, wallet reuse, and reward-wallet mapping;
- Network Diagnostic Report status;
- Network Task completion rate;
- evidence quality average and recent trend;
- verification responsiveness;
- refusal rate and refusal reasons;
- duplicate account, account-deletion, faucet, or initiation-grant abuse signals;
- reward/review idempotency anomalies;
- open disputes or operator holds.

The user-facing product should not show a raw Sybil score. It should show plain
eligibility language: `eligible`, `needs more task history`, `validation task
needed`, `capacity blocked`, `operator hold`, or `no suitable task right now`.

### Board Manager Validation Path

Board Manager may require Sybil verification only by routing a specific
validation task or by applying a temporary operator hold. It should not invent a
generic signup wall.

Board Manager should choose a validation task when one or more are true:

- the contributor is unknown and the next available Network Task is high reward;
- linked-account or wallet signals suggest possible duplicate accounts;
- the user has repeated account resets, faucet attempts, or initiation-grant
  churn;
- recent evidence quality is low and the next task would be expensive;
- the user is requesting access to a sensitive project, trust-sensitive
  coordination work, or a role adjacent to review/reward authority;
- an operator marked the account for validation.

Board Manager should not require validation when:

- the task is low-value and non-sensitive;
- the contributor has recent high-quality completed work;
- the account is a known QA/test account with an explicit exemption;
- the only concern is lack of social graph data.

### Validation Task Shape

A validation task must be concrete, respectful, and hard to fake at scale. It
should validate routing confidence, not humiliate the user or ask for private
information.

Acceptable validation task examples:

- Contact a named project participant about their project through an approved
  channel, ask them to request a personal task, and submit the resulting task
  id.
- Ask one useful question in a project channel, then submit the question, the
  answer, and the resulting next-action summary.
- Link a second independent account provider and confirm the same wallet remains
  attached.
- Complete a small public project-specific task that requires reading the live
  Hive board and producing an artifact that references the correct project,
  contributor, and next action.
- Produce a concise explanation of why a proposed Network Task matters and what
  evidence would prove it was completed.

Disallowed validation task examples:

- Government ID, KYC, or social-graph attestation for ordinary beta access.
- Requests for client names, investor names, trading IP, termination decisions,
  legal/confidential facts, or private team disputes.
- Generic "prove you are human" busywork unrelated to the network.
- Tasks that require another user to disclose private context.

Validation task outcomes:

- Pass: contributor becomes eligible for the target task class or reward band.
- Partial: contributor may receive lower-cap tasks or stricter review.
- Fail: contributor is not banned automatically; Board Manager lowers routing
  confidence and may require operator review for higher-value tasks.
- Abuse: operator hold or route pause is allowed when the evidence suggests
  faucet, reward, confidentiality, or duplicate-account abuse.

### Reward Safeguards

Trust scoring must never replace protocol idempotency. Every task still has one
terminal reward outcome through `pf.reward.v1`, and replayed workers must return
the existing reward reference instead of signing again.

Reward safeguards for beta:

- Unknown contributors get lower reward caps and stricter verification.
- Eligible contributors get normal Network Task routing and normal review.
- Trusted contributors can receive higher caps and possible randomized upside.
- Randomized upside can pay up to `2x` for above-and-beyond work, but only after
  evidence quality and task usefulness justify it.
- Testing exemptions can bypass activation friction for QA accounts, but cannot
  bypass duplicate reward protection.
- Disputes create task-level audit records. They do not become side-channel chat
  promises.

## Remaining Beta Work

### P0: Must Fix Or Prove Before Beta

| P0 | Work | Why it matters | Done when |
| --- | --- | --- | --- |
| P0-1 | Prove non-operator Telegram linking and chat. | Telegram is a core beta gate and cannot depend only on owner accounts. | A non-operator Telegram user links, sends a private bot message, receives a useful context-aware reply, and the conversation appears in account chat history. |
| P0-2 | Prove Context Refine save durability on live dev. | A context editor that says "saved" but loses the edit destroys trust. | A live account accepts a Context Refine edit, refreshes, and the edit remains. |
| P0-3 | Make Hive board state understandable to users. | The board is still the weakest product surface and can look arbitrary or stale. | A user can see project purpose, current contributor work, one next reward-bearing task or honest blocker, and why Board Manager did or did not act. |
| P0-4 | Consolidate duplicate Task Node project boards. | Multiple Task Node boards make routing look random and hide the real active project. | Task Node work routes under one durable Task Node project unless an operator explicitly creates a separate real project. |
| P0-5 | Make contributor eligibility explainable. | Users currently cannot tell whether they can get Network Tasks or why not. | Hive/Tasks explains the real blocker: missing wallet, missing Network Diagnostic Report, capacity blocker, validation task needed, operator hold, or no suitable project task. Board Manager can route a validation task instead of silently blocking a user behind a hidden Sybil concern. |
| P0-6 | Keep reward/review idempotency green. | Duplicate rewards or duplicate verification requests are economically unsafe. | Replay/idempotency smokes pass, reward projections show one terminal reward outcome per task, and Deathmarch/public feeds do not fabricate duplicate chain events. |
| P0-7 | Finish user-facing provider failure behavior. | Chat and Telegram failures must not look like random product collapse. | Failed provider calls preserve the user message, show a clear retry/mode-health message, and do not bill as successful completions. |

### P1: Beta Hardening

| P1 | Work | Done when |
| --- | --- | --- |
| P1-1 | Add contributor trust read model. | Linked-account strength, wallet stability, Network Diagnostic Report status, task completion rate, evidence quality, verification responsiveness, refusals, operator authorization, testing exemption, and Sybil risk are compacted for Board Manager. |
| P1-2 | Add contributor-validation Network Task class. | Board Manager can route a respectful validation task when risk warrants it, record the result, and use that result to raise/lower eligibility without creating a generic upfront Sybil gate. |
| P1-3 | Add randomized reward upside policy. | Tasks can pay up to `2x` for above-and-beyond work without bypassing review, caps, or idempotency. |
| P1-4 | Tighten System Status evidence. | Every scheduler/worker/RPC row has status, last run, next run or freshness, and a runbook link. |
| P1-5 | Improve Hive/Board Manager full logs. | Full logs show source facts, rejected actions, next check, and hook result before raw JSON. |

## Required Launch Surface Matrix

| Surface | Beta scope | Current state | Current docs |
| --- | --- | --- | --- |
| Login and account cloud | Email, GitHub, Telegram, and X login/linking. Discord is currently enabled in production but is non-core: no launch promise or support commitment. | GitHub has live evidence. Telegram must be proven with non-operator linking. Email and X need current beta evidence. | [Identity & Wallets](#docs/identity-wallets), [Telegram Bot Chat](#docs/telegram-bot-chat) |
| Wallet and funding | Wallet creation/link/unlock and top-up accounting for launch-supported assets. | Wallet flow works in QA. USDC evidence exists historically; USDT/ETH need current confirmation before a production claim. | [Wallet](#docs/wallet), [Ethereum Deposit RPC](#docs/ethereum-deposit-rpc), [Deployment](#docs/deployment) |
| Context | Create, edit, save, reload current context without wallet. Publish remains wallet-bound. | Implemented; live save durability must be rechecked. | [Context](#docs/context), [Encryption](#docs/encryption), [PFTL Usage](#docs/pftl) |
| Context Refine | Review context, propose edit, apply only after user acceptance. | Implemented; needs fresh live evidence. | [Refine Context](#docs/refine-context), [Chat](#docs/chat) |
| Chat | Exposed modes persist messages, use context/memory/task state, bill correctly, and fail clearly. | Implemented; provider failure behavior and mode matrix need recurring live QA. | [Chat](#docs/chat), [AI Providers](#docs/ai-providers) |
| Telegram bot | Linked private bot chat for normal users; unlinked users get link instructions. | Implemented; non-operator live proof remains. | [Telegram Bot Chat](#docs/telegram-bot-chat) |
| Tasks | Request, accept/refuse/cancel, submit, verify, and reward through PFTL/IPFS and projections. | Implemented; keep replay/idempotency checks green. | [Tasks](#docs/tasks), [Task Generation](#docs/task-generation) |
| Hive Chat | Durable account-scoped Hive conversation with logged Board Manager replies. | Implemented; system-vs-chat distinction and stale-state audit remain product risks. | [Hive](#docs/hive), [Hive & Board Operations](#docs/hive-operations) |
| Hive board and Network Tasks | Live project/task/operator/activity view with one clear next reward task or blocker. | Implemented but highest-risk. Needs board consolidation and eligibility clarity. | [Hive](#docs/hive), [Hive & Board Operations](#docs/hive-operations), [Task Generation](#docs/task-generation) |
| Memory | Readable memory, deletion, and worker failure audit without exposing internal packet ids as primary labels. | Implemented; keep UX/regression evidence current. | [Memory](#docs/memory) |
| Profile and airdrop | Public/private profile, PFT metrics, profile NFT/PFP, and honest airdrop state. | Implemented; daily zero-recipient no-op must stay clearly labeled. | [Profile](#docs/profile), [Daily Airdrop](#docs/daily-airdrop) |
| Docs and System Status | Help docs and live status rows match actual schedulers, workers, RPCs, and runbooks. | Implemented; keep stale plan pages removed. | [System Status](#docs/system-status-home), [Execution Mandate](#docs/execution-mandate) |
| Deployment and operations | Fly deploy starts app, worker, and Board Manager process groups with guard checks. | Implemented. | [Deployment](#docs/deployment), [Database](#docs/database) |

## Explicitly Out Of Initial Beta Scope

- Discord login/linking as a production promise.
- User withdrawals from Ethereum top-up addresses.
- WalletConnect or MetaMask top-up authorization.
- Nostr public broadcast.
- Autonomous irreversible Hive archive actions.
- Hidden legacy context modes such as Motivation, Brainstorming Context, and Rewrite.
- Raw Sybil-score display to users.
- Heavy upfront Sybil gates, KYC, government ID, or social-graph attestation for
  ordinary beta access.
- Legal/confidential, client-name, termination, or trading-IP disclosure tasks.

## Operating Evidence Rule

Do not mark a row green from code inspection alone. Green requires at least one
command or live product observation proving the user workflow.

Each beta-readiness pass should append evidence in this shape:

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

## Current Evidence Notes

```text
Date: 2026-05-26
Environment: Fly dev live app at https://tasknodeofficial-dev.fly.dev plus local operator verification command
Surface: Login and account cloud
Status: amber
Evidence: GitHub login was validated live with GitHub account 0xPostFiatChad. The live runtime store recorded username 0xPostFiatChad and the live provider readiness endpoint reported GitHub configured, enabled, and ready.
Commands: curl -fsS https://tasknodeofficial-dev.fly.dev/api/auth/providers
Live user/account tested: GitHub 0xPostFiatChad; Task Node display name @pftchad
Remaining blocker: Email, Telegram for a non-operator user, and X need matching live beta evidence. Discord must remain hidden/disabled or explicitly excluded.
Docs updated: docs/wiki/plans/task-node-production-scope.md
```

```text
Date: 2026-05-26
Environment: local deterministic Telegram webhook smoke plus operator-reported Fly dev Telegram behavior
Surface: Telegram bot
Status: amber
Evidence: Telegram bot webhook smoke passed and exercised mode selection for Discount Thinking. Operator reported repeated live Discount Thinking Telegram chats working.
Commands: npm run telegram-bot-webhook-smoke
Live user/account tested: goodalexander linked Telegram account; deterministic smoke account acct_oauth_de97b03526100b281c9c4333
Remaining blocker: Telegram is not green until at least one non-operator Telegram user links and sends a private live bot message successfully.
Docs updated: docs/wiki/plans/task-node-production-scope.md and docs/wiki/architecture/telegram-bot-chat.md
```
