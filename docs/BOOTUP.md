# Bootup Guide

This is the shortest path from a fresh checkout to a running Task Node Official
dev app.

## What This Repo Is

Task Node Official is a ChatGPT-style execution app for Post Fiat. The current
repo is a small React + Node app that is being built as a clean replacement for
older PFTasks surfaces.

Current priorities:

- production-grade chat;
- account-first login;
- usage-based balance/ledger;
- secure 24-word seed wallet restore/linking;
- native context editing that fits the new app shell;
- PFDocs/PFTasks-compatible historical context hydration.

## Prerequisites

- Node 20 or compatible current LTS.
- npm.
- Fly CLI for deployment.
- A browser for manual UI checks.
- Chrome or `google-chrome` for `npm run frame-smoke`.

The repo intentionally disables npm lifecycle scripts, audit prompts, funding
prompts, and high-concurrency registry fetches through `.npmrc` and Docker
install flags.

## Local Setup

For Docker-first local development, use:

```sh
npm run docker:dev -- -d
```

Open:

```text
http://127.0.0.1:5174
```

See `docs/DEPLOYMENT.md` for the full Docker/Fly deployment matrix.

From the repo root:

```sh
npm ci
npm run build
PORT=8080 npm start
```

Open:

```text
http://127.0.0.1:8080
```

For Vite development:

```sh
npm run dev
```

Default Vite URL:

```text
http://127.0.0.1:5174
```

The Node server is the more realistic path because it exercises the API routes
and runtime store.

## Smoke Tests

Local API/product smoke:

```sh
SMOKE_BASE_URL=http://127.0.0.1:8080 npm run smoke
```

Local runtime-store contract smoke:

```sh
npm run runtime-smoke
```

Local frame/UI smoke:

```sh
FRAME_BASE_URL=http://127.0.0.1:8080 npm run frame-smoke
```

Dev Fly smoke:

```sh
SMOKE_BASE_URL=https://tasknodeofficial-dev.fly.dev npm run smoke
FRAME_BASE_URL=https://tasknodeofficial-dev.fly.dev npm run frame-smoke
```

Frame smoke writes screenshots to `/tmp/tasknodeofficial-frame-smoke` unless
`FRAME_SCREENSHOT_DIR=0` is set.

## Runtime Store And Database

The app currently uses Postgres for chat history and usage billing when
`DATABASE_URL` is configured and `TASKNODE_DATABASE_ENABLED=true`. Local Docker
configures both by default and stores those rows in `tasknodeofficial_pg_data`.
The explicit enable flag prevents accidental writes to an unrelated generic
`DATABASE_URL` secret.

The remaining account/session/context/wallet surfaces still use the local JSON
runtime store in `server/runtime-store.js`.

Default path:

```text
/tmp/tasknodeofficial-runtime-store.json
```

Override:

```sh
TASKNODE_STORE_PATH=/path/to/runtime-store.json PORT=8080 npm start
```

Important: `/tmp` is not durable across machine restarts. Before relying on
session continuity, account links, native context, or wallet-link records on
Fly, either configure a durable store path on a Fly volume or move those
remaining data models to Postgres. Do not use the JSON store for durable chat
history or billing in new deployments.

Public startup guard: `server/index.js` refuses to boot with a public
`TASKNODE_PUBLIC_URL`/`VITE_SITE_ORIGIN` when dev auth is enabled or the runtime
store is not explicitly declared durable. Keep `TASKNODE_ENV=production`,
`TASKNODE_DEV_AUTH_ENABLED=false`, and, until auth/account/wallet state moves to
Postgres, set `TASKNODE_RUNTIME_STORE_DURABLE=true` only after a durable store
path or volume is actually configured.

## Environment And Secrets

Do not commit or print secret values.

Local secret files are ignored by git:

```text
.env
.env.*
*.env
*.env.local
*.env.dev
*.env.production
```

The current local inventory report is:

```text
.env.tasknodeofficial-dev.report
```

That report lists secret names and source paths only, not values. It says the
dev app has all currently identified important secrets present as of the latest
inventory pass.

Common env names:

- `TASKNODE_AUTH_SECRET`
- `TASKNODE_PUBLIC_URL`
- `TASKNODE_STORE_PATH`
- `TASKNODE_DEV_AUTH_ENABLED`
- `TASKNODE_EMAIL_DEV_DELIVERY`
- `EMAIL_DELIVERY_PROVIDER`
- `EMAIL_FROM`
- `RESEND_API_KEY`
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `GITHUB_REDIRECT_URI`
- `OPENAI_API_KEY`
- `OPENROUTER_API_KEY`
- `TASKNODE_ADMIN_CREDIT_TOKEN`
- `TASKNODE_INITIAL_PROVIDER_CREDIT_USD`
- `ETH_DEPOSIT_XPUB`
- `ETH_DEPOSIT_START_INDEX`
- `ETH_DEPOSIT_RPC_URL`
- `ETH_DEPOSIT_BALANCE_BLOCK_TAG`
- `ETH_DEPOSIT_ETH_USD_PRICE`
- `POSTHOG_KEY`
- `VITE_POSTHOG_KEY`
- `TELEGRAM_AUTH_BOT_TOKEN`
- `DATABASE_URL`

Current behavior:

- dev auth is enabled by default outside production;
- email code login can use development delivery outside production;
- GitHub OAuth is enabled when configured;
- Telegram, Discord, and X are visible contract surfaces but not fully enabled;
- seed-wallet account linking uses browser-only 24-word BIP39 validation, PFTL
  wallet derivation using XRPL-compatible Post Fiat primitives, and server
  challenge signing; the recovery phrase and private key never leave the
  browser;
