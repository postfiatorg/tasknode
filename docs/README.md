# Task Node Official Docs

This folder is the engineering boot path for Task Node Official. It should let a
new engineer understand what this repo is, how to run it, what is live, and what
is intentionally not live yet.

**Authority:** Start with `wiki/index.md`. Everything under `docs/wiki/` is the
current product and architecture source of truth. Files under
`docs/archive/root-specs/` are historical only.


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

11. `archive/root-specs/full_spec.md`
   Historical product/architecture snapshot (not current authority).

12. `archive/root-specs/auth_account_spec.md`
   Historical auth/account design notes (superseded by wiki auth docs).

13. `wiki/architecture/auth-wallet-boundary.md`
   Concrete implementation guardrails for wallet auth UX, session refresh,
   wallet proof, local vault state, and regression coverage.

14. `wiki/architecture/resettable-signup-testing.md`
   Repeatable QA workflow for email signup, identity reset, faucet eligibility,
   and top-up state preservation.

15. `archive/root-specs/whip_context.md`
   Historical automation handoff notes (not current authority).

## Source Of Truth Rules

- **`docs/wiki/` is authoritative** for current product, operator, and architecture behavior.
- The in-app Help/Docs surface is powered by `docs/wiki/` via `src/features/docs/docs-content.js`.
- Root-era product briefs and mocks live under `docs/archive/root-specs/` (**historical reference only**).
  - `docs/archive/root-specs/full_spec.md`
  - `docs/archive/root-specs/product_spec.md`
  - `docs/archive/root-specs/auth_account_spec.md`
  - `docs/archive/root-specs/whip_context.md`
  - `docs/archive/root-specs/jsx_mock.jsx`
- Legacy PFTasks / PFDocs materials may still be useful as migration archaeology, but they are **not** live product authority and are not an executable runtime for this repository.
- Current UI is defined by `src/` and the live app. Historical JSX mocks are reference only.


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
