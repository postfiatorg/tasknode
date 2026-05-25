# Deployment

Task Node Official currently has one public dev deployment on Fly and one local Docker workflow. The two can share the same Fly dev Postgres data when local QA needs to reproduce the live app state.

## Current Deployment

The live app is:

```text
https://tasknodeofficial-dev.fly.dev
Fly app: tasknodeofficial-dev
Region: ewr
```

Fly builds the production Docker image from `Dockerfile` and runs the process definitions in `fly.toml`:

```text
app           npm run start:web
worker        npm run start:worker
board-manager npm run start:board-manager
```

Only the `app` process receives HTTP traffic. It serves the built frontend, exposes `/api/*`, and runs the startup migration check. The `worker` and `board-manager` processes are separate Fly machine groups; verify their live state with `fly status -a tasknodeofficial-dev` before assuming background loops are running.

## Data Model

Task Node uses two durable stores today:

| Store | Purpose | Current location |
| --- | --- | --- |
| Postgres | Chat, memory, tasks, Hive, profile, billing, PFTL cache, task projections, network projects, board-manager artifacts | Managed Fly Postgres, `DATABASE_URL` secret |
| Runtime store JSON | Sessions, account identity links, wallet links, OAuth state, email challenges, remaining wallet/account runtime fields | Fly volume mounted at `/data/runtime-store.json` |

The runtime store is still a real product dependency. Do not delete the Fly volume or replace `/data/runtime-store.json` casually. Moving auth, account identity, wallet link, and deposit state fully into Postgres is a separate data architecture milestone.

## Fly Secrets

Secrets live in Fly, not in git. The repo may contain gitignored local env files, but no committed secret should be required to understand the deployment.

The current public dev deployment expects these secret classes:

```text
DATABASE_URL
TASKNODE_AUTH_SECRET
OPENAI_API_KEY
OPENROUTER_API_KEY
GITHUB_CLIENT_SECRET
TELEGRAM_AUTH_BOT_TOKEN
RESEND_API_KEY
ETH_DEPOSIT_XPUB
```

The non-secret deployment values currently visible in the app configuration are:

```text
TASKNODE_PUBLIC_URL=https://tasknodeofficial-dev.fly.dev
VITE_SITE_ORIGIN=https://tasknodeofficial-dev.fly.dev
TASKNODE_ENV=production
TASKNODE_DEV_AUTH_ENABLED=false
TASKNODE_DATABASE_ENABLED=true
TASKNODE_STORE_PATH=/data/runtime-store.json
TASKNODE_RUNTIME_STORE_DURABLE=true
EMAIL_DELIVERY_PROVIDER=resend
EMAIL_FROM=Task Node <login@agti.net>
TELEGRAM_AUTH_BOT_USERNAME=pftasknodebot
TELEGRAM_AUTH_WIDGET_DOMAIN=tasknodeofficial-dev.fly.dev
DISCORD_REDIRECT_URI=https://tasknodeofficial-dev.fly.dev/api/auth/callback/discord
```

To set a Fly secret:

```bash
fly secrets set NAME=value -a tasknodeofficial-dev
```

Changing a Fly secret rolls the machines. Recheck `/health` and the affected route after the rollout finishes.

## Auth Providers

Email uses Resend with the verified `agti.net` sender:

```text
Task Node <login@agti.net>
```

Resend must mark the sending domain verified before the app can email arbitrary recipients. If the app returns `email_delivery_failed` with a Resend `403`, the likely causes are:

- Fly is still using `onboarding@resend.dev`.
- `EMAIL_FROM` is not on a verified domain.
- The Resend API key is missing or restricted incorrectly.

Telegram uses the Telegram Login Widget. BotFather must have this exact domain:

```text
tasknodeofficial-dev.fly.dev
```

The Fly app must use the matching widget domain and bot username:

```text
TELEGRAM_AUTH_WIDGET_DOMAIN=tasknodeofficial-dev.fly.dev
TELEGRAM_AUTH_BOT_USERNAME=pftasknodebot
```

GitHub OAuth can attach a verified GitHub email to an account cloud. That means a later email login can resolve to an account originally created by GitHub if GitHub supplied the same verified email.

## Ethereum Top-Up

Top-up is an account deposit rail, not wallet-connect. Users send ETH, USDC, or USDT on Ethereum mainnet to an account-scoped deposit address.

The app shows deposit addresses only when this secret exists:

```text
ETH_DEPOSIT_XPUB
```

The xpub lets the server derive receive addresses. It does not give the server private keys. Balance sync uses:

```text
ETH_DEPOSIT_RPC_URL
ETH_DEPOSIT_BALANCE_BLOCK_TAG
ETH_DEPOSIT_START_INDEX
```

If `/api/usage/top-up/start` returns `usage_top_up_login_required`, top-up is configured but the caller is signed out. If it returns `Ethereum deposit addresses are not configured for this environment`, Fly is missing `ETH_DEPOSIT_XPUB`.

Top-up start verifies a derived address is empty before returning it to the user. If any supported asset probe fails, the app does not show the address. If a candidate address already has ETH, USDC, or USDT, the app retires that candidate and advances to the next derivation index. Older pre-fix addresses that only contain historical observed funds and no `ethereum_deposit` ledger credit for that exact deposit account are retired on the next start or sync. Admin credits and chat spend are not deposit ownership proof. The displayed address should therefore be clean, and only later balance increases become usage credit.