- encrypted seed vault persistence is browser-only and uses WebCrypto AES-GCM
  with PBKDF2; unlock state is in-memory and cleared on lock/logout;
- latest cached encrypted context CID hydration is browser-only after local
  wallet unlock; the server only fetches encrypted JSON for cached pointer CIDs;
- wallet delink/relink are enabled for account wallet proof testing and clear
  the browser-local encrypted vault on delink;
- PFTL transaction signing and durable decrypted-context summaries remain
  disabled;
- OpenAI chat can execute and stream when configured;
- OpenRouter execution and streaming routes are enabled when
  `OPENROUTER_API_KEY` is configured; set `OPENROUTER_CHAT_ENABLED=false` as a
  kill switch if needed. Private requests enforce ZDR/data-collection-deny
  provider preferences and
  map image/PDF/text attachments into OpenRouter chat content. Private Instant
  defaults to `deepseek/deepseek-v4-flash`; Private Thinking defaults to
  `deepseek/deepseek-v4-pro` with high reasoning. Private OpenRouter requests
  are constrained to a known ZDR provider allowlist; OpenRouter web search is
  not enabled for Private modes;
- native context documents can be viewed by anyone and saved by signed-in
  accounts without wallet unlock;
- cached PFTL context/task pointers are projected as sanitized pointer
  metadata; the latest encrypted context CID can be decrypted locally after
  wallet unlock;
- admin credit requires `TASKNODE_ADMIN_CREDIT_TOKEN` plus a caller-supplied
  idempotency key;
- Ethereum top-up is account-scoped and enabled when `ETH_DEPOSIT_XPUB` is
  configured; it accepts ETH, USDC, and USDT on Ethereum mainnet and never
  asks the user to connect or sign with MetaMask.

## Deployment Paths

See `docs/DEPLOYMENT.md` for the current deployment guide.

Summary:

- local Docker dev: `http://localhost:5174`, hot reload, no Fly deploy;
- local production Docker: `http://localhost:8080`, same Dockerfile as Fly;
- Fly dev release: `https://tasknodeofficial-dev.fly.dev`, remote release
  candidate testing.

## Fly Dev

Current dev app:

```text
https://tasknodeofficial-dev.fly.dev
```

Deploy:

```sh
fly deploy -a tasknodeofficial-dev -c fly.toml --remote-only
```

Health:

```sh
curl -s https://tasknodeofficial-dev.fly.dev/health
```

Logs:

```sh
fly logs -a tasknodeofficial-dev
```

Status:

```sh
fly status -a tasknodeofficial-dev
```

Secrets:

```sh
fly secrets list -a tasknodeofficial-dev
```

Do not paste secret values into docs, prompts, commits, or chat logs.

## Whip Safety

The whip is currently an automation accelerator, not a product authority. If it
blocks progress, repeats stale work, targets the wrong tmux pane, or expands
scope dangerously, turn it off before continuing.

Preferred shutdown:

```sh
cd /home/pfrpc/repos/codex-whip
/home/pfrpc/repos/tasknodex/.venv/bin/python3 -m codex_whip.cli uninstall-cron --profile tasknodeofficial
```

Verify:

```sh
crontab -l | rg 'codex-whip profile tasknodeofficial|tasknodeofficial'
```

Expected result: no output.

## Common Failure Checks

If the app does not start:

- run `npm ci`;
- run `npm run build`;
- verify `PORT` is free;
- check whether `dist/` exists;
- check `/health` before debugging the frontend.

If chat does not execute:

- check `/api/chat/modes`;
- check `/api/readiness`;
- verify `OPENAI_API_KEY` or `OPENROUTER_API_KEY`;
- check whether the selected mode is configured and enabled;
- use dry-run behavior only for smoke tests.

If login behaves strangely:

- check `/api/session`;
- check `/api/auth/providers`;
- confirm cookie behavior on the same origin;
- verify `TASKNODE_AUTH_SECRET` in production-like environments;
- remember email login is low assurance and does not claim legacy wallet state.

If seed wallet linking fails:

- read `docs/AUTH_WALLET_BOUNDARY.md` before changing wallet/auth behavior;
- confirm the user is signed in before calling `/api/wallet/link/start`;
- if the user is signed out, the UI should route to login before showing a
  seed phrase modal;
- refresh `/api/app-state` after login before starting wallet proof;
- use a 24-word BIP39 recovery phrase;
- set and confirm the local wallet password before submitting the link modal;
- check `/api/wallet/actions` and confirm `link_start` is enabled;
- remember only address, public key, and signature should reach the server;
- remember the encrypted seed vault is stored in this browser only;
- do not paste or log a real production seed during debugging.

If history disappears:

- check `TASKNODE_STORE_PATH`;
- confirm whether the runtime store is in `/tmp`;
- do not assume Fly local disk is durable unless a volume is configured.

If context edits do not save:

- check `/api/session` and confirm the user is signed in;
- check `/api/context` and confirm `document.canEdit` is true;
- remember native context save is account-gated, not wallet-gated;
- check `TASKNODE_STORE_PATH` if saved context disappears after restart.

If historical PFT context does not appear:

- check `/api/context/history`;
- confirm the account has a linked wallet;
- confirm the linked wallet is active in `pftl_sync_wallets`;
- confirm the PFTL cache and reducer workers are running;
- confirm `PFTL_HISTORY_WSS_URL` points at a full-history PFTL archive WSS for
  archive backfill, not the machine-local rapid balance node;
- run `npm run context-history-rpc-smoke` if pointer decoding or account_tx
  mapping looks suspect;
- remember the cache stores pointer metadata only. Decrypted CID plaintext
  requires browser-local wallet unlock.
