# Deployment

Task Node Official is the production task system at
`https://tasknode.postfiat.org`, served by one Fly deployment plus one local
Docker workflow. Local QA can share the same Fly Postgres data when it needs to
reproduce the live app state.

## Current Deployment

The live app is:

```text
https://tasknode.postfiat.org
Fly app: tasknodeofficial-dev (the promoted dev app keeps its original Fly name)
Region: ewr
```

The production cutover promoted the existing `tasknodeofficial-dev` Fly app
rather than creating a separate production app, so every `fly ...` command in
this page still targets `-a tasknodeofficial-dev` even though the public domain
is `tasknode.postfiat.org`. The old public hostname
`tasknodeofficial-dev.fly.dev` now 301-redirects GET navigation to the
production domain (`TASKNODE_LEGACY_REDIRECT_HOSTS` in `fly.toml`); `/health`
and non-GET API requests are exempt so Fly health checks keep passing.

Fly builds the production Docker image from `Dockerfile` and runs the process definitions in `fly.toml`:

```text
app                    npm run start:web
worker-pftl            npm run start:worker:pftl
worker-taskgen         npm run start:worker:taskgen
worker-task-review     npm run start:worker:task-review
worker-context-rewrite npm run start:worker:context-rewrite
worker-hive            npm run start:worker:hive
worker-memory-profile  npm run start:worker:memory-profile
worker-airdrop         npm run start:worker:airdrop
board-manager          npm run start:board-manager
```

Only the `app` process receives HTTP traffic. It serves the built frontend,
exposes `/api/*`, and runs the startup migration check. Missing built static
asset requests, including `/assets/*` and other file-extension paths, return a
404 JSON response instead of the SPA shell; extensionless navigation paths still
fall back to `index.html`. The `worker-*` and `board-manager` processes are
separate Fly machine groups; verify their live state with
`fly status -a tasknodeofficial-dev` before assuming background loops are
running. The legacy `worker` process remains only for local compatibility;
production rejects it unless `TASKNODE_ALLOW_MONOLITH_WORKER=true` is set
intentionally.

Run Fly releases through `npm run fly:deploy:prod`, not raw `fly deploy`.
(`fly:deploy:prod` wraps `fly:deploy` with the production confirmation the
deploy preflight requires now that `fly.toml` carries the production
hostname.) The wrapped command deploys the image and then runs
`npm run fly:background-guard`, which
enforces one running machine for every `worker-*` group and one running
`board-manager` machine with `restart=always`. The worker guard also checks the
required flags for the groups that depend on them. This is necessary because the
Fly HTTP service only applies to the `app` process group; background process
groups do not inherit `http_service.min_machines_running`.

## Background Worker Operations

The worker groups are split by failure domain:

- `worker-taskgen`: task request generation from durable `task_requests` rows
  and Network Task generation from durable `network_task_generation_jobs` rows.
- `worker-task-review`: task review and reward transitions from
  `server/task-review-worker.js`.
- `worker-pftl`: PFTL cache sync, archive sync, watcher, reducer, retention,
  and IPFS replication.
- `worker-context-rewrite`: context rewrite jobs.
- `worker-hive`: Hive secretary, project, report, task-manager, and accounting workers.
- `worker-memory-profile`: chat memory and recommended connection jobs.
- `worker-airdrop`: profile daily airdrop jobs.

The `board-manager` group is intentionally separate from task review, but the
Hive board depends on it for Board Manager runs. Treat a stopped `worker-*`
group or a stopped active `board-manager` as a deploy failure unless an operator
has explicitly paused that subsystem.

Operator commands:

```bash
npm run fly:deploy:prod
npm run fly:background-guard
fly status -a tasknodeofficial-dev
fly logs -a tasknodeofficial-dev
```

Expected guard output names at least one machine for every `worker-*` group and
one `board-manager` machine with `state=started restart=always`. Stopped standby
machines are acceptable. The guard also checks these group-specific flags:

