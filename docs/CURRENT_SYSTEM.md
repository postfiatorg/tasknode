# Current System Map

This document describes what exists in the repo today. It is not the final
architecture.

## Product Boundary

Task Node Official is the clean, account-first app. PFTasks and PFDocs are
reference systems.

Current product rules:

- Copy the provided JSX mocks where they exist.
- When a mock is incomplete, copy current ChatGPT patterns.
- Normal app access is account-based.
- Wallet proof is required only for wallet-bound actions.
- Usage is billing-based, not arbitrary rate-limit based.
- Users may receive network and alpha tasks, but they cannot request them from
  the normal task request path.
- The old PFTasks context editor is not a UX target.
- Native context editing should fit the new Task Node Official shell.
- PFDocs/PFTasks history hydration must be index-first because live PFTL
  `account_tx` may be incomplete.

## Repo Layout

```text
.
├── README.md                  # root project overview and quick commands
├── docs/                      # bootup and engineering docs
│   └── AUTH_WALLET_BOUNDARY.md
│                              # wallet/auth implementation guardrail
├── full_spec.md               # current product/architecture source of truth
├── product_spec.md            # raw initial product brief
├── auth_account_spec.md       # auth/account/wallet-claim design
├── whip_context.md            # automation execution context and guardrails
├── jsx_mock.jsx               # canonical app-frame mock
├── login.jsx                  # canonical login modal mock
├── mocks/                     # newer UX mocks from product iteration
├── prompts/                   # prompt research/input artifacts
├── src/                       # React app shell
├── server/                    # Node API/static server
├── scripts/                   # smoke and frame-smoke tests
├── Dockerfile                 # Fly build image
├── fly.toml                   # tasknodeofficial-dev Fly config
└── package.json               # npm scripts and deps
```

## Runtime Surfaces

Frontend:

- `src/main.jsx`: React app, shell, navigation, chat frame, task/wallet/context
  surfaces, settings, login modal, and current UX wiring.
- `src/styles.css`: app styling.
- `src/api.js`: small fetch helpers.

Server:

- `server/index.js`: static file server, runtime config, API routing, cookies.
- `server/product-contracts.js`: product action contracts for auth, chat,
  wallet, context, usage, provider readiness, and disabled actions.
- `server/runtime-store.js`: JSON-backed sessions, accounts, identities, email
  challenges, OAuth state, chat messages, and usage ledger.
- `server/chat-router.js`: chat mode config, provider readiness, cost
  estimates, OpenAI/OpenRouter execution. Frontier Instant is pinned to the
  direct OpenAI `chat-latest` route unless a mode-specific
  `CHAT_MODEL_FRONTIER_INSTANT` override is provided. Frontier Thinking is
  pinned to direct OpenAI `gpt-5.5` with `reasoning.effort` set to `high`.
- `server/app-state.js`: server-owned UI read model for session, chat, tasks,
  wallet, usage, context, and readiness.

Tests:

- `scripts/smoke.mjs`: API/product contract smoke test.
- `scripts/runtime-store-smoke.mjs`: local runtime store invariant smoke test.
- `scripts/frame-smoke.mjs`: headless browser frame test with screenshots.

## Current API Contracts

Health/config:

- `GET /health`
- `GET /api/health`
- `GET /runtime-config.js`
- `GET /runtime-config.json`
- `GET /api/readiness`

Session/auth:

- `GET /api/session`
- `GET /api/auth/providers`
- `POST /api/auth/dev/start`
- `POST /api/auth/email/start`
- `POST /api/auth/email/verify`
- `POST /api/auth/logout`
- `GET /api/auth/start/:provider`
- `GET /api/auth/callback/:provider`

Product state:

- `GET /api/app-state`
- `GET /api/tasks`
- `GET /api/wallet`
- `GET /api/wallet/balance`
- `GET /api/wallet/transactions`
- `GET /api/context`
- `GET /api/usage`

Chat:

