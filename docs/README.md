# Task Node Official Docs

This folder is the engineering boot path for Task Node Official. It should let a
new engineer understand what this repo is, how to run it, what is live, and what
is intentionally not live yet.

## Read Order

1. `wiki/index.md`
   App Help wiki index and source-of-truth map.

2. `wiki/architecture/bootup.md`
   Local setup, dev server, smoke tests, guarded Fly deploy, env/secrets, and
   common failure checks.

3. `wiki/architecture/current-system.md`
   Current repo layout, runtime surfaces, API contracts, enabled features,
   disabled features, and the near-term build path.

4. `wiki/architecture/deployment.md`
   Local Docker dev, Fly release deployment paths, durable stores, secrets, and
   background process guardrails.

5. `wiki/architecture/database.md`
   Target Postgres architecture for accounts, linked identities, context,
   chat, billing, deposits, task projections, pgvector retrieval, and JSON
   runtime-store migration.

6. `wiki/architecture/task-async-engine.md`
   PFTL-native task engine, wallet roles, pointer lifecycle, worker queues, and
   portability target for Codex/CLI clients.

7. `wiki/architecture/task-lifecycle.md`
   Human-readable lifecycle replay from request through reward.

8. `wiki/architecture/task-review-reward-worker.md`
   Verification requests, evidence review, reward scoring, and terminal reward
   publication.

9. `wiki/architecture/ethereum-deposit-rpc.md`
   Account-scoped Ethereum mainnet deposit addresses for ETH, USDC, and USDT
   top-ups, including custody boundaries and sync behavior.

10. `wiki/architecture/user-observability-logging.md`
   Identity-vector logging spec for user, wallet, task, reward, memory, Hive,
   Telegram, and usage investigations.

11. `../full_spec.md`
   Product/architecture source of truth and active burndown.

12. `../auth_account_spec.md`
   Auth, provider linking, wallet claim, email login, and delink/relink design.

13. `wiki/architecture/auth-wallet-boundary.md`
   Concrete implementation guardrails for wallet auth UX, session refresh,
   wallet proof, local vault state, and regression coverage.

14. `wiki/architecture/resettable-signup-testing.md`
   Repeatable QA workflow for email signup, identity reset, faucet eligibility,
   and top-up state preservation.

15. `../whip_context.md`
   Automation handoff instructions and whip shutdown guardrails.

## Source Of Truth Rules

- The latest user clarification plus `full_spec.md` supersede older PFTasks
  documents.
- `product_spec.md` is important historical/product input, but it is raw and
  contains older assumptions. Prefer `full_spec.md` for current decisions.
- PFTasks and PFDocs are implementation references, not product authority.
- JSX mocks are canonical where they exist. When a mock is missing, match the
  current ChatGPT interaction pattern and keep the UI quiet and practical.

## Documentation Gaps To Fill

These docs are intentionally a first spine, not a completed handbook.

- `ARCHITECTURE.md`: durable app architecture, boundaries, and data flow.
- `API_CONTRACTS.md`: endpoint-by-endpoint request/response contracts.
- `SECURITY.md`: broader seed handling, OAuth, email login, provider keys,
  retention, logging, and supply-chain policy.

## Doc Review Checklists

Every wiki page, engineering doc, and prompt file under `docs/` and `prompts/`
ends with a **Reviewer To Do List** checklist covering memory efficiency, code
quality, coherence, bloat, and security. Use these when verifying implementation
against doc claims.

## Reviewer To Do List

Review implementation against this document (README). Mark each item when verified.

### Memory Efficiency
- [ ] Operational paths use checkpoints, caches, or bounded batch sizes.

### Code Quality
- [ ] Commands, env vars, and file paths verified against repo.

### Coherence
- [ ] Doc aligns with wiki and spec docs for same topic.

### Bloat
- [ ] Engineering doc scoped to its audience; defers product detail to wiki.

### Security
- [ ] No secrets committed; custody boundaries explicit.
