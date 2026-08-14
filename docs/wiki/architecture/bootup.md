# Bootup

Bootup is the shortest path from a checkout to a running Task Node Official app.
This page owns local setup, smoke checks, startup guardrails, and first failure
triage in the Help wiki.

## Prerequisites

- Node 20 or compatible current LTS.
- npm.
- Docker for the normal local app loop.
- Fly CLI for deploy and production-state checks.
- A browser for manual UI checks.
- Chrome or `google-chrome` when running frame/browser smoke checks.

The repo intentionally disables npm lifecycle scripts, audit prompts, funding
prompts, and high-concurrency registry fetches through `.npmrc` and Docker
install flags.

## Local Docker Start

Use Docker-first local development for implementation and screenshots:

```bash
cd /home/pfrpc/repos/tasknodeofficial
npm run docker:dev -- -d
```

Open:

```text
http://localhost:5174
```

Default local Docker uses the local `tasknodeofficial` Postgres container and a
local `/data/runtime-store.json` volume. It does not share encrypted browser
wallet vaults, cookies, or local storage with Fly.

## Local Node Start

Use this path when you need the production server shape without Docker:

```bash
npm ci
npm run build
PORT=8080 npm start
```

Open:

```text
http://127.0.0.1:8080
```

For frontend-only iteration, run:

```bash
npm run dev
```

Vite serves the app on:

```text
http://127.0.0.1:5174
```

The Node or Docker paths are more representative than Vite alone because they
exercise API routes, runtime-store state, Postgres, and worker-facing contracts.

## Smoke Checks

Run the smallest check that proves the boundary you changed. Common bootup
checks:

```bash
npm run format-check
npm run runtime-smoke
SMOKE_BASE_URL=http://127.0.0.1:8080 npm run smoke
FRAME_BASE_URL=http://127.0.0.1:8080 npm run frame-smoke
```

Fly dev smoke:

```bash
SMOKE_BASE_URL=https://tasknode.postfiat.org npm run smoke
FRAME_BASE_URL=https://tasknode.postfiat.org npm run frame-smoke
```

Frame smoke writes screenshots to `/tmp/tasknodeofficial-frame-smoke` unless
`FRAME_SCREENSHOT_DIR=0` is set.

## Runtime Store And Database

Task Node currently has two durable-state layers:

- Postgres for chat, billing, tasks, Hive, profiles, memory, context caches, and
  PFTL cache rows when `TASKNODE_DATABASE_ENABLED=true`.
- JSON runtime store for remaining auth/session/account/wallet/deposit fields
  until those models are fully migrated.

Local Docker enables Postgres by default. The JSON runtime-store path inside the
API container is:

```text
/data/runtime-store.json
```

The non-Docker fallback path is:

```text
/tmp/tasknodeofficial-runtime-store.json
```

`/tmp` is not durable. Public deployments must not rely on an undeclared
temporary runtime store. Startup guardrails in `server/index.js` reject a public
`TASKNODE_PUBLIC_URL` or `VITE_SITE_ORIGIN` when dev auth is enabled or runtime
store durability is not explicitly declared.

## Environment And Secrets

Do not commit or print secret values. Local env files are gitignored:

```text
.env
.env.*
*.env
*.env.local
*.env.dev
*.env.production
```

Secret names and operational classes are documented in Deployment. The most
common boot blockers are missing `TASKNODE_AUTH_SECRET`, provider API keys,
`DATABASE_URL`, PFTL endpoint config, or Ethereum deposit config.

## Fly Dev Boot

The public dev app is:

```text
https://tasknode.postfiat.org
```

Use the npm deploy wrapper (production requires the explicit confirmation
variant):

```bash
npm run fly:deploy:prod
```

Do not use raw `fly deploy` as the normal release path. The npm wrapper deploys
and then runs the background guard so the non-HTTP `worker` and `board-manager`
process groups are started and configured.

Boot health:

```bash
curl -sS https://tasknode.postfiat.org/health
fly status -a tasknodeofficial-dev
npm run fly:background-guard
```

A passing `/health` proves the public app process is reachable. It does not
prove task generation, task review, PFTL cache loops, memory workers, or Board
Manager jobs are running. Use System Status and the Deployment page for those
worker checks.

## Common Failure Checks

If the app does not start:

- run `npm ci`;
- run `npm run build`;
- verify the port is free;
- check whether `dist/` exists;
- check `/health` before debugging frontend state.

If chat does not execute:

- check `/api/chat/modes`;
- check `/api/readiness`;
- verify `AMBIENT_API_KEY`;
- check whether the selected mode is configured and enabled.

If login behaves strangely:

- check `/api/session`;
- check `/api/auth/providers`;
- confirm cookie behavior on the same origin;
- verify `TASKNODE_AUTH_SECRET` in production-like environments.

If wallet linking fails:

- confirm the user is signed in before `/api/wallet/link/start`;
- use a 24-word BIP39 recovery phrase;
- confirm the local wallet password before submitting the link modal;
- check `/api/wallet/actions`;
- do not paste or log a real production seed during debugging.

If historical context or task state disappears:

- check PFTL cache workers in System Status;
- check `pftl_cache_operations`, `pftl_wallet_transactions`, and reducer rows;
- remember that UI reads projections, not live chain scans on every page load.