## PFTL And IPFS

PFTL is the canonical protocol layer for task requests, task updates, evidence pointers, rewards, context pointers, and wallet-linked activity. Postgres caches the readable projection, but the replayable anchors are CIDs, transaction hashes, wallet addresses, and PFTL memos.

Fly uses the public Post Fiat testnet endpoints configured in `fly.toml`:

```text
PFTL_WSS_URL=wss://ws.testnet.postfiat.org
PFTL_RPC_URL=https://rpc.testnet.postfiat.org
PFTL_HISTORY_WSS_URL=wss://ws-archive.testnet.postfiat.org
PFTL_HISTORY_RPC_URL=https://rpc.testnet.postfiat.org:5006/
```

The app should prefer indexed Postgres projections for UI speed, then preserve enough CID and transaction identity to replay or repair chain-derived state.

## Local Docker

Local Docker is still useful for implementation and screenshots:

```bash
npm run docker:dev -- -d
```

Open:

```text
http://localhost:5174
```

Default local Docker uses a local Postgres container and a local `/data/runtime-store.json` volume. It does not automatically share browser wallet vaults or cookies with Fly.

## Docker Against Fly Dev Data

When local QA must reproduce Fly state, use the Fly data bridge:

```bash
npm run docker:dev:fly-data
```

That command starts a local Fly Postgres proxy and runs the local API/web containers against the Fly dev database. It is the expected path when a bug appears on Fly and needs local UI debugging.

Important constraints:

- This bridge targets Task Node Official Fly dev data only.
- Do not point it at PFTasks databases.
- Browser wallet vaults are origin-local. `localhost:5174` and `tasknodeofficial-dev.fly.dev` do not share encrypted browser seed storage.
- Runtime auth/account state is still partly JSON-backed. Use the documented bridge helpers for runtime-store copies instead of hand-editing JSON.

## Deployment Command

Deploy from `main` after checks pass:

```bash
npm run build
npm run smoke
npm run route-smoke
fly deploy -a tasknodeofficial-dev -c fly.toml --remote-only
```

After deploy:

```bash
curl -sS https://tasknodeofficial-dev.fly.dev/health
SMOKE_BASE_URL=https://tasknodeofficial-dev.fly.dev npm run smoke
FRAME_BASE_URL=https://tasknodeofficial-dev.fly.dev npm run frame-smoke
fly status -a tasknodeofficial-dev
```

For auth/provider changes, also verify:

```bash
curl -sS https://tasknodeofficial-dev.fly.dev/api/auth/providers
```

For email signup:

```bash
curl -sS -X POST https://tasknodeofficial-dev.fly.dev/api/auth/email/start \
  -H 'content-type: application/json' \
  --data '{"email":"user@example.com"}'
```

For top-up readiness:

```bash
curl -sS -X POST https://tasknodeofficial-dev.fly.dev/api/usage/top-up/start
```

Signed-out callers should receive `usage_top_up_login_required` once Ethereum deposit addresses are configured.

## Operational Rules

- Do not commit secrets, tokens, seeds, or generated env files.
- Do not delete the Fly volume unless the runtime-store migration is complete and verified.
- Do not assume local Docker and Fly share browser wallet state.
- Do not use PFTasks runtime, DBs, bots, or deployment assumptions for this repo.
- Do not call a protocol path end-to-end unless the user-facing route and projection were actually verified.
- After a Fly secret change, retest the affected route because Fly rolls machines.
- After a worker or Board Manager change, confirm process state with `fly status`; HTTP health only proves the app process is up.
- The app CSP allows WebAssembly compilation with `script-src 'self' 'wasm-unsafe-eval'` because wallet and encryption libraries compile WASM in the browser. Do not replace this with broad JavaScript `unsafe-eval` unless a reviewed dependency forces it.

## Reviewer To Do List

Review implementation against this document (deployment). Mark each item when verified.

### Memory Efficiency
- [ ] Deployment guide names durable stores without implying full in-memory replay.
- [ ] Docker/Fly bridge instructions avoid copying full stores except through documented commands.
- [ ] Worker and Board Manager checks use process status instead of log scraping as the primary health signal.

### Code Quality
- [ ] `fly.toml`, Docker compose files, and docs agree on app name, public URL, runtime store path, and process names.
- [ ] Secrets are described by name only; no secret values are committed.
- [ ] Verification commands exercise real deployed routes.

### Coherence
- [ ] Auth provider behavior matches the Auth And Connected Accounts doc.
- [ ] Ethereum top-up behavior matches the Wallet surface and `docs/ETHEREUM_TOP_UPS.md`.
- [ ] Docker/Fly data bridge behavior matches `docs/DOCKER_DEV.md`.

### Bloat
- [ ] Deployment page stays operational and does not duplicate every provider prompt or task-engine detail.
- [ ] Historical PFTasks deployment behavior is not described as current Task Node behavior.
- [ ] Commands are limited to the common deploy/debug paths.

### Security
- [ ] No API keys, tokens, wallet seeds, private keys, or database passwords appear in the page.
- [ ] Runtime store and Fly volume custody boundaries are explicit.
- [ ] Top-up xpub is described as receive-only and not a private key.
