# Task Node Official Docs

This folder is the engineering boot path for Task Node Official. It should let a
new engineer understand what this repo is, how to run it, what is live, and what
is intentionally not live yet.

## Read Order

1. `BOOTUP.md`
   Local setup, dev server, smoke tests, Fly deploy, env/secrets, and common
   failure checks.

2. `CURRENT_SYSTEM.md`
   Current repo layout, runtime surfaces, API contracts, enabled features,
   disabled features, and the near-term build path.

3. `DOCKER_DEV.md`
   Local Docker dev loop for rapid iteration without Fly deploys.

4. `PFTL_TASK_ENGINE_SPEC.md`
   Proposed on-chain-first task engine, PFTasks deprecation rationale,
   pointer-native lifecycle, wallet provisioning, cache strategy, and
   portability target for Codex/CLI clients.

5. `DEPLOYMENT.md`
   Local Docker dev, local production Docker, and Fly release deployment paths.

6. `../full_spec.md`
   Product/architecture source of truth and active burndown.

7. `../auth_account_spec.md`
   Auth, provider linking, wallet claim, email login, and delink/relink design.

8. `AUTH_WALLET_BOUNDARY.md`
   Concrete implementation guardrails for wallet auth UX, session refresh,
   wallet proof, local vault state, and regression coverage.

9. `../whip_context.md`
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
- `DATA_MODEL.md`: account, conversation, usage ledger, context, wallet, and
  PFTasks hydration models.
- `SECURITY.md`: broader seed handling, OAuth, email login, provider keys,
  retention, logging, and supply-chain policy.
