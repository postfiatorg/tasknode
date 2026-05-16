# Task Node GPT Full Spec and Research Burndown

Status: draft v0.1
Date: 2026-05-15
Owner: Post Fiat product and engineering

## Purpose

This document is the research burndown and full product specification scaffold
for Task Node GPT. It is not yet the final build plan. Its job is to make every
important product, architecture, security, data, deployment, and migration
question explicit before the team starts moving code at speed.

The target product is a world-class ChatGPT-style execution app:

- Chat-first, with the interface discipline of ChatGPT.
- Account-first, with wallet operations only where a wallet is actually needed.
- Fundable by crypto and usable without a Post Fiat wallet.
- Integrated with personal tasks, context documents, rewards, and PFT activity.
- Capable of private chat and pseudonymous public profile discovery.
- Small enough to understand, serious enough to trust, and clean enough for LLMs
  and engineers to audit.

## Inputs Reviewed

- `product_spec.md` in this repository.
- `jsx_mock.jsx` and `login.jsx` in this repository.
- Local `chatgpt_postgres_spec.md` reference as database scaling inspiration
  (reviewed, but not required as a committed repo artifact).
- `pftasks/README.md`.
- `pftasks/AGENTS.md`.
- `pftasks/docs/codebase_map.md`.
- `pftasks/docs/features_and_dependencies.md`.
- `pftasks/milestones/vision_doc/vision.md`.
- `pftasks/milestones/backend_scope/tasknode_backend_scope.md`.
- `pftasks/milestones/define_user_flows/technical_spec.md`.
- `pftasks` Fly configs, package manifests, and `.env.example` files.

Note: local and Fly secrets are an input to deployment research, but secret
values should never be copied into this repo, this spec, tickets, logs, or LLM
prompts. Research should inventory secret names, ownership, and rotation status,
not secret values.

## Initial Findings

The existing `pftasks` system is a real deployed app with API, frontend, worker,
Postgres, PFTL, IPFS/Pinata, LLM providers, Langfuse, PostHog, Discord, profile,
tasks, network board, healthboard, and reward flows. It is not a blank slate.

The current product spec asks for a sharp simplification:

- Replace wallet-first authentication with account-first authentication.
- Keep wallet auth only for wallet-bound actions.
- Allow paid use without a Post Fiat wallet.
- Track chat spend per query.
- Keep prompts open source except private NFT/profile-picture prompts.
- Make the chat surface feel like ChatGPT, not like a bespoke crypto dashboard.
- Let users request personal tasks only, while still receiving routed network and
  alpha tasks inside the app.
- Consolidate Telegram and Discord chat access.
- Use Nostr for messaging-style portability instead of using PFT as a messaging
  layer.
- Preserve PFTL pointer portability for context document manifests.
- Aggressively delete or defer legacy bloat.

The main open issue is not whether the system can be built. It is where the new
clean product boundary should be drawn against the large existing `pftasks`
surface.

## Current Product Decisions

These decisions supersede older PFTasks docs unless explicitly reopened:

- The newest product spec and direct product clarifications are the source of
  truth. Older PFTasks docs are implementation references and migration context,
  not competing product authority.
- Follow `jsx_mock.jsx`. When the mock is incomplete, copy the current ChatGPT
  app pattern instead of inventing a new UX pattern.
- `login.jsx` is product input for account login, account linking, and wallet
  onboarding surfaces.
- Users can receive network and alpha tasks in the app. They cannot request
  network or alpha tasks through the normal task request path.
- Usage is billing-based, not quota-based. A user who pays more should be able
  to use more. Technical guardrails should protect users and infrastructure from
  fraud, runaway spend, provider failure, and broken jobs, not impose arbitrary
  product caps on paying users.
- Do not require maintaining a MetaMask PFTL Snap for the core PFT wallet path.
  Prefer the existing seed-based PFTL wallet/login flow if it can be made
  secure, professional, and understandable.
- External funding should support familiar crypto rails such as USDC or USDT via
  MetaMask, Phantom, deposit addresses, a processor, or per-user deposit
  accounts. The research criterion is user safety and operational security, not
  ideological purity.
- Seed storage is a first-class security design problem. Local encrypted seed
  storage, backup, recovery, delinking, relinking, and repeated test onboarding
  must be designed deliberately.

## Product Principles

1. Chat is the product surface.
   Tasks, wallet, context, profile, and settings should feel like clean side
   surfaces attached to the chat product, not separate applications.

2. Accounts are the default identity.
   Users should be able to sign in, chat, pay, and build context before they are
   forced to understand Post Fiat wallet mechanics.

3. Wallets are for wallet actions.
   PFT sending, PFT verification signatures, and PFTL pointer manifests require
   wallet authentication. Normal navigation and chat should not.

4. UX is borrowed deliberately.
   The product should copy the proven ChatGPT interaction model and the provided
   JSX mock. Novel UX is a liability unless there is a concrete reason.

5. The codebase must be smaller than PFTasks.
   Delete, defer, or isolate legacy features unless they directly support the
   new product loop.

6. Postgres-first does not mean Postgres-naive.
   Use Postgres as the system of record, but design for query budgets,
   connection pooling, read/write separation, idempotent jobs, paced backfills,
   and schema discipline from day one.

7. Private means designed, not promised.
   Private chat, private prompts, private context, and pseudonymous profiles all
   need explicit data boundaries and security reviews.

