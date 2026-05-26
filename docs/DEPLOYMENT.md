# Deployment Guide

Task Node Official has three different run paths. Do not mix them up.

## 1. Local Docker Dev

Use this for rapid iteration. This is the default daily development path.

```bash
cd /home/pfrpc/repos/tasknodeofficial
npm run docker:dev -- -d
```

Open:

```text
http://localhost:5174
```

What runs:

- `tasknodeofficial-web-1`: Vite dev server on `localhost:5174`.
- `tasknodeofficial-api-1`: Node API server on `localhost:8080`.
- `tasknodeofficial-db-1`: local Postgres 16/pgvector database on Docker
  network `db:5432`, exposed to the host as `localhost:5436` by default.
- Vite proxies `/api`, `/health`, `/runtime-config.js`, and
  `/runtime-config.json` to the API container.

Behavior:

- `src/` changes hot reload in the browser.
- `server/` changes restart the API through `node --watch`.
- chat history and usage billing persist in the Postgres Docker volume
  `tasknodeofficial_pg_data`.
- compose explicitly sets `TASKNODE_DATABASE_ENABLED=true` for local Docker;
  Fly or production deployments must set this deliberately before the app uses
  any `DATABASE_URL` secret.
- the remaining JSON runtime state persists in `tasknodeofficial_dev_data`
  until auth/session/context/wallet records are migrated.
- dev auth is enabled.
- cookies are localhost cookies, not Fly HTTPS cookies.
- wallet balance reads and task transaction submission use the rapid PFTL host:
  `wss://178.156.143.199:6005` first, then `http://178.156.143.199:5005`
  fallback. Because the rapid websocket currently presents non-public CA TLS,
  Fly must set `PFTL_WSS_REJECT_UNAUTHORIZED=false` together with
  `TASKNODE_ALLOW_INSECURE_PFTL_TLS=true`. This is a current-balance and submit
  path, not a historical ledger/archive pull path.
- historical context restore uses `PFTL_HISTORY_WSS_URL`, defaulting to
  `wss://ws-archive.testnet.postfiat.org`, so context CID discovery does not
  depend on the rapid balance node's ledger depth. JSON-RPC is fallback only.
- Ethereum top-up uses an account-scoped receive address. Configure
  `ETH_DEPOSIT_XPUB` before showing live addresses, and configure
  `ETH_DEPOSIT_RPC_URL` for balance sync. The rail accepts ETH, USDC, and USDT
  on Ethereum mainnet only; see `docs/ETHEREUM_TOP_UPS.md`.

Local GitHub OAuth:

- The API container reads `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` from
  the shell or repo-root `.env` used by Docker Compose variable substitution.
- The OAuth callback URL for local Docker dev is:

```text
http://localhost:5174/api/auth/callback/github
```

- Use a separate GitHub OAuth app for local development unless the existing app
  is already registered for that exact localhost callback. The Fly app callback
  is different:

```text
https://tasknodeofficial-dev.fly.dev/api/auth/callback/github
```

Verify:

```bash
curl -s http://localhost:8080/health
DATABASE_URL=postgres://tasknodeofficial:tasknodeofficial@127.0.0.1:5436/tasknodeofficial npm run db:chat-billing-smoke
SMOKE_BASE_URL=http://127.0.0.1:5174 npm run smoke
npm run wallet-balance-smoke
npm run context-history-rpc-smoke
```

Logs:

```bash
npm run docker:dev:logs
```

Stop:

```bash
npm run docker:dev:down
```

Wipe local Docker state:

```bash
docker compose -f docker-compose.dev.yml down -v
```

This wipes both `tasknodeofficial_pg_data` and `tasknodeofficial_dev_data`.
Snapshot or import the JSON runtime store before doing this if you need local
chat/billing cutover verification.

## 2. Local Production Docker

Use this before a Fly release when you want to test the same Dockerfile that Fly
uses, without shipping it to Fly yet.

Build:

```bash
cd /home/pfrpc/repos/tasknodeofficial
docker build -t tasknodeofficial-local .
```

Run:

