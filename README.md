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
  readiness. Auth providers can be configured without being enabled; login
  remains disabled until start routes, callbacks, account merge rules, and
  wallet custody boundaries are implemented.

Dev URL: https://tasknodeofficial-dev.fly.dev

## Development

Install and run locally:

```bash
npm ci
npm run build
PORT=8080 npm start
SMOKE_BASE_URL=http://127.0.0.1:8080 npm run smoke
```

Deploy the dev app:

```bash
fly deploy -a tasknodeofficial-dev -c fly.toml --remote-only
SMOKE_BASE_URL=https://tasknodeofficial-dev.fly.dev npm run smoke
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