8. Provider choice is a product feature.
   Private Instant, Private Thinking, Frontier Instant, and Frontier Thinking
   should be routed by policy, cost, latency, privacy mode, and model health.

9. Everything important should be explainable to a new engineer or an LLM.
   Architecture maps, prompt contracts, data models, deploy runbooks, and
   security boundaries are part of the product.

## Engineering Principles From The Postgres Scaling Reference

The Postgres reference does not imply Task Node needs hyperscale machinery on day
one. It does imply that the system should avoid early mistakes that make scale
and reliability painful later.

Required principles:

- Protect the primary database.
  Avoid accidental read traffic on the writer, avoid write storms, and keep
  write paths idempotent.

- Avoid expensive joins in hot paths.
  Design chat, task lists, wallet summaries, and profile summaries so the common
  UI does not depend on broad multi-table joins.

- Use connection pooling from the start.
  Production should have explicit pool sizing and a PgBouncer or managed pooler
  decision before traffic grows.

- Use bounded query and transaction timeouts.
  No idle transactions, no unbounded admin queries, no long-running user-facing
  reads.

- Meter expensive endpoints and protect users from runaway spend.
  Chat, context import, verification, reward calculation, document fetch, and
  URL evidence checks should be usage-based. They need pricing, spend
  visibility, confirmation for expensive actions, idempotency, cancellation,
  circuit breakers, and fraud/abuse controls. They should not have arbitrary
  caps that block legitimate paid usage.

- Cache with stampede protection.
  Cache common read models, but use lease/lock behavior so cache misses do not
  create database or provider storms.

- Separate high-priority and low-priority workloads.
  Chat send, current user, active task list, and balance reads are high priority.
  profile generation, network aggregation, backfills, and imports are low
  priority.

- Treat schema changes as production events.
  Migrations need timeouts, backwards compatibility, safe deploy order, and
  paced backfills.

- Keep queue jobs idempotent.
  Reward payouts, verification, document imports, message sync, and chain index
  jobs must be safe to retry.

- Monitor query shapes, not just services.
  Healthboard should track slow queries, queue lag, LLM errors, provider
  saturation, chain index lag, cache hit rate, and external integration health.

## Known Product and Architecture Decision Gates

These are not blockers. They are decision gates.

1. PFTL wallet path vs external crypto funding rails.
   PFT wallet operations should use the seed-based PFTL wallet flow rather than
   require ongoing MetaMask Snap maintenance. Chat balance funding can still
   accept USDC, USDT, or similar assets through MetaMask, Phantom, deposit
   addresses, a payment processor, or per-user deposit accounts. Research must
   choose the safest, least error-prone funding flow.

2. Local seed storage and delinking.
   The preferred direction is local seed-based wallet/login behavior, but it
   needs a professional storage design: encryption, backup, recovery, device
   migration, local wipe, production delink/relink for testability, and clear
   rules for balances attached to seed-derived addresses.

3. Open-source prompts vs Langfuse runtime prompt system.
   The new spec prefers open prompts and less Langfuse complexity. Current
   `pftasks` still includes Langfuse prompt sync and trace surfaces.

4. Nostr required vs Nostr de-scoped.
   The new spec wants Nostr integration. The older lean backend scope explicitly
   de-scoped Nostr. Research must determine the smallest useful Nostr role.

5. Personal task requests vs routed network/alpha tasks.
   The app should allow users to request personal tasks only. Network and alpha
   tasks still appear in the app when routed to the user by the director/network
   board system.

6. Eight reward cap vs older four-task/day guidance.
   The new spec says users should be capped at eight task rewards per day. Older
   vision docs describe four meaningful tasks/day. Decide the product rule and
   enforce it consistently.

7. Private NFT prompts vs open-source repo.
   Most prompts should be public. NFT/profile-picture prompts are explicitly
   private and should not be charged to users. Research must define storage,
   deployment, review, and audit controls.

8. Private repo now vs likely open-source later.
   The repository is currently private under `postfiatorg`. The code should be
   written as if it may become open source, which affects secret handling,
   licensing, prompt visibility, and dependency choices.

## Research Status Legend

- Not started: no meaningful investigation yet.
- Discovery: source files and product context have been identified.
- Decision needed: enough context exists to pick a direction.
- Spec ready: decision, acceptance criteria, and implementation shape are clear.
- Implementable: ready to convert into milestones and tickets.

## Research Burndown