```bash
docker run --rm \
  --name tasknodeofficial-local \
  -p 8080:8080 \
  -e PORT=8080 \
  -e NODE_ENV=production \
  -e TASKNODE_ENV=development \
  -e TASKNODE_PUBLIC_URL=http://localhost:8080 \
  -e VITE_SITE_ORIGIN=http://localhost:8080 \
  -e TASKNODE_DEV_AUTH_ENABLED=true \
  tasknodeofficial-local
```

Open:

```text
http://localhost:8080
```

Verify:

```bash
curl -s http://localhost:8080/health
SMOKE_BASE_URL=http://127.0.0.1:8080 npm run smoke
FRAME_BASE_URL=http://127.0.0.1:8080 npm run frame-smoke
```

This path does not hot reload. It tests the built `dist/` app served by
`server/index.js`, matching the Fly runtime shape.

## 3. Fly Dev Release

Use this for release candidates and remote machine testing.

Current app:

```text
tasknodeofficial-dev
https://tasknodeofficial-dev.fly.dev
```

Preflight:

```bash
npm run build
SMOKE_BASE_URL=http://127.0.0.1:5174 npm run smoke
```

Public deployments refuse to boot if development auth is enabled or if the app
would use the default `/tmp` JSON runtime store for auth/account/wallet state.
Before Fly deploys, confirm:

```bash
fly secrets set TASKNODE_DEV_AUTH_ENABLED=false -a tasknodeofficial-dev
fly secrets set TASKNODE_ENV=production -a tasknodeofficial-dev
```

The Fly dev release mounts `tasknodeofficial_data` at `/data` for the web
process and stores runtime auth/account state at `/data/runtime-store.json`.
The deploy env must keep these enabled:

```text
TASKNODE_DATABASE_ENABLED=true
TASKNODE_STORE_PATH=/data/runtime-store.json
TASKNODE_RUNTIME_STORE_DURABLE=true
TASKNODE_TASK_GENERATION_WORKER_ENABLED=true
TASKNODE_TASK_GENERATION_WORKER_INTERVAL_MS=5000
TASKNODE_TASK_GENERATION_WORKER_BATCH_LIMIT=1
TASKNODE_NETWORK_TASK_GENERATION_WORKER_ENABLED=true
TASKNODE_NETWORK_TASK_GENERATION_WORKER_INTERVAL_MS=5000
TASKNODE_NETWORK_TASK_GENERATION_WORKER_BATCH_LIMIT=1
TASKNODE_BOARD_MANAGER_CADENCE_SECONDS=900
TASKNODE_BOARD_MANAGER_MAX_ACTIONS_PER_HOUR=60
TASKNODE_TASK_REVIEW_WORKER_ENABLED=true
TASKNODE_TASK_REVIEW_WORKER_INTERVAL_MS=5000
TASKNODE_TASK_REVIEW_WORKER_BATCH_LIMIT=1
```

### Background Process Guard

The Fly `app` process group is the only group covered by `[http_service]`.
`min_machines_running` and HTTP health checks do not keep `worker` or
`board-manager` alive. The `worker` process owns PFTL cache sync, cache
reduction, task generation, task review, memory jobs, and other background
loops. The `board-manager` process owns Hive Board Manager scheduling and
action execution. A healthy public app can still fail task progression or Hive
board automation if these background groups are stopped.

Every Fly release must run:

```bash
npm run fly:background-guard
```

The guard starts one `worker` machine and one `board-manager` machine if needed,
sets the active machines to `restart=always`, and exits non-zero if it cannot
verify both background groups are running. For the `worker` group it also
verifies the task-generation, Network Task generation, and task-review worker
enable flags. Treat a guard failure as a failed deploy.

Network Task delivery has two worker hops:

1. `server/network-task-generation-worker.js` consumes
   `network_task_generation_jobs` and creates normal `task_requests` rows.
2. `server/task-generation-worker.js` consumes those `task_requests` and
   publishes the real `pf.task.offer.v1` task pointer.

A queued `network_task_generation_jobs` row is not a visible Network Task. The
task exists only after the second hop publishes an offer and `task_projections`
contains the task.