- `GET /api/chat/modes`
- `GET /api/chat/conversations`
- `GET /api/chat/history`
- `POST /api/chat/estimate`
- `POST /api/chat/send`
- `POST /api/chat/stream`

Wallet actions:

- `GET /api/wallet/actions`
- `POST /api/wallet/link/start`
- `POST /api/wallet/link/verify`
- `POST /api/wallet/unlock/start`
- `POST /api/wallet/delink` detaches the active account wallet, records an
  audit event, and relies on the browser to clear the local encrypted vault.
- `POST /api/wallet/relink/start` starts a fresh wallet proof challenge with
  `wallet_relink` purpose and reuses `/api/wallet/link/verify`.
- A fresh valid wallet signature is authoritative for wallet ownership. If the
  same wallet is still marked linked on stale local accounts, successful
  link/relink detaches those stale links with audit events instead of blocking
  the current proof.

Wallet balance reads:

- `GET /api/wallet/balance` requires the account session cookie and reads only
  the wallet already linked to that account.
- The server reads PFTL native drops with `account_info` on the validated
  ledger, using WSS first and JSON-RPC fallback. PFTL is the Post Fiat L1;
  XRPL-compatible client libraries are only the transport/signing
  compatibility layer.
- Local Docker defaults to the same rapid PFTL host PFTasks uses on this
  machine: `wss://178.156.143.199:6005` with local self-signed TLS allowed and
  `http://178.156.143.199:5005`, with public PFTL testnet fallbacks. This node
  is for current balance reads, not historical pulls. Fly uses the public PFTL
  testnet hosts unless environment or secrets override them.
- `GET /api/wallet/transactions` requires the same account session and linked
  wallet boundary. It scans full-history PFTL `account_tx`, normalizes native
  payment rows involving the linked wallet, labels recognized `pf.ptr/v4`
  pointer kinds such as task rewards and task submissions, and returns bounded
  cached rows for the wallet activity feed.

Context actions:

- `GET /api/context/actions`
- `GET /api/context/history`
- `POST /api/context/import/start`
- `POST /api/context/edit/save`
- `POST /api/context/history/rpc/import`
- `POST /api/context/history/indexed`
- `GET /api/context/history/ipfs/:cid`
- `POST /api/context/manifest/ink`

Historical context restore uses a dedicated full-history PFTL archive WSS path,
with JSON-RPC fallback. The server scans the linked wallet's `account_tx`
history for `pf.ptr` / `v4` `CONTENT_KIND.CONTEXT` pointers and stores CID
metadata only. Encrypted CID payloads are fetched by allow-listed CID and
decrypted in the browser after local vault unlock. Native current context is
account-scoped; imported PFT historical pointers are cached by account plus
wallet address and are hidden when no wallet is linked or a different wallet is
linked.

Usage/billing:

- `GET /api/usage/actions`
- `GET /api/usage/ledger`
- `POST /api/usage/top-up/start`
- `POST /api/usage/credit/admin`

## Enabled Today

- React app shell.
- ChatGPT-style main frame.
- App navigation with Tasks, Wallet, Context, Profile, Settings.
- Chat response toolbar keeps only backed actions: copy response and export the
  visible transcript.
- Email code login contract and development delivery.
- GitHub OAuth start/callback when configured.
- Dev auth outside production.
- Cookie-backed sessions.
- Auth/wallet boundary guardrails: signed-out wallet linking routes to login,
  wallet proof links a wallet to an account session, and local vault unlock is
  not treated as app login.
- Session/account read model.
- Browser-only 24-word seed wallet proof for account linking. The app validates
  and signs locally; the server receives only address, public key, and
  signature.
- Chat estimate, non-streaming chat send, and SSE chat streaming.
- Server-owned JSON-runtime chat conversations, per-account recents, and
  history hydration.
- Native account-scoped context document load/save in the JSON runtime store.
  Context can be viewed before login, saved after account login, and does not
  require wallet unlock.