| ID | Area | Status | Output |
| --- | --- | --- | --- |
| R00 | Source-of-truth versioning | Discovery | Product decision log and superseded-assumption map |
| R01 | Existing PFTasks inventory and deletion line | Discovery | Keep/delete/defer matrix |
| R02 | UX parity with ChatGPT-style mock | Discovery | Screen inventory, ChatGPT references, and component map |
| R03 | Auth and account model | Spec ready | `auth_account_spec.md` |
| R04 | Wallet custody and transaction signing | Not started | Seed storage and PFTL wallet architecture decision |
| R05 | Crypto funding and spend ledger | Not started | Usage-based billing ledger and top-up architecture |
| R06 | Message storage and chat history | Discovery | Scalable chat schema and retention model |
| R07 | Model routing and provider policy | Not started | Provider router, privacy, cost, and fallback spec |
| R08 | Prompt architecture | Discovery | Open prompt repo strategy and private prompt exception |
| R09 | Jobs-style default assistant behavior | Not started | System prompt contract and safety/product review |
| R10 | Context document system | Discovery | Google Docs, Notion, PFT context, cache, and edit spec |
| R11 | PFTL pointer portability | Discovery | v4 pointer usage and manifest lifecycle |
| R12 | Personal task generation | Discovery | Request, generation, accept/refuse, history contract |
| R13 | Task evidence and verification | Discovery | Evidence type matrix and verification workers |
| R14 | Rewards, payouts, and daily caps | Discovery | Reward cap, payout job, and balance top-up spec |
| R15 | Network board and director routing | Discovery | Director document and routed task architecture |
| R16 | Alpha task and alpha privacy model | Discovery | Opt-in alpha sharing and privacy controls |
| R17 | Pseudonymous profile and discovery | Discovery | Public/private profile model and discoverability rules |
| R18 | Hive mind refactor | Discovery | Keep/delete/rebuild decision |
| R19 | Telegram, Discord, and bot consolidation | Discovery | Account linkage and bot compatibility spec |
| R20 | Nostr integration | Not started | Minimal Nostr role and relay/key strategy |
| R21 | Motivation, brainstorming, context edit modules | Discovery | Module contracts and UI integration plan |
| R22 | NFT/profile-picture generation | Discovery | Private prompt handling and no-charge flow |
| R23 | Data model and migration strategy | Discovery | New schema plan and legacy migration map |
| R24 | Postgres reliability and scale | Discovery | DB operating model and query guardrails |
| R25 | Schema migration and backfill discipline | Discovery | Migration rules and rollout checklist |
| R26 | Security, privacy, and secrets | Discovery | Threat model, secret inventory, and custody review |
| R27 | Abuse, sybil, usage, and policy | Discovery | Abuse controls and enforcement policy |
| R28 | Observability and healthboard | Discovery | Service, queue, provider, and DB health spec |
| R29 | Fly deployment and environments | Discovery | Dev/prod deploy topology and secret map |
| R30 | Test strategy | Discovery | Unit, integration, e2e, load, and security test plan |
| R31 | Documentation and LLM readability | Discovery | Docs map and repo hygiene standard |
| R32 | Open-source readiness | Not started | License, secret, prompt, and dependency audit |
| R33 | Migration from PFTasks | Discovery | Data, feature, and traffic migration plan |
| R34 | Product analytics and KPIs | Discovery | Event taxonomy and dashboard requirements |

## Feature Research Briefs

### R00: Source-of-Truth Versioning

Research questions:

- How do we keep the newest product spec and direct founder clarifications as
  the living source of truth?
- Which old PFTasks docs are useful as implementation references but explicitly
  non-normative?
- How do we record product decisions so old assumptions do not re-enter the
  build through copied code?
- Which remaining decision gates require founder/product decision before
  implementation?

Sources:

- `tasknodeofficial/product_spec.md`.
- `tasknodeofficial/jsx_mock.jsx`.
- `pftasks/AGENTS.md`.
- `pftasks/milestones/vision_doc/vision.md`.
- `pftasks/milestones/backend_scope/tasknode_backend_scope.md`.

Deliverable:

- A source-of-truth log with dated product decisions and superseded assumptions.
- A stable "build against this" spec version.

Acceptance criteria:

- No engineer has to infer whether an older PFTasks assumption overrides the
  latest Task Node GPT decision. It does not unless explicitly reinstated.

### R01: Existing PFTasks Inventory and Deletion Line

Research questions:

- Which current features directly support Task Node GPT?
- Which features should be copied, migrated, reimplemented, or deleted?
- Which code paths are risky because they combine unrelated concerns?
- What is the smallest credible production baseline?

Sources:

- `pftasks/docs/codebase_map.md`.
- `pftasks/docs/features_and_dependencies.md`.
- `pftasks/api/src/routes`.
- `pftasks/api/src/services`.
- `pftasks/worker/src/jobs`.
- `pftasks/app/src/pages`.

Deliverable:

- Keep/delete/defer matrix across API, worker, frontend, prompts, migrations,
  external systems, and docs.

Acceptance criteria:

- The new repo does not inherit accidental legacy complexity.

### R02: UX Parity With ChatGPT-Style Mock

Research questions:

- What exact surfaces from `jsx_mock.jsx` are first release requirements?
- Which mock surfaces need real data on day one?
- Which should be static, hidden, or staged?
- How should mobile, keyboard, accessibility, loading, and error states work?
- Where the mock is incomplete, what does the current ChatGPT app do?
- What exact login, account-linking, wallet-onboarding, and wallet-delink UX is
  implied by `login.jsx` and the existing seed-based wallet flow?

Sources:

- `tasknodeofficial/jsx_mock.jsx`.
- `tasknodeofficial/login.jsx`.
- Existing `pftasks/app/src/components/chat`.
- Existing `pftasks/app/src/components/dashboard`.

Deliverable:

- Screen-by-screen product requirements, ChatGPT reference behavior notes, and
  component map.

Acceptance criteria:

- The first deployed app feels like the mock and does not expose legacy
  navigation sprawl.
- Engineers copy proven ChatGPT interaction patterns instead of inventing new
  product primitives.

### R03: Auth and Account Model

Research questions:

- Which auth providers are required at launch: email, GitHub, X, Discord,
  Telegram, wallet signature?
- Can a user chat and pay without a Post Fiat wallet?
- What is the canonical user identity when multiple providers are linked?
- How does account deletion or provider unlinking affect wallet history?
- What is the session model for web, Telegram, and Discord?
- What production-safe delink/relink function is needed so wallet onboarding can
  be repeatedly tested without corrupting balances or identity history?