Expected status after deploy:

```text
app      started
worker   started
worker standby stopped         # acceptable
board-manager started
board-manager standby stopped  # acceptable
```

If tasks are stuck in `submitted`, context history is not indexing, or task
offers are not appearing after request publication, check the worker before
debugging database rows. If Hive Board Manager runs stop appearing, check
`board-manager` before debugging project rows.

### Production Ramp-Up And Shutdown

The production system has two layers that must both be correct:

1. Fly machines: `app`, `worker`, and `board-manager` process groups.
2. Durable Hive scheduler state: `board_manager_scopes.status` for
   `global_hive`.

A started `board-manager` machine with `global_hive` paused will not mutate the
Hive board. An enabled `global_hive` scope with the `board-manager` machine
stopped will also not mutate the Hive board. Always verify both.

#### Ramp Up From A Cold Or Uncertain State

Use this when recovering after machine stops, a deploy, a maintenance window, or
an operator pause.

```bash
cd /home/pfrpc/repos/tasknodeofficial
fly status -a tasknodeofficial-dev
npm run fly:background-guard
```

Verify the public app is reachable:

```bash
curl -sS https://tasknodeofficial-dev.fly.dev/health
```

Verify the Hive Board Manager scope from any running Fly machine:

```bash
fly ssh console --app tasknodeofficial-dev -C \
  "sh -lc 'cd /app && npm run board-manager:ops -- status'"
```

If the scope is intentionally ready to run, ensure the cadence/action budget and
resume it:

```bash
fly ssh console --app tasknodeofficial-dev -C \
  "sh -lc 'cd /app && npm run board-manager:ops -- ensure-scope --cadence-seconds 900 --max-actions-per-hour 60 && npm run board-manager:ops -- resume --reason \"Production ramp-up\"'"
```

Expected active state:

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

If `scope.status = paused`, Hive will not run even though the machine is up. If
`board-manager` is stopped, Hive will not run even though `scope.status =
enabled`.

#### Pause Only The Hive Board

Use this before repairing project rows, task refs, Board Manager prompts, or
anything else that could be overwritten by a live Board Manager run.

```bash
fly ssh console --app tasknodeofficial-dev -C \
  "sh -lc 'cd /app && npm run board-manager:ops -- pause --reason \"Operator maintenance\"'"

fly ssh console --app tasknodeofficial-dev -C \
  "sh -lc 'cd /app && npm run board-manager:ops -- status'"
```

Paused Hive does not stop the web app, login, chat, wallet, top-up, or task
workers. It only prevents new Board Manager job claims and Hive board
mutations. Do not leave the scope paused after maintenance unless that is the
explicit operator decision.

Resume Hive:

```bash
fly ssh console --app tasknodeofficial-dev -C \
  "sh -lc 'cd /app && npm run board-manager:ops -- resume --reason \"Operator maintenance complete\"'"
```

#### Full Production Shutdown

Use this only for planned downtime. Do not delete the Fly Postgres cluster,
Fly volume, or `/data/runtime-store.json`.

1. Pause Hive first so it stops creating or executing board actions:

```bash
fly ssh console --app tasknodeofficial-dev -C \
  "sh -lc 'cd /app && npm run board-manager:ops -- pause --reason \"Planned production shutdown\"'"
```

2. Inspect Board Manager jobs. If a job is running, wait for it to complete or
   intentionally defer/recover it before stopping the machine:

```bash
fly ssh console --app tasknodeofficial-dev -C \
  "sh -lc 'cd /app && npm run board-manager:ops -- status'"
```

3. Stop the active `board-manager` machine, then the active `worker` machine,
   then the `app` machine. Use `fly status` to copy the current machine IDs:

```bash
fly status -a tasknodeofficial-dev
fly machine stop <board-manager-machine-id> -a tasknodeofficial-dev
fly machine stop <worker-machine-id> -a tasknodeofficial-dev
fly machine stop <app-machine-id> -a tasknodeofficial-dev
```