```text
worker-taskgen:
TASKNODE_TASK_GENERATION_WORKER_ENABLED=true
TASKNODE_NETWORK_TASK_GENERATION_WORKER_ENABLED=true

worker-task-review:
TASKNODE_TASK_REVIEW_WORKER_ENABLED=true

worker-pftl:
PFTL_CACHE_WORKER_ENABLED=true
PFTL_CACHE_WSS_WATCHER_ENABLED=true

worker-airdrop:
TASKNODE_DAILY_AIRDROP_WORKER_ENABLED=true
```

If the active background machine is stopped or those flags are missing, the
deploy is incomplete. Fix the Fly config/secrets and rerun the guard before
debugging task data.

## Production Ramp-Up And Shutdown

Production has two separate state layers:

1. Fly process machines: `app`, `worker-*`, and `board-manager`.
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
curl -sS https://tasknode.postfiat.org/health
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
  worker-*       started
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

3. Stop machines in this order: `board-manager`, `worker-*`, `app`. Use
   `fly status` to copy the current IDs:

```bash
fly status -a tasknodeofficial-dev
fly machine stop <board-manager-machine-id> -a tasknodeofficial-dev
fly machine stop <worker-machine-id> -a tasknodeofficial-dev
fly machine stop <app-machine-id> -a tasknodeofficial-dev
```

Stopping a `worker-*` group halts only that group's background loop. Stopping
all `worker-*` groups halts task generation, Network Task generation, task
review, PFTL cache loops, memory workers, and profile background jobs. Stopping
`app` makes the public site unreachable, so it should be last.

4. Verify:

```bash
fly status -a tasknodeofficial-dev
```

### Restart After Shutdown

Start the public app first, then use the guard and Hive resume path:

```bash
fly machine start <app-machine-id> -a tasknodeofficial-dev
npm run fly:background-guard
curl -sS https://tasknode.postfiat.org/health
fly ssh console --app tasknodeofficial-dev -C \
  "sh -lc 'cd /app && npm run board-manager:ops -- ensure-scope --cadence-seconds 900 --max-actions-per-hour 60 && npm run board-manager:ops -- resume --reason \"Production restart\" && npm run board-manager:ops -- status'"
fly status -a tasknodeofficial-dev
```

Production is not fully ramped until `/health` passes, every `worker-*` group
and `board-manager` are started, and `global_hive` is either intentionally
paused or explicitly `enabled`.

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
TASKNODE_PUBLIC_URL=https://tasknode.postfiat.org
VITE_SITE_ORIGIN=https://tasknode.postfiat.org
TASKNODE_ENV=production
TASKNODE_DEV_AUTH_ENABLED=false
TASKNODE_DATABASE_ENABLED=true
TASKNODE_STORE_PATH=/data/runtime-store.json
TASKNODE_RUNTIME_STORE_DURABLE=true
TASKNODE_LEGACY_REDIRECT_HOSTS=tasknodeofficial-dev.fly.dev
EMAIL_DELIVERY_PROVIDER=resend
EMAIL_FROM=Task Node <login@agti.net>
TELEGRAM_AUTH_BOT_USERNAME=pftasknodebot
TELEGRAM_AUTH_WIDGET_DOMAIN=tasknode.postfiat.org
TELEGRAM_BOT_CHAT_MODE=<optional chat mode>
DISCORD_REDIRECT_URI=https://tasknode.postfiat.org/api/auth/discord/callback
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
tasknode.postfiat.org
```

The Fly app must use the matching widget domain and bot username:

```text
TELEGRAM_AUTH_WIDGET_DOMAIN=tasknode.postfiat.org
TELEGRAM_AUTH_BOT_USERNAME=pftasknodebot
```

Telegram bot chat uses the same linked Telegram identity. The bot webhook is:

```text
https://tasknode.postfiat.org/api/integrations/telegram/webhook
```

Verify the registered webhook with `getWebhookInfo` after any domain change;
the widget domain, webhook URL, and `TASKNODE_PUBLIC_URL` must all agree or
startup origin checks and Telegram login will fail.

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

Custody keys are deliberately outside the Fly app. `npm run
eth-deposit-wallet` prints the operator mnemonic and receive xprv once, then
writes only the xpub config. The receive xprv for `m/44'/60'/0'/0` can derive
each child private key at `m/44'/60'/0'/0/<deposit-index>`. Operators can verify
custody material without printing it by running:

```bash
npm run eth-deposit-verify -- --index <deposit-index>
```

Do not put the mnemonic, receive xprv, or child private keys in Fly secrets.
Sweep keys belong in an operator-controlled wallet, hardware signer, or separate
sweep process.

If `/api/usage/top-up/start` returns `usage_top_up_login_required`, top-up is configured but the caller is signed out. If it returns `Ethereum deposit addresses are not configured for this environment`, Fly is missing `ETH_DEPOSIT_XPUB`.

Top-up start verifies a derived address is empty before returning it to the user. If any supported asset probe fails, the app does not show the address. If a candidate address already has ETH, USDC, or USDT, the app retires that candidate and advances to the next derivation index. Older pre-fix addresses that only contain historical observed funds and no `ethereum_deposit` ledger credit for that exact deposit account are retired on the next start or sync. Admin credits and chat spend are not deposit ownership proof. The displayed address should therefore be clean, and only later balance increases become usage credit.

Retiring a deposit record does not move funds. Active and retired deposit
records currently live in `/data/runtime-store.json` under
`ethereumDepositAccounts` and `ethereumDepositRetiredAccounts`. If money was
sent to a retired child address, it remains at that Ethereum address until the
operator sweeps it with the matching child key.

When sync records USDC credit and the credited USDC balance is greater than
`$10`, a newly created linked PFT wallet can receive the one-time `12 PFT`
initiation grant from the configured PFTL faucet. Sync marks the grant as ready
but must not auto-send it. The wallet page sends it only after the matching
local seed vault is saved or unlocked in the browser. The USDC credit remains
account billing state; the PFT grant is a separate PFTL payment to the linked
wallet and is idempotent by account and wallet.

Ethereum top-up credits are recorded as app billing ledger entries, not as PFT
wallet balances. `/api/usage/top-up/sync` writes
`billing_ledger_entries.source = ethereum_deposit` with an idempotency key based
on deposit account id, asset, and credited raw balance. A raw chain balance is
not app credit until that ledger row exists.

## PFTL And IPFS

PFTL is the canonical protocol layer for task requests, task updates, evidence pointers, rewards, context pointers, and wallet-linked activity. Postgres caches the readable projection, but the replayable anchors are CIDs, transaction hashes, wallet addresses, and PFTL memos.

The PFTL endpoints come from two layers that can disagree, so check both when
auditing:

- `fly.toml` `[env]` declares the hostname endpoints:
  `PFTL_WSS_URL=wss://ws.testnet.postfiat.org`,
  `PFTL_RPC_URL=https://rpc.testnet.postfiat.org`,
  `PFTL_HISTORY_WSS_URL=wss://ws-archive.testnet.postfiat.org`,
  `PFTL_HISTORY_RPC_URL=https://rpc.testnet.postfiat.org:5006/`.
- Fly secrets override `[env]` values with the same name. The live deployment
  currently overrides at least the browser websocket: `/runtime-config.json`
  on production reports `pftlWssUrl=wss://178.156.143.199:6005` (the rapid
  testnet node), not the `fly.toml` hostname. Audit live values with
  `fly secrets list -a tasknodeofficial-dev` and
  `curl -sS https://tasknode.postfiat.org/runtime-config.json`.

The rapid node at `178.156.143.199` presents non-public CA TLS. Pointing the
server at it requires explicit opt-in (`PFTL_WSS_REJECT_UNAUTHORIZED=false`,
`TASKNODE_ALLOW_INSECURE_PFTL_TLS=true`). Do not set
`TASKNODE_ALLOW_INSECURE_PFTL_TLS=true` for arbitrary third-party endpoints; it
exists only for the rapid node while it uses a self-signed or private-chain
certificate.

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
- Browser wallet vaults are origin-local. `localhost:5174`, `tasknodeofficial-dev.fly.dev`, and `tasknode.postfiat.org` do not share encrypted browser seed storage; users who onboarded on the old dev hostname must unlock or restore once on the production domain.
- Runtime auth/account state is still partly JSON-backed. Use the documented bridge helpers for runtime-store copies instead of hand-editing JSON.