- How does a user "get PFT the same way as before" in the new account-first UX?

Sources:

- `pftasks/api/src/routes/auth.js`.
- `pftasks/api/src/services/auth_service.js`.
- `pftasks/api/src/routes/account.js`.
- `pftasks/api/src/lib/providers.js`.
- Existing auth tests in `pftasks/api/src/routes/__tests__`.
- `tasknodeofficial/auth_account_spec.md`.

Deliverable:

- Account model, provider linking rules, session rules, wallet-link constraints,
  and production delink/relink operations.

Acceptance criteria:

- Login friction is low, but identity collisions and wallet ownership are
  handled deliberately.

### R04: Wallet Custody and Transaction Signing

Research questions:

- How exactly did the old seed-based login and wallet flow store, encrypt,
  recover, and use seeds?
- Can that flow be made the default PFTL wallet path without maintaining the
  PFTL MetaMask Snap?
- What exactly is an "unlock transaction" in the new architecture?
- Which operations require wallet unlock?
- How are locally stored seeds encrypted, rotated, backed up, migrated across
  devices, wiped, delinked, relinked, and audited?
- Can the product support one wallet per login without losing legacy data?
- What user warnings and confirmations prevent a user from losing access to a
  seed-derived address with a real balance?

Sources:

- `pftasks/api/src/routes/wallets.js`.
- `pftasks/api/src/services/wallet_service.js`.
- `pftasks/worker/src/jobs/reward_task`.
- `pftasks/docs/reward_wallets.md` if present.
- Existing wallet lifecycle tests.

Deliverable:

- Seed storage decision memo, transaction signing boundary diagram, and
  delink/recovery runbook.

Acceptance criteria:

- Users understand when they are signing and how to preserve access to balances.
  The system is auditable and does not create avoidable custody risk.

### R05: Crypto Funding and Spend Ledger

Research questions:

- Which currencies and chains are accepted for top-up at launch?
- Is top-up handled by direct wallet connect, per-user deposit address, per-user
  USDC/USDT account, third-party processor, or manual admin credit?
- Is MetaMask/Phantom used only for external funding rails while PFT wallet
  actions stay on the seed-based PFTL path?
- How is per-query spend computed and displayed?
- How are failed, retried, streamed, or cancelled LLM calls billed?
- How do task rewards credit chat balances?
- What ledger tables make credits, debits, refunds, and rewards auditable?
- What user-facing spend controls prevent accidental runaway charges without
  imposing arbitrary product usage caps on paying users?

Sources:

- Current reward and wallet tables in PFTasks migrations.
- `pftasks/worker/src/jobs/reward_task`.
- `pftasks/api/src/routes/transactions.js`.
- `pftasks/app/src/components/dashboard/DashboardWalletColumn.jsx`.

Deliverable:

- Credit ledger and billing policy spec.
  The policy must be usage-based, not quota-based.

Acceptance criteria:

- Every balance shown in the UI can be reconciled from ledger entries.
- Paying users are not blocked by arbitrary caps; they are protected by clear
  pricing, confirmations, and fraud controls.

### R06: Message Storage and Chat History

Research questions:

- What is the conversation/thread/project equivalent in Task Node GPT?
- Which messages are stored plaintext, encrypted, redacted, or ephemeral?
- What retention policy supports private chat?
- How should chat history be paginated and searched?
- How do Telegram/Discord messages merge with web chat?
- What read models are needed to avoid hot-path expensive joins?

Sources:

- `pftasks/api/src/routes/chat`.
- `pftasks/api/src/routes/messages.js`.
- `pftasks/api/src/services/message_service.js`.
- `pftasks/app/src/hooks/useChatFlow.js`.
- Local `chatgpt_postgres_spec.md` reference, if retained.

Deliverable:

- Chat schema, retention, encryption, pagination, and read-model spec.

Acceptance criteria:

- Chat feels instant, scales sanely, and has a clear privacy story.

### R07: Model Routing and Provider Policy

Research questions:

- What exact model IDs map to Private Instant, Private Thinking, Frontier
  Instant, and Frontier Thinking?
- What does "ZDR" mean contractually for OpenRouter providers?
- Which prompts or payloads may be sent to frontier providers?
- How are latency, cost, failure, model health, and privacy mode balanced?
- What fallback behavior is safe when private providers fail?

Sources:

- `pftasks/api/src/lib/llm` or equivalent provider modules.
- `pftasks/api/.env.example` LLM provider configuration.
- `pftasks/worker/.env.example`.
- Current OpenRouter/OpenAI provider code.

Deliverable:

- Model router policy, provider contract, and fallback matrix.

Acceptance criteria:

- Users can choose privacy/performance modes without hidden data leakage.

### R08: Prompt Architecture

Research questions:

- Which prompts become open source files?
- Which prompt files are obsolete?
- How is prompt version recorded for each LLM call?
- Is Langfuse removed, kept for traces only, or kept for runtime prompt sync?
- How are private NFT prompts stored and deployed without accidental commit?

Sources:

- `pftasks/prompts`.
- `pftasks/milestones/prompt_library/langfuse_prompts_latest.json`.
- `pftasks/shared/llm/langfuse_prompts.js`.

Deliverable:

- Prompt registry and private prompt exception policy.

Acceptance criteria:

- Prompt behavior is reviewable, reproducible, and not coupled to an opaque
  production dashboard.