Stopping `worker` halts task generation, Network Task generation, task review,
PFTL cache workers, memory workers, and background profile jobs. Stopping
`app` makes the public site unreachable. Stop `app` last.

4. Confirm stopped state:

```bash
fly status -a tasknodeofficial-dev
```

#### Restart After Full Shutdown

Start the app first so HTTP health and SSH access are available, then restore
background processes and Hive:

```bash
fly machine start <app-machine-id> -a tasknodeofficial-dev
npm run fly:background-guard
curl -sS https://tasknodeofficial-dev.fly.dev/health
fly ssh console --app tasknodeofficial-dev -C \
  "sh -lc 'cd /app && npm run board-manager:ops -- ensure-scope --cadence-seconds 900 --max-actions-per-hour 60 && npm run board-manager:ops -- resume --reason \"Production restart\" && npm run board-manager:ops -- status'"
fly status -a tasknodeofficial-dev
```

Do not consider production fully ramped until `/health` passes, `worker` and
`board-manager` are started, and `global_hive` is either intentionally paused
or explicitly `enabled`.

The app database for `tasknodeofficial-dev` is the `tasknodeofficial` database
inside the `tasknodex-db` managed Postgres cluster. Do not point
`tasknodeofficial-dev` at any PFTasks database. If the managed database does not
have `pgvector` installed by an operator, the Jobs corpus migration skips the
vector chunk table and chat falls back to an empty Jobs retrieval slot until
`pgvector` is provisioned.

Local Docker can be run against that same Fly dev database through the Fly dev
data bridge:

```bash
npm run docker:dev:fly-data
```

This is the expected mode for local QA when Fly dev is the source of truth. It
keeps Docker and Fly on the same Postgres rows for chats, memory, tasks,
profiles, Hive, PFTL cache, and task projections. The helper writes only a
gitignored local env file, starts `fly mpg proxy`, and runs the local API/web
containers on host networking so they can reach the proxy at `127.0.0.1:16432`.
It must never be retargeted to PFTasks. Browser wallet vaults remain
origin-local, so a wallet seed imported on `localhost:5174` is still separate
from the encrypted browser vault on `tasknodeofficial-dev.fly.dev`.

The bridge also has a destructive `fly-dev:data:push` helper for replacing Fly
dev data with local Docker data. It truncates and reloads Fly dev tables, so it
is guarded: it only targets `tasknodeofficial-dev` and requires either
`TASKNODE_ALLOW_FLY_DEV_DATA_PUSH=true` or `--confirm-dev-push`. Use it only
when local Docker is intentionally the source of truth.

Telegram login only works on a stable BotFather-approved HTTPS host. For the
dev Fly app, BotFather `/setdomain` must be:

```text
tasknodeofficial-dev.fly.dev
```

The Fly app must also carry the same runtime hostname:

```bash
fly secrets set TELEGRAM_AUTH_WIDGET_DOMAIN=tasknodeofficial-dev.fly.dev -a tasknodeofficial-dev
fly secrets set TELEGRAM_AUTH_BOT_USERNAME=<bot username> -a tasknodeofficial-dev
fly secrets set TELEGRAM_BOT_WEBHOOK_SECRET=<random webhook secret> -a tasknodeofficial-dev
fly secrets set DISCORD_REDIRECT_URI=https://tasknodeofficial-dev.fly.dev/api/auth/callback/discord -a tasknodeofficial-dev
```

After deploy, verify `/api/auth/providers` reports Telegram and Discord as
`ready` before testing account linking in Settings.

Telegram bot chat for linked accounts uses this webhook:

```text
https://tasknodeofficial-dev.fly.dev/api/integrations/telegram/webhook
```

Register it with Telegram using the same secret token:

```bash
curl -sS "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H "content-type: application/json" \
  -d '{"url":"https://tasknodeofficial-dev.fly.dev/api/integrations/telegram/webhook","secret_token":"<random webhook secret>","allowed_updates":["message","callback_query"]}'
```

Email signup on Fly dev uses Resend. The current dev sender is:

```text
Task Node <login@agti.net>
```

Configure it with:

