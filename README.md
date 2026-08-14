# Task Node Official

Official product workspace for Task Node GPT: a ChatGPT-style execution app
integrated with personal tasks, context documents, PFT wallet operations, and
crypto-funded usage.

## Current Status

This repository is initialized with early product/interface artifacts and a
minimal deployable dev app:

- `docs/wiki/index.md` is the source-of-truth Help wiki index.
- `docs/wiki/architecture/bootup.md` explains local setup, smoke tests,
  runtime persistence, and common failure checks.
- `docs/wiki/architecture/deployment.md` covers local Docker, Fly release
  deployments, background process groups, secrets, and operational checks.
- `docs/wiki/architecture/current-system.md` maps the current app, API contracts, enabled
  surfaces, disabled surfaces, and near-term build path.
- Product and architecture truth lives in `docs/wiki/` (start at `docs/wiki/index.md`) and the in-app **Docs** surface.
- Historical root briefs/mocks were moved to `docs/archive/root-specs/` (`product_spec.md`, `full_spec.md`, `auth_account_spec.md`, `whip_context.md`, `jsx_mock.jsx`) and are **not** primary inputs.
- `login.jsx` contains a standalone login/sign-up modal mock with Telegram, Discord, X, GitHub, and email entry options.
- `src/` and `server/` contain the first thin React shell and Node static server.
- `fly.toml` deploys the dev app to `tasknodeofficial-dev` on Fly.io.
- `/api/app-state` is the first server-owned product contract for session,
  chat modes, tasks, wallet, usage billing, and context sources. It is fixture
  backed for development so live PFTL and app-store integrations can replace it
  behind a stable boundary.
- `/api/auth/providers` and `/api/readiness` expose non-secret integration
  readiness. Email code login and GitHub OAuth are implemented as the first
  account paths; Telegram, Discord, and X remain disabled until callbacks,
  account merge rules, and wallet custody boundaries are implemented.
- `/api/auth/email/start` and `/api/auth/email/verify` implement one-time email
  code login. Codes are hashed server-side, expire quickly, are single-use, and
  issue httpOnly cookie sessions after verification. Local/dev environments can
  use development delivery for smoke testing; production should configure
  `TASKNODE_AUTH_SECRET` and a transactional email provider.
- `/api/auth/start/:provider` and `/api/auth/callback/:provider` are present as
  contract endpoints. GitHub starts a real OAuth flow when configured and links
  to the current signed-in account when launched from an existing session.
  Other providers return structured disabled or unimplemented responses until
  their callbacks are reviewed and enabled.
- `/api/auth/dev/start`, `/api/auth/logout`, and `/api/session` provide the
  first cookie-backed account session boundary for development environments.
  This is not a production auth provider; it exists so the account-first app can
  be exercised before OAuth and bot callbacks are enabled.
- Settings > Security exposes the first connected-accounts surface for provider
  status and account-link actions.
- `/api/wallet/link/start` and `/api/wallet/link/verify` implement the first
  seed-wallet proof boundary. The browser validates a 24-word BIP39 recovery
  phrase, derives the PFTL classic address using the XRPL-compatible PFDocs
  path, signs a server challenge locally, and sends only address, public key,
  and signature to the server. The browser can now save an encrypted local seed
  vault with WebCrypto AES-GCM/PBKDF2 and unlock it for the current session.
  The unlocked vault can decrypt imported historical context CIDs in the
  browser. PFTL transaction signing, delink, and relink remain disabled until
  their custody rules are implemented.
- PFTL is its own Post Fiat L1. The app may use XRPL-compatible libraries and
  classic-address primitives because PFTL is an XRPL fork, but PFT balances and
  transactions are not XRP mainnet/testnet balances or transactions.
- `/api/chat/estimate`, `/api/chat/send`, and `/api/chat/stream` define the
  usage-based chat contract. Estimates are cost-free. Send supports a cost-free
  dry run for smoke tests, while stream renders assistant deltas over SSE and
  persists the completed response plus usage after provider completion.
  Legacy mode names remain compatible, but all text, reasoning, structured,
  search, and image-understanding requests route through Ambient. OpenAI is
  restricted to blind Profile NFT image rendering after a two-pass Ambient GLM
  5.2 privacy abstraction and deterministic leakage checks.
- `/api/chat/modes`, `/api/chat/conversations`, and `/api/chat/history` expose
  model-route readiness, server-owned recents, and per-thread history. Chat
  turns and usage debits use the Postgres chat/billing repository when
  `DATABASE_URL` is configured and `TASKNODE_DATABASE_ENABLED=true`, with the
  JSON runtime store retained as a no-database development fallback.