### R09: Jobs-Style Default Assistant Behavior

Research questions:

- What does "the app should feel like speaking to Steve Jobs" mean in concrete
  assistant behavior?
- Where is the line between direct coaching and unsafe impersonation,
  overconfidence, or abusive tone?
- How does the default assistant adapt across personal chat, tasks, modules,
  and context edits?
- How are refusal, uncertainty, and high-stakes topics handled?

Sources:

- `product_spec.md`.
- Existing ODV and module prompts.
- Current chat transcript examples if available.

Deliverable:

- Default assistant behavior contract and prompt acceptance tests.

Acceptance criteria:

- The assistant is direct, useful, and tasteful without becoming erratic or
  legally/brand risky.

### R10: Context Document System

Research questions:

- What is the canonical context document format?
- How are values, strategies, tactics, history, and preferences represented?
- How are Google Docs share links imported without Google login?
- What Notion integration path is viable for shared documents?
- Can context docs be edited natively and saved without a PFT transaction?
- When does a user explicitly ink a PFT transaction for a context manifest?
- What is cached for portability?

Sources:

- `pftasks/api/src/routes/context.js`.
- `pftasks/api/src/services/context_service.js`.
- Existing context editor frontend files.
- PFDocs PFT pointer/cache behavior.

Deliverable:

- Context source, cache, edit, manifest, and permissions spec.

Acceptance criteria:

- Context is useful before wallet setup and portable when the user chooses to
  commit it.

### R11: PFTL Pointer Portability

Research questions:

- Which v4 pointer types are required for context, submissions, and manifests?
- What remains on-chain vs in Postgres vs IPFS?
- How do we avoid spamming the Post Fiat RPC?
- How are pointer transactions indexed, cached, and verified?

Sources:

- `pftasks/milestones/understand_proto_spec/proto-spec-v4.md`.
- `pftasks/api/src/routes/pointers.js`.
- `pftasks/api/src/services/tx_sync_service.js`.
- `pftasks/worker` tx sync jobs.

Deliverable:

- Pointer lifecycle and indexer spec.

Acceptance criteria:

- PFTL is used for durable attestations, not as a general database or chat bus.

### R12: Personal Task Generation

Research questions:

- What makes a good personal task in the new product?
- Does the system generate a task after a dialog, a chat intent classifier, or a
  button action?
- How does refused task history shape future tasks?
- How does the task avoid repetition and fit the current to-do list?
- What task states should remain visible in the simplified UI?

Sources:

- `pftasks/api/src/routes/tasks`.
- `pftasks/api/src/services/task_request_generation_queue.js`.
- `pftasks/api/src/services/task_history_service.js`.
- Existing task prompt files.

Deliverable:

- Personal task lifecycle and generation contract.

Acceptance criteria:

- The product generates fewer, better tasks and makes the next action obvious.

### R13: Task Evidence and Verification

Research questions:

- Which evidence types launch: screenshot, URL, public GitHub commit, code blob,
  text report, video, attestation?
- Which evidence types are automatically verifiable today?
- What is the false-positive and false-negative risk for each evidence type?
- How are URL fetches protected against SSRF and abuse?
- How are private artifacts handled?

Sources:

- `pftasks/api/src/services/verification_service.js`.
- `pftasks/api/src/services/document_evidence_service.js`.
- `pftasks/api/src/routes/tasks/submission_routes.js`.
- Existing verification tests.

Deliverable:

- Evidence matrix, verification worker contracts, and abuse controls.

Acceptance criteria:

- Verification is good enough to make rewards credible without pretending it is
  perfect.

### R14: Rewards, Payouts, and Daily Caps

Research questions:

- Is the cap eight rewards/day, four tasks/day, or a tiered policy?
- Does task completion credit chat balance immediately or after verification?
- How does daily payout interact with chat spend credits?
- Which wallet pays rewards?
- What happens when reward wallets are underfunded?
- What retry, idempotency, and audit controls are required?

Sources:

- `pftasks/worker/src/jobs/reward_task`.
- `pftasks/api/src/services/profile_service.js`.
- Reward migrations and reward wallet docs.
- Fly worker secrets inventory.

Deliverable:

- Reward cap, balance credit, and payout operations spec.

Acceptance criteria:

- Users can trust rewards, and operators can reconcile every payout.

### R15: Network Board and Director Routing

Research questions:

- Is the current network board refactored or replaced?
- What is the director document format?
- Should director docs be public Gists only, or also Google Docs?
- How are existing tasks, code surface, and intelligence reports combined?
- How are tasks routed to individuals with authorized PFT wallets?
- What is the officer/admin UI?

Sources:

- `pftasks/api/src/services/network_task_orchestrator.js`.
- `pftasks/api/src/services/network_task_context_provider.js`.
- `pftasks/api/src/services/board_task_selector.js`.
- `pftasks/api/src/services/network_book_service.js`.
- Network board migrations.

Deliverable:

- Network task routing architecture and director surface requirements.

Acceptance criteria:

- Users can receive, view, accept/refuse, complete, and be rewarded for routed
  network/alpha tasks in the app, but they cannot request them through the normal
  personal task request path.

### R16: Alpha Task and Alpha Privacy Model

Research questions:

- How does a user opt into providing alpha without revealing identity?
- What alpha can be shared with community or models?
- What alpha is private, delayed, aggregated, or redacted?
- How is MNPI avoidance represented in UX and audit logs?
- How are public equities linked to user work streams?

Sources:

- Existing alpha prompts.
- `pftasks/api/src/lib/alpha_tickers.js`.
- `pftasks/worker` alpha scoring jobs.
- Profile ticker synthesis code.

Deliverable:

- Alpha contribution, redaction, and compliance guardrail spec.

Acceptance criteria:

- Alpha capture is useful without casually creating privacy or compliance risk.

### R17: Pseudonymous Profile and Discovery

Research questions:

- What is public by default?
- What can users hide?
- What profile artifacts are mimetic and useful without doxxing the user?
- How is public profile discoverability controlled?
- How do profiles link to PFT balances, completed tasks, tickers, NFTs, and
  external accounts?

Sources:

- `pftasks/api/src/routes/profile.js`.
- `pftasks/api/src/services/profile_service.js`.
- `pftasks/app/src/components/profile`.
- `pftasks/api/src/services/leaderboard_service.js`.

Deliverable:

- Public/private profile data contract and discoverability UX.

Acceptance criteria:

- Users can flex credible work and find useful collaborators without losing
  pseudonymity.

### R18: Hive Mind Refactor

Research questions:

- What does "hive mind" mean in the new product?
- Which existing Hive Mind surfaces are useful?
- Should discovery be profile-first, task-first, collaborator-first, or report-
  first?
- What should be deleted from the existing implementation?

Sources:

- `pftasks/api/src/routes/hive_mind.js`.
- `pftasks/api/src/services/hive_mind_user_service.js`.
- `pftasks/app` Hive Mind pages/components.
- Network context and Network Book services.

Deliverable:

- Hive Mind product definition and refactor/deletion plan.

Acceptance criteria:

- The feature helps users find leverage, not browse a confusing social dashboard.

### R19: Telegram, Discord, and Bot Consolidation

Research questions:

- What can a user do from Telegram or Discord: chat, request task, accept task,
  submit evidence, receive reminders, check balance?
- How are chat identities linked to web accounts?
- Which Discord logic currently lives in SPRS or PFTasks?
- How do existing user bots integrate with the new model?
- What sample bot app should be provided?

Sources:

- `pftasks/api/src/routes/discord_integration.js`.
- `pftasks/worker` Discord jobs.
- SPRS Discord integration, if approved for review.
- Telegram app surface, if available.

Deliverable:

- Messaging integration map and bot compatibility spec.

Acceptance criteria:

- Mobile/chatbot use feels like the same account, not a second product.

### R20: Nostr Integration

Research questions:

- What exact data should Nostr carry: messages, profile updates, context
  manifests, public alpha, or identity proofs?
- Which relays are used?
- How are Nostr keys generated, linked, rotated, and recovered?
- How does Nostr reduce RPC spam?
- What does the product do if relays are unavailable?

Sources:

- PFDocs Nostr integration spec.
- Existing messaging and inbox code.
- PFTL pointer/indexing code.

Deliverable:

- Minimal Nostr integration decision and fallback strategy.

Acceptance criteria:

- Nostr adds portability or federation without multiplying product complexity.

### R21: Motivation, Brainstorming, and Context Edit Modules

Research questions:

- Are these separate modules, chat modes, slash commands, or model presets?
- How are module outputs stored and billed?
- How does each module use context documents and task history?
- What is the difference between brainstorming and normal chat?
- Can context document edits be applied natively and reviewed before save?

Sources:

- `pftasks/api/src/routes/module_chat.js`.
- `pftasks/api/src/services/module_chat_service.js`.
- `pftasks/app/src/components/modules`.
- Existing module report migrations.

Deliverable:

- Module contract and UI integration spec.

Acceptance criteria:

- Modules feel like focused tools inside chat, not a separate maze.

### R22: NFT/Profile-Picture Generation

Research questions:

- What NFT/profile-picture generation remains in scope?
- How are private prompts deployed and audited without entering git?
- Why are users not charged for NFT generation, and what fraud/spend controls
  apply?
- Where are generated images stored?
- How are ownership, offers, and profile display linked?

Sources:

- `pftasks/api/src/routes/nfts.js`.
- `pftasks/api/src/services/nft_service.js`.
- `pftasks/api/src/services/nft_offer_service.js`.
- `pftasks/app/src/components/profile/Nft*`.

Deliverable:

- NFT generation, private prompt, storage, and abuse policy spec.

Acceptance criteria:

- The feature can exist without leaking private prompts or creating an open
  generation faucet.

### R23: Data Model and Migration Strategy

Research questions:

- Which existing tables are kept?
- Which tables are new read models or ledgers?
- Which old fields should be deprecated but preserved for migration?
- Can account identity, wallet identity, and chat billing be represented cleanly?
- What migration order supports zero or low downtime?

Sources:

- `pftasks/api/migrations`.
- Production schema using read-only credentials when explicitly needed.
- Current API service queries.

Deliverable:

- Entity relationship model, migration plan, and compatibility strategy.

Acceptance criteria:

- The schema supports the new product without encoding old product confusion.

### R24: Postgres Reliability and Scale

Research questions:

- What are the expected hot tables and hot queries?
- Which requests are read-heavy vs write-heavy?
- Where do we need read replicas, materialized views, summary tables, or caches?
- Do we need PgBouncer or managed pooling before launch?
- What query budgets should each endpoint obey?
- How do we prevent retry storms from model/provider failures?

Sources:

- Local `chatgpt_postgres_spec.md` reference, if retained.
- Existing `pftasks` DB pool configuration.
- Current API route query patterns.
- Healthboard query catalog.