```bash
fly secrets set EMAIL_DELIVERY_PROVIDER=resend -a tasknodeofficial-dev
fly secrets set EMAIL_FROM='Task Node <login@agti.net>' -a tasknodeofficial-dev
fly secrets set RESEND_API_KEY=<resend api key> -a tasknodeofficial-dev
```

The API key can also live in the gitignored local `.env.tasknodeofficial-dev`
file for Docker. Do not commit the key or `resend_key.txt`.

Verify email readiness and delivery with:

```bash
curl -sS https://tasknodeofficial-dev.fly.dev/api/auth/providers
curl -sS -X POST https://tasknodeofficial-dev.fly.dev/api/auth/email/start \
  -H 'content-type: application/json' \
  --data '{"email":"you@example.com"}'
```

Until auth/account/wallet state is fully Postgres-backed, keep the Fly volume
mounted for the web process. Do not use `TASKNODE_ALLOW_PUBLIC_EPHEMERAL_STORE`
as a production durability substitute.

If local production Docker was tested, also run:

```bash
SMOKE_BASE_URL=http://127.0.0.1:8080 npm run smoke
FRAME_BASE_URL=http://127.0.0.1:8080 npm run frame-smoke
```

Deploy:

```bash
npm run fly:deploy
```

`npm run fly:deploy` runs `fly deploy` and then `npm run fly:background-guard`.
The guard is required because `worker` and `board-manager` are non-HTTP Fly
process groups; the `http_service.min_machines_running` setting only keeps the
public `app` process alive. The guard starts one machine for each background
group if Fly left it stopped and sets those machines to `restart=always`.

Verify:

```bash
curl -s https://tasknodeofficial-dev.fly.dev/health
SMOKE_BASE_URL=https://tasknodeofficial-dev.fly.dev npm run smoke
FRAME_BASE_URL=https://tasknodeofficial-dev.fly.dev npm run frame-smoke
npm run fly:background-guard
fly status -a tasknodeofficial-dev
```

Logs:

```bash
fly logs -a tasknodeofficial-dev
```

SSH shell:

```bash
fly ssh console -a tasknodeofficial-dev
```

Machine-local health check from inside the shell:

```bash
curl http://127.0.0.1:8080/health
```

## Decision Table

| Need | Use | URL |
| --- | --- | --- |
| Fast UI/server iteration | Local Docker dev | `http://localhost:5174` |
| Test production image locally | Local production Docker | `http://localhost:8080` |
| Remote release candidate | Fly dev release | `https://tasknodeofficial-dev.fly.dev` |

## Important Boundaries

- `Dockerfile.dev` and `docker-compose.dev.yml` are local-only development
  tooling.
- `Dockerfile` and `fly.toml` are the release path.
- Do not deploy directly to Fly for small UI edits unless remote machine
  behavior is what you are testing.
- Do not treat the local Docker dev volume as production data.
- Do not commit secrets or paste secret values into docs, prompts, commits, or
  chat logs.
- Do not point historical context restore at a shallow current-balance RPC. Use
  `PFTL_HISTORY_WSS_URL` for full-history `account_tx` discovery.

## Reviewer To Do List

Review implementation against this document (DEPLOYMENT). Mark each item when verified.

### Memory Efficiency
- [ ] Operational paths use checkpoints, caches, or bounded batch sizes.
- [ ] Fly and Docker topologies document resource expectations per service.

### Code Quality
- [ ] Commands, env vars, and file paths verified against repo.
- [ ] Deploy commands match `fly.toml`, Dockerfile, and compose files.

### Coherence
- [ ] Doc aligns with wiki and spec docs for same topic.
- [ ] Three run paths (dev Docker, prod Docker, Fly) boundaries consistent with BOOTUP.

### Bloat
- [ ] Engineering doc scoped to its audience; defers product detail to wiki.
- [ ] Deployment doc avoids duplicating full env inventory from BOOTUP.

### Security
- [ ] No secrets committed; custody boundaries explicit.
- [ ] Important Boundaries section: no secrets in docs, archive RPC for history only.