The bridge has a destructive `fly-dev:data:push` helper for the rare case where
local Docker data must replace Fly dev data. That helper truncates and reloads
Fly dev tables, so it is guarded. It only runs against `tasknodeofficial-dev`
and requires `TASKNODE_ALLOW_FLY_DEV_DATA_PUSH=true` or `--confirm-dev-push`.
Do not use it as a normal deploy path; normal deploys use git, Fly build, and
migrations.

## Production Configuration (Promoted Dev App)

The production domain `tasknode.postfiat.org` is served by promoting this same
Fly app, not by a separate production app. The decision and gates live in the
[Task Node Production Cutover Package](#docs/task-node-production-cutover-package).
The cutover executed on 2026-06-10 (see the [execution checklist](#docs/task-node-production-cutover-execution-checklist)). The standing production configuration on this app:

- `fly.toml` `[env]` carries the production values listed in the
  [PFTasks Transaction Shutdown Cutover Plan](#docs/pftasks-transaction-shutdown-cutover-plan)
  (public URL, site origin, Telegram widget domain, Discord/X redirect URIs).
- Once `fly.toml` carries a production hostname, `npm run fly:deploy` refuses
  to run without explicit confirmation; use `npm run fly:deploy:prod` (which
  sets `TASKNODE_CONFIRM_PRODUCTION_DEPLOY=yes`).
- Startup fails closed in production when the site origin, Discord/X redirect
  URIs, or Telegram widget domain do not match the public origin host.
- Production money seeds must be explicit: `TASKNODE_REWARD_SEED` for task
  rewards and `TASKNODE_DAILY_AIRDROP_SEED` for the daily airdrop. In
  production the workers refuse the development fallback chain
  (allocation/authority/service/faucet seeds) and fail with the existing
  seed-missing error codes instead of signing from the wrong wallet.
- `TASKNODE_LEGACY_REDIRECT_HOSTS=tasknodeofficial-dev.fly.dev` is set so GET
  navigation on the old dev hostname 301-redirects to the production domain.
  `/health` and non-GET API requests are exempt, so Fly health checks and
  in-flight sessions keep working.

## Deployment Command

Deploy from the active production branch (currently
`review-target/tasknode-cutover-readiness-2026-06-09`, the integration branch
the deployed app is built from), not from a stale `main`. After checks pass:

```bash
npm run build
npm run static-asset-fallback-smoke
npm run smoke
npm run route-smoke
npm run fly:deploy:prod
```

`fly.toml` carries the production hostname, so plain `npm run fly:deploy` is
refused by the deploy preflight unless `TASKNODE_CONFIRM_PRODUCTION_DEPLOY=yes`
is set; `fly:deploy:prod` is the supported production command and sets the
confirmation for you.

After deploy:

```bash
curl -sS https://tasknode.postfiat.org/health
SMOKE_BASE_URL=https://tasknode.postfiat.org npm run smoke
FRAME_BASE_URL=https://tasknode.postfiat.org npm run frame-smoke
npm run fly:background-guard
fly status -a tasknodeofficial-dev
```

For auth/provider changes, also verify:

```bash
curl -sS https://tasknode.postfiat.org/api/auth/providers
```

For email signup:

```bash
curl -sS -X POST https://tasknode.postfiat.org/api/auth/email/start \
  -H 'content-type: application/json' \
  --data '{"email":"user@example.com"}'
```

For top-up readiness:

```bash
curl -sS -X POST https://tasknode.postfiat.org/api/usage/top-up/start
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

## 2026-07-14 Fly Worker-Stop Security Note

Sanctioned live Fly tokens are `hive-mind` (owned by Sauron) and the current
logged-in operational credential (owned by Alexander Good). The
`cryptpad-knowledge-graph` token ending `Hq1` was revoked on 2026-07-14. The
requested stop of `e820352ae34138` at `2026-07-14T21:49:13.124Z` remains
unexplained; see `/tmp/tasknode-fly-security-audit-426.md`. Before treating a
future unexplained worker stop as a platform failure, first check sanctioned
`hive-mind` automation.