Deliverable:

- Database operating model and query budget checklist.

Acceptance criteria:

- Postgres remains boring under normal growth and degrades predictably under
  spikes.

### R25: Schema Migration and Backfill Discipline

Research questions:

- Which schema changes are required for account-first auth, billing, messages,
  and context documents?
- Which migrations can lock large tables?
- Which backfills need pacing and resumability?
- How are migration scripts tested against snapshots?

Sources:

- `pftasks/api/scripts/migrate.js`.
- Current migration conventions.
- Existing large tables in production, if inspected with read-only credentials.

Deliverable:

- Migration checklist and backfill runbook.

Acceptance criteria:

- A bad migration cannot casually take the production app down.

### R26: Security, Privacy, and Secrets

Research questions:

- What are the trust boundaries between browser, API, worker, DB, PFTL, IPFS,
  LLM providers, PostHog, Discord, Telegram, and Nostr?
- Which secrets exist locally and in Fly?
- Which secrets are overbroad, stale, or duplicated?
- Where can user content leave the system?
- How are private chat and context protected from staff, providers, logs, and
  analytics?
- What is the XSS and supply-chain risk if wallet signing happens in-browser?

Sources:

- `.env.example` files.
- Fly secret name inventory.
- Current auth/wallet/context/message code.
- Deployment configs.

Deliverable:

- Threat model, secret inventory, privacy matrix, and rotation plan.

Acceptance criteria:

- The repo can become open source without leaking operational secrets or
  revealing private prompt material.

### R27: Abuse, Sybil, Usage, and Policy

Research questions:

- What abuse paths exist for free chat, paid chat, task rewards, NFT generation,
  context import, URL verification, and bot integrations?
- Which controls are spend controls, fraud controls, provider/infrastructure
  circuit breakers, or reward-farming controls?
- How do we avoid arbitrary product usage caps for legitimate paying users?
- How is the eight-reward cap enforced?
- What user-facing message appears when a cap is hit?
- Which sybil signals are invisible, appealable, or review-only?

Sources:

- `pftasks/api/src/services/task_access_policy_service.js`.
- Existing sybil scoring jobs/tests.
- Reward and profile scoring code.

Deliverable:

- Usage, abuse, sybil, and enforcement architecture.

Acceptance criteria:

- The system discourages farming and accidental runaway spend without punishing
  legitimate high-usage paying users by accident.

### R28: Observability and Healthboard

Research questions:

- What should operators see first when chat, rewards, DB, PFTL, or LLM providers
  degrade?
- Which checks are synthetic vs real traffic?
- What data is safe to expose in maintainer dashboards?
- How do we detect stuck jobs, provider degradation, chain lag, and DB pressure?

Sources:

- `pftasks/api/src/routes/healthboard.js`.
- `pftasks/api/src/services/healthboard_service.js`.
- `pftasks/worker/src/jobs/healthboard_snapshot.js`.
- Existing deploy health checks.

Deliverable:

- Healthboard v2 scope and alerting spec.

Acceptance criteria:

- Operators can tell the difference between provider failure, DB pressure,
  wallet funding failure, and product bugs quickly.

### R29: Fly Deployment and Environments

Research questions:

- What are the new Fly app names for dev and production?
- Is the new repo deployed independently or does it replace `pftasks` apps?
- Which secrets are needed by API, frontend, worker, signer, and bot services?
- How are migrations run safely?
- What is the rollback plan?
- What domains should point to dev and production?

Sources:

- `pftasks/api/fly.toml`.
- `pftasks/app/fly.toml`.
- `pftasks/worker/fly.toml`.
- `pftasks/docs/deploy_instructions.md`.

Deliverable:

- Deploy topology, secret map, and runbook.

Acceptance criteria:

- Dev/prod can be deployed and validated without tribal knowledge.

### R30: Test Strategy

Research questions:

- What are the must-not-break product loops?
- What tests are needed for prompt routing and model fallback?
- How do we test wallet signing without risking real funds?
- What load tests protect chat and message storage?
- What e2e tests validate account, chat, task, reward, context, and payment
  flows?

Sources:

- Existing API and frontend tests.
- Fly dev environment.
- Current CI scripts, if any.

Deliverable:

- Test pyramid and release gate checklist.

Acceptance criteria:

- The team can refactor aggressively without losing the primary user journey.

### R31: Documentation and LLM Readability

Research questions:

- What docs must exist at repo root?
- What architecture diagrams are needed?
- What examples help LLMs navigate the code safely?
- How are product decisions recorded?
- How do we keep docs short enough to remain accurate?

Sources:

- Existing PFTasks docs.
- This `full_spec.md`.
- Codebase map patterns.

Deliverable:

- Documentation map and contribution standard.

Acceptance criteria:

- A new engineer or LLM can identify the system boundaries within minutes.

### R32: Open-Source Readiness

Research questions:

- What license is appropriate?
- Which files cannot be public?
- Are third-party copied docs or articles excluded from commits?
- Are prompts safe to publish?
- Are local scripts safe for public contributors?
- Which security disclosures and responsible use notes are required?

Sources:

- Repo files.
- Dependency licenses.
- Prompt directory.
- Secret and private prompt inventory.

Deliverable:

- Open-source readiness checklist.

Acceptance criteria:

- Making the repo public later is a planned operation, not a scramble.

### R33: Migration From PFTasks

Research questions:

- Is Task Node GPT a rewrite, a port, or an extraction?
- Which deployed data must migrate?
- Which users should see the new app first?
- Is there a dual-write period?
- What is the rollback path if the new app fails?
- What legacy URLs and bot integrations must be preserved?

Sources:

- Current `pftasks` DB and Fly deploys.
- `pftasks` route map.
- User workflow docs.

Deliverable:

- Migration and rollout plan.

Acceptance criteria:

- Existing users and rewards are not broken by the redesign.

### R34: Product Analytics and KPIs

Research questions:

- What proves the product is working?
- Which events are needed for activation, retention, task completion, paid usage,
  context quality, and alpha contribution?
- What must not be tracked because of privacy promises?
- How do analytics respect private chat mode?

Sources:

- Existing PostHog integration.
- `pftasks/app/src/analytics`.
- Product goals in `product_spec.md`.

Deliverable:

- KPI tree and privacy-aware event taxonomy.

Acceptance criteria:

- The team can measure product quality without violating the product's privacy
  posture.

## Proposed Milestone Sequence

### M0: Research Lock

Goal: convert this burndown into decision memos and an implementation-ready
scope.

Outputs:

- Contradiction log.
- Keep/delete/defer inventory.
- Security and secret inventory.
- Database operating model.
- MVP scope.

Exit criteria:

- No P0 architecture ambiguity remains for auth, wallet custody, billing,
  message storage, context docs, task generation, and deploy topology.

### M1: Clean App Baseline

Goal: stand up a minimal deployable app that matches the mock shell.

Outputs:

- Web shell with ChatGPT-style layout.
- Account login skeleton.
- Runtime config.
- Fly dev/prod deployment pipeline.
- Health and version endpoints.

Exit criteria:

- The app deploys cleanly and exposes no legacy navigation bloat.

### M2: Account, Chat, Spend Ledger

Goal: let an account user chat with model routing and auditable spend.

Outputs:

- Account auth.
- Conversation/message storage.
- Model router.
- Spend ledger.
- Basic top-up placeholder or admin credit path.

Exit criteria:

- A user can sign in, send chat, see history, and see debits/credits.

### M3: Context Documents

Goal: make context useful without wallet friction and portable with wallet
commitment.

Outputs:

- Native context editor.
- Google Docs share-link importer.
- Notion research decision.
- Context cache.
- Optional PFTL pointer manifest flow.

Exit criteria:

- Context improves chat and task generation, and the wallet path is explicit.

### M4: Personal Tasks

Goal: implement the personal execution loop.

Outputs:

- Task request intent/router.
- Task generation.
- Accept/refuse.
- Evidence submission.
- Verification worker.

Exit criteria:

- A user can get one high-quality personal task, complete it, and receive a
  verification result.

### M5: Rewards and Wallet Operations

Goal: connect verified execution to PFT or chat-balance rewards.

Outputs:

- Reward cap enforcement.
- Daily reward job.
- Wallet signing/custody decision implemented.
- Payout audit log.

Exit criteria:

- Rewards are idempotent, capped, visible, and reconcilable.

### M6: Profile, Discovery, and Hive Mind

Goal: make useful pseudonymous identity real.

Outputs:

- Private/public profile.
- Discoverability settings.
- Work showcase.
- Hive Mind refactor or replacement.

Exit criteria:

- Users can show credible work and discover collaborators safely.

### M7: Messaging Integrations and Bots

Goal: unify web, Telegram, Discord, and bot usage.

Outputs:

- Account linkage.
- Chat bridge.
- Notifications.
- Sample bot integration.
- Nostr decision implemented if included.

Exit criteria:

- Messaging channels feel like extensions of the same account.

### M8: Hardening and Open-Source Readiness

Goal: prepare the codebase for pride, audit, and public inspection.

Outputs:

- Threat model complete.
- Load and failure tests.
- Docs map complete.
- License and open-source readiness review.
- Secret rotation plan.

Exit criteria:

- The repo can be shown to serious engineers without caveats about obvious
  sloppiness.

## Immediate Next Research Steps

1. Produce the source-of-truth decision log.
2. Inventory PFTasks feature surfaces into keep/delete/defer.
3. Decide wallet custody and funding architecture before implementing billing.
4. Draft the chat/message schema with Postgres query budgets.
5. Draft the account and provider linking model.
6. Define the MVP surface from the mock.
7. Inventory Fly and local secret names without recording values.
8. Draft the deployment topology for `tasknodeofficial`.
9. Turn this research burndown into implementation milestones only after the
   major decision gates are closed.

## Non-Goals For The First Implementation Pass

- Rebuilding every PFTasks feature.
- Recreating every network board and Hive Mind surface before the personal loop
  works.
- Building a bespoke database scaling system before real traffic requires it.
- Adding new external providers without a clear product reason.
- Letting prompt dashboards become the source of truth.
- Shipping private chat without a clear data-retention and provider-routing
  policy.

## Definition of World-Class For This Product

World-class does not mean maximum feature count. For Task Node GPT it means:

- The first screen makes the next useful action obvious.
- A serious user can trust the privacy, wallet, and billing boundaries.
- A serious engineer can trace data and money movement end to end.
- The database survives normal growth because hot paths are designed, not
  discovered during incidents.
- Prompts and model routing are explicit product assets.
- Rewards are credible because verification and abuse controls are visible in
  the architecture.
- The codebase is small, modular, documented, and resistant to accidental
  complexity.
