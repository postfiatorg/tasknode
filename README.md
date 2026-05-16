# Task Node Official

Official product workspace for Task Node GPT: a ChatGPT-style execution app
integrated with personal tasks, context documents, PFT wallet operations, and
crypto-funded usage.

## Current Status

This repository is initialized with early product/interface artifacts and a
minimal deployable dev app:

- `product_spec.md` contains the initial product direction and migration notes.
- `jsx_mock.jsx` contains a React mock for a ChatGPT-style Task Node interface with Tasks, Wallet, Context, Profile, Settings, and PFT balance surfaces.
- `login.jsx` contains a standalone login/sign-up modal mock with Telegram, Discord, X, and email entry options.
- `src/` and `server/` contain the first thin React shell and Node static server.
- `fly.toml` deploys the dev app to `tasknodeofficial-dev` on Fly.io.
- `/api/app-state` is the first server-owned product contract for session,
  chat modes, tasks, wallet, usage billing, and context sources. It is fixture
  backed for now so real PFTasks/PFTL integrations can replace it behind a
  stable boundary.
- `/api/auth/providers` and `/api/readiness` expose non-secret integration
  readiness. Email code login is implemented as the first low-assurance account
  path; OAuth providers remain disabled until callbacks, account merge rules,
  and wallet custody boundaries are implemented.
- `/api/auth/email/start` and `/api/auth/email/verify` implement one-time email
  code login. Codes are hashed server-side, expire quickly, are single-use, and
  issue httpOnly cookie sessions after verification. Local/dev environments can
  use development delivery for smoke testing; production should configure
  `TASKNODE_AUTH_SECRET` and a transactional email provider.
- `/api/auth/start/:provider` and `/api/auth/callback/:provider` are present as
  contract endpoints. They return structured disabled or unimplemented responses
  until provider-specific auth flows are reviewed and enabled.
- `/api/auth/dev/start`, `/api/auth/logout`, and `/api/session` provide the
  first cookie-backed account session boundary for development environments.
  This is not a production auth provider; it exists so the account-first app can
  be exercised before OAuth and bot callbacks are enabled.
- `/api/wallet/actions` exposes disabled-by-default wallet lifecycle actions:
  link, unlock, delink, and relink. The action endpoints are present so seed
  storage, unlock, and production delink/relink behavior can be tested behind a
  stable boundary before custody is enabled.
- `/api/chat/estimate` and `/api/chat/send` define the usage-based chat
  contract. Estimates are cost-free. Send supports a cost-free dry run for
  smoke tests and real provider execution when OpenAI credentials are configured.
  OpenRouter routes remain configured-but-disabled until explicitly enabled and
  verified.
- `/api/chat/modes` and `/api/chat/history` expose model-route readiness and
  the current session-scoped conversation. Chat turns and usage debits are
  stored in an append-only local runtime store until Postgres account/session
  tables land.
- `/api/usage/ledger` exposes the current append-only usage ledger so chat
  spend and account credits can be audited before durable Postgres ledger
  tables land. The Billing settings surface reads this ledger directly.
- `/api/usage/actions`, `/api/usage/top-up/start`, and
  `/api/usage/credit/admin` define the first usage-credit contract. Crypto
  top-up is still disabled while the safest rail is selected; admin credit is
  enabled only when `TASKNODE_ADMIN_CREDIT_TOKEN` is configured.
- `/api/context/actions` exposes disabled-by-default context actions for shared
  URL import, native edit save, and explicit PFTL manifest ink. This keeps
  context useful before wallet setup while making portability a deliberate
  wallet-bound action.

Dev URL: https://tasknodeofficial-dev.fly.dev

## Development

Install and run locally:

```bash
npm ci
npm run build
PORT=8080 npm start
SMOKE_BASE_URL=http://127.0.0.1:8080 npm run smoke
FRAME_BASE_URL=http://127.0.0.1:8080 npm run frame-smoke
```

Deploy the dev app:

```bash
fly deploy -a tasknodeofficial-dev -c fly.toml --remote-only
SMOKE_BASE_URL=https://tasknodeofficial-dev.fly.dev npm run smoke
FRAME_BASE_URL=https://tasknodeofficial-dev.fly.dev npm run frame-smoke
```

The project npm policy disables lifecycle scripts, audit, funding prompts, and
high-concurrency registry fetches by default. That keeps the current dependency
surface small and reduces npm supply-chain exposure while this app is still
being bootstrapped.

## Product Direction

Task Node GPT is a full redesign of the older PFTasks surface. The intended
product is "ChatGPT except designed to make you more productive," with a clean
chat-first interface and product-specific execution surfaces.

Core requirements from the initial spec:

- Account authentication replaces wallet authentication for normal app access.
- Wallet authentication remains only for wallet-bound actions: sending PFT,
  signing PFT verifications, and saving context document manifests through PFTL
  pointers.
- Users can use the product without a Post Fiat wallet, but paid usage is
  required in that path.
- Chat spend is tracked per query, and users can top up with crypto.
- Task completion should top up user chat balances.
- The app supports personal task requests; network and alpha tasks move to a
  routed network task board rather than user-requested flows.
- Context documents should support share-link based sources, including Google
  Docs and a researched Notion integration path, while preserving cacheable PFT
  context portability.
- Telegram and Discord chat surfaces should consolidate into this app with clear
  account linkage and bot integration documentation.
- Nostr should be used for messaging-style integration instead of treating PFT as
  the messaging layer.
- Dev and production deployments should target Fly.io.
- Prompts should be open source except private NFT/profile-picture prompts.
- The codebase should stay small, modular, security-conscious, and easy for LLMs
  and humans to audit.

## Interface Model

The current mock keeps Task Node close to ChatGPT while exposing:

- `Tasks` for personal execution work.
- `Wallet` for PFT balance, transfers, and activity.
- `Context` for internal PFT context plus external document sources.
- `Profile` for private and pseudonymous public identity surfaces.
- Settings for security, billing, model/data controls, and connected wallets.

## Open Decisions

- Finalize the PFTL Snap/server-side seed-cache approach and unlock transaction
  boundaries.
- Define the scalable message storage architecture.
- Decide whether the network board is refactored or eliminated.
- Complete the Notion document integration research.
- Convert `product_spec.md` into execution milestones and acceptance criteria.