- PFDocs-compatible indexed PFTasks history import as sanitized pointer
  metadata. The app stores CIDs/provenance/counts, not decrypted context or
  evidence plaintext, and the import is scoped to the active linked wallet.
- OpenAI execution and streaming when configured.
- OpenRouter execution and streaming when configured. Private routes enforce
  OpenRouter ZDR/data-collection-deny provider preferences, support
  image/PDF/text attachments, use pinned ZDR-listed defaults for instant and
  thinking, and do not enable OpenRouter web search.
- Usage ledger and admin credit when configured.
- Idempotent initial provider credit ledger contract for eligible registrar
  accounts.
- Runtime, API, and frame-smoke coverage.
- Fly dev deployment.

## Wired But Not Fully Live

- Telegram login.
- Discord login.
- X login.
- PFTL transaction signing.
- Wallet delink/relink behavior.
- Crypto top-up.
- Context import.
- PFTL manifest ink.
- OpenRouter production route verification against selected ZDR endpoints and
  attachment-heavy prompts.
- Formal Postgres-backed chat history.
- Initial eligible-provider credit for Telegram, Discord, and X callback paths.
- Durable summaries/caches for decrypted PFDocs/PFTasks context history.

## Intentional Deferrals

- MetaMask/Phantom funding until the safest rail is selected.
- Notion and Google Docs context imports.
- Network/alpha task request UX.
- Full task verification/reward payout.
- PFTL manifest inking by default.
- Rebuilding old PFTasks surfaces wholesale.

## Near-Term Build Path

P0 production chat:

1. Done: replace fake sidebar recents with server-owned conversations/messages
   in the JSON runtime store.
2. Done: add real recents and per-thread history hydration from the app server.
3. Done: add streaming OpenAI/OpenRouter adapters and `/api/chat/stream`.
4. Done: render user messages immediately and stream assistant deltas.
5. Done: persist final assistant output and usage on completion.
6. Done: remove unbacked chat toolbar controls and fake source/activity panels.

P0 account credit:

1. Done: make the initial provider credit ledger grant idempotent.
2. Done: grant initial usage balance during GitHub callback/account linking.
3. Exclude email-only accounts.
4. Wire the same grant into X, Telegram, and Discord after their callback
   verification paths exist.

P1 seed login:

1. Done: reuse PFTasks/PFDocs 24-word mnemonic primitives.
2. Done: validate and derive wallet in the browser.
3. Done: sign server challenge locally.
4. Done: never send seed or private key to the server.
5. Done: persist an encrypted local seed vault in the browser with WebCrypto
   AES-GCM/PBKDF2.
6. Done: add local vault unlock/lock UX and keep the decrypted seed in memory
   only for the current browser session.
7. Done: use the unlocked local vault to decrypt the latest imported encrypted
   context CID in the browser. The server only fetches encrypted JSON for CIDs
   already present in the account's imported pointer metadata.
8. Implement PFTL signing confirmation boundaries.
9. Use wallet proof to claim/link legacy wallet identity.

P1 context:

1. Done: build native account-scoped context save/load.
2. Done: replace the placeholder connector picker with a native context editor
   that fits the app shell.
3. Done: normalize indexed PFTasks rows into PFDocs-compatible context/task
   pointer metadata before live RPC fallback.
4. Done: hydrate the latest encrypted historical context CID only after local
   wallet unlock, without server-side plaintext storage.
5. Use live PFTL RPC only as fallback/provenance until archive history is
   proven.

## Maintainability Rules

- Keep files small and modular.
- Prefer server-owned product contracts over frontend-only fake state.
- Keep disabled actions as explicit contracts with clear `actionRequired`.
- Do not leak secrets into docs, logs, prompts, or commits.
- Do not read or print real seed phrases.
- Add regression tests for behavior classes, not just literal examples.
- Treat user examples as evidence of a failed boundary, not as special cases.
- Before expanding scope, update `full_spec.md` and this map.
- If the whip causes scope drift or unsafe automation, pause it using
  `whip_context.md`.