- The chat shell keeps usage accounting visible without crowding the thread:
  PFT and USD chat credit sit together in the sidebar balance area, while
  sub-cent USD credit and per-response billing feedback are shown without
  rounding active usage down to a static-looking `$5.00`. The response
  toolbar exposes only backed behavior today: copy response and copy the visible
  transcript.
- `/api/usage/ledger` exposes the current append-only usage ledger so chat
  spend and account credits can be audited. The Billing settings surface reads
  this ledger directly; local Docker now stores it in Postgres.
- `/api/usage/actions`, `/api/usage/top-up/start`, and
  `/api/usage/credit/admin` define the first usage-credit contract. Crypto
  top-up is still disabled while the safest rail is selected; admin credit is
  enabled only when `TASKNODE_ADMIN_CREDIT_TOKEN` is configured and requires a
  caller-supplied idempotency key.
- Eligible provider login can grant an idempotent initial chat credit through
  the same usage ledger. Email-only login is excluded.
- `/api/context` and `/api/context/edit/save` expose the first native
  account-scoped context document. Everyone can view the default context shape;
  signed-in users can save edits without wallet unlock.
- `/api/context/history` and `/api/context/history/indexed` expose the first
  PFDocs-compatible history bridge. Signed-in accounts can import indexed
  context/task rows as sanitized pointer metadata. `/api/context/history/ipfs/:cid`
  fetches encrypted JSON only for imported pointer CIDs, and the browser
  decrypts the latest context payload with the locally unlocked seed vault.
  Shared URL imports remain disabled until their trust boundary is implemented.
  Explicit, user-initiated PFTL manifest ink is implemented and config-gated: the
  browser signs the pointer transaction while the server only pins the encrypted
  payload and submits the signed blob, scoped to a signed-in account with a linked
  wallet, and is off in environments without IPFS/PFTL/encryption-key configuration.

Dev URL: https://tasknodeofficial-dev.fly.dev

## New Engineer Start Here

Read these in order:

1. `docs/wiki/index.md`
2. `docs/wiki/architecture/current-system.md`
3. `docs/wiki/architecture/bootup.md`
4. `docs/wiki/architecture/deployment.md`
5. `docs/wiki/` (authoritative) and the in-app Docs surface
6. `docs/archive/root-specs/` historical snapshots only (`full_spec.md`, `auth_account_spec.md`, `whip_context.md`, etc.)
7. Live `src/`/`server/` implementation when docs and code must be compared

## Development

Fast local Docker dev:

```bash
npm run docker:dev -- -d
```

Open:

```text
http://localhost:5174
```

Install and run locally:

```bash
npm ci
npm run build
npm run runtime-smoke
PORT=8080 npm start
SMOKE_BASE_URL=http://127.0.0.1:8080 npm run smoke
FRAME_BASE_URL=http://127.0.0.1:8080 npm run frame-smoke
```

Deploy the dev app:

```bash
npm run fly:deploy
SMOKE_BASE_URL=https://tasknodeofficial-dev.fly.dev npm run smoke
FRAME_BASE_URL=https://tasknodeofficial-dev.fly.dev npm run frame-smoke
npm run fly:background-guard
```

Do not use raw `fly deploy` as the normal release command. Task Node has
non-HTTP Fly process groups, and Fly's `http_service.min_machines_running`
setting only keeps the public `app` process alive. `npm run fly:deploy` deploys
and then verifies `worker` and `board-manager` machines are started with
`restart=always`. The worker guard also verifies task generation, Network Task
generation, and task review are enabled, because a running worker process with
those flags missing will leave queued task rows unprocessed.

The project npm policy disables lifecycle scripts, audit, funding prompts, and
high-concurrency registry fetches by default. That keeps the current dependency
surface small and reduces npm supply-chain exposure while this app is still
being bootstrapped.

## Product Direction

Task Node Official is the current product surface. The intended
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
- Context documents start as native account-scoped documents. Share-link based
  sources such as Google Docs and a researched Notion path are deferred until
  the trust, cache, and confirmation boundaries are designed, while cacheable
  PFT context portability remains a later explicit manifest flow.
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
- `Context` for a native account document first, then historical PFT context and
  explicit external sources after their trust boundaries are implemented.
- `Profile` for private and pseudonymous public identity surfaces.
- Settings for security, billing, model/data controls, and connected wallets.

## Open Decisions

- Finalize the PFTL Snap/server-side seed-cache approach and unlock transaction
  boundaries.
- Define the scalable message storage architecture.
- Decide whether the network board is refactored or eliminated.
- Complete context hydration and later Notion/document import
  research.
- Prefer `docs/wiki/` plans/surfaces for milestones and acceptance criteria; root product_spec is archival only.
