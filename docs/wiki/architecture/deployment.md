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

Run Fly releases through `npm run fly:deploy`, not raw `fly deploy`. That
command deploys the image and then runs `npm run fly:background-guard`, which
enforces one running `worker` machine and one running `board-manager` machine
with `restart=always`. The worker guard also checks that task generation,
Network Task generation, and task review are enabled. This is necessary because
the Fly HTTP service only applies to the `app` process group; background
process groups do not inherit `http_service.min_machines_running`.

## Background Worker Operations

The `worker` group is required for:

- task request generation from durable `task_requests` rows;
- Network Task generation from durable `network_task_generation_jobs` rows into
  normal task requests;
- task review and reward transitions from `server/task-review-worker.js`;
- PFTL cache sync, archive sync, watcher, reducer, and retention;
- chat memory and profile/daily-airdrop background jobs when enabled.

The `board-manager` group is intentionally separate from task review, but the
Hive board depends on it for Board Manager runs. Treat a stopped `worker` or a
stopped active `board-manager` as a deploy failure unless an operator has
explicitly paused that subsystem.

Operator commands:

```bash
npm run fly:deploy
npm run fly:background-guard
fly status -a tasknodeofficial-dev
fly logs -a tasknodeofficial-dev
```

Expected guard output names at least one `worker` machine and one
`board-manager` machine with `state=started restart=always`. Stopped standby
machines are acceptable. For `worker`, the guard must also pass these env
checks:

```text
TASKNODE_TASK_GENERATION_WORKER_ENABLED=true
TASKNODE_NETWORK_TASK_GENERATION_WORKER_ENABLED=true
TASKNODE_TASK_REVIEW_WORKER_ENABLED=true
```

If the active background machine is stopped or those flags are missing, the
deploy is incomplete. Fix the Fly config/secrets and rerun the guard before
debugging task data.

## Production Ramp-Up And Shutdown

Production has two separate state layers:

1. Fly process machines: `app`, `worker`, and `board-manager`.
2. Durable Hive scheduler state: `board_manager_scopes.status` for
   `global_hive`.

Both matter. A running `board-manager` machine with `global_hive` paused will
not mutate Hive. An enabled `global_hive` scope with no running
`board-manager` machine will also not mutate Hive.

### Ramp Up

Use this after deploys, machine stops, or maintenance windows:

```bash
cd /home/pfrpc/repos/tasknodeofficial
fly status -a tasknodeofficial-dev
npm run fly:background-guard
curl -sS https://tasknodeofficial-dev.fly.dev/health
```

Inspect Hive scheduler state:

```bash
fly ssh console --app tasknodeofficial-dev -C \
  "sh -lc 'cd /app && npm run board-manager:ops -- status'"
```

If Hive should run, restore the expected cadence and action budget, then resume
the scope:

```bash
fly ssh console --app tasknodeofficial-dev -C \
  "sh -lc 'cd /app && npm run board-manager:ops -- ensure-scope --cadence-seconds 900 --max-actions-per-hour 60 && npm run board-manager:ops -- resume --reason \"Production ramp-up\"'"
```

Expected ramped state:

```text
fly status:
  app            started
  worker         started
  board-manager  started

board-manager:ops status:
  scope.status = enabled
  scope.cadence_seconds = 900
  scope.max_actions_per_hour = 60
```

### Pause Hive Only

Pause Hive before repairing project rows, task refs, Board Manager prompts, or
any state that a live Board Manager run could rewrite:

```bash
fly ssh console --app tasknodeofficial-dev -C \
  "sh -lc 'cd /app && npm run board-manager:ops -- pause --reason \"Operator maintenance\" && npm run board-manager:ops -- status'"
```

This does not stop the public app, login, chat, wallet, top-up, task workers, or
PFTL cache workers. It only prevents new Board Manager job claims and Hive board
mutations. Resume after maintenance unless the intended production state is a
paused Hive board:

```bash
fly ssh console --app tasknodeofficial-dev -C \
  "sh -lc 'cd /app && npm run board-manager:ops -- resume --reason \"Operator maintenance complete\"'"
```

### Full Shutdown

Use full shutdown only for planned downtime. Do not delete the managed Postgres
cluster, Fly volume, or `/data/runtime-store.json`.

1. Pause Hive first:

```bash
fly ssh console --app tasknodeofficial-dev -C \
  "sh -lc 'cd /app && npm run board-manager:ops -- pause --reason \"Planned production shutdown\"'"
```

2. Inspect Board Manager jobs. Wait for a running job to complete, or
   intentionally defer/recover it, before stopping the machine:

```bash
fly ssh console --app tasknodeofficial-dev -C \
  "sh -lc 'cd /app && npm run board-manager:ops -- status'"
```

3. Stop machines in this order: `board-manager`, `worker`, `app`. Use
   `fly status` to copy the current IDs:

```bash
fly status -a tasknodeofficial-dev
fly machine stop <board-manager-machine-id> -a tasknodeofficial-dev
fly machine stop <worker-machine-id> -a tasknodeofficial-dev
fly machine stop <app-machine-id> -a tasknodeofficial-dev
```

Stopping `worker` halts task generation, Network Task generation, task review,
PFTL cache loops, memory workers, and profile background jobs. Stopping `app`
makes the public site unreachable, so it should be last.

4. Verify:

```bash
fly status -a tasknodeofficial-dev
```

### Restart After Shutdown

Start the public app first, then use the guard and Hive resume path:

```bash
fly machine start <app-machine-id> -a tasknodeofficial-dev
npm run fly:background-guard
curl -sS https://tasknodeofficial-dev.fly.dev/health
fly ssh console --app tasknodeofficial-dev -C \
  "sh -lc 'cd /app && npm run board-manager:ops -- ensure-scope --cadence-seconds 900 --max-actions-per-hour 60 && npm run board-manager:ops -- resume --reason \"Production restart\" && npm run board-manager:ops -- status'"
fly status -a tasknodeofficial-dev
```

Production is not fully ramped until `/health` passes, `worker` and
`board-manager` are started, and `global_hive` is either intentionally paused
or explicitly `enabled`.

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
TELEGRAM_BOT_WEBHOOK_SECRET
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
TELEGRAM_BOT_CHAT_MODE=<optional chat mode>
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

Telegram bot chat uses the same linked Telegram identity. The bot webhook is:

```text
https://tasknodeofficial-dev.fly.dev/api/integrations/telegram/webhook
```

Production requires `TELEGRAM_BOT_WEBHOOK_SECRET`; register the webhook with Telegram using the same `secret_token`. `TELEGRAM_AUTH_BOT_TOKEN` can be reused as the bot token if the login widget and chat bot are the same bot.

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

When sync records USDC credit and the credited USDC balance is greater than
`$10`, a newly created linked PFT wallet can receive the one-time `12 PFT`
initiation grant from the configured PFTL faucet. The USDC credit remains
account billing state; the PFT grant is a separate PFTL payment to the linked
wallet and is idempotent by account and wallet.

## PFTL And IPFS

PFTL is the canonical protocol layer for task requests, task updates, evidence pointers, rewards, context pointers, and wallet-linked activity. Postgres caches the readable projection, but the replayable anchors are CIDs, transaction hashes, wallet addresses, and PFTL memos.

Fly currently uses the rapid Post Fiat testnet websocket endpoint for live
transaction submission and balance reads. The endpoint presents non-public CA
TLS, so the deployment must opt in explicitly:

```text
PFTL_WSS_URL=wss://178.156.143.199:6005
VITE_PFTL_WSS_URL=wss://178.156.143.199:6005
PFTL_WSS_REJECT_UNAUTHORIZED=false
TASKNODE_ALLOW_INSECURE_PFTL_TLS=true
PFTL_RPC_URL=http://178.156.143.199:5005
PFTL_RPC_URL_FALLBACKS=https://rpc.testnet.postfiat.org
PFTL_HISTORY_WSS_URL=wss://ws-archive.testnet.postfiat.org
PFTL_HISTORY_RPC_URL=https://rpc.testnet.postfiat.org:5006/
```

Do not set `TASKNODE_ALLOW_INSECURE_PFTL_TLS=true` for arbitrary third-party
endpoints. It is only for the current PFTL rapid node while that node uses a
self-signed or private-chain certificate.

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

The bridge has a destructive `fly-dev:data:push` helper for the rare case where
local Docker data must replace Fly dev data. That helper truncates and reloads
Fly dev tables, so it is guarded. It only runs against `tasknodeofficial-dev`
and requires `TASKNODE_ALLOW_FLY_DEV_DATA_PUSH=true` or `--confirm-dev-push`.
Do not use it as a normal deploy path; normal deploys use git, Fly build, and
migrations.

## Deployment Command

Deploy from `main` after checks pass:

```bash
npm run build
npm run smoke
npm run route-smoke
npm run fly:deploy
```

After deploy:

```bash
curl -sS https://tasknodeofficial-dev.fly.dev/health
SMOKE_BASE_URL=https://tasknodeofficial-dev.fly.dev npm run smoke
FRAME_BASE_URL=https://tasknodeofficial-dev.fly.dev npm run frame-smoke
npm run fly:background-guard
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
