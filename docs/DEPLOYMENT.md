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
- Vite proxies `/api`, `/health`, `/runtime-config.js`, and
  `/runtime-config.json` to the API container.

Behavior:

- `src/` changes hot reload in the browser.
- `server/` changes restart the API through `node --watch`.
- runtime JSON state persists in the Docker volume
  `tasknodeofficial_dev_data`.
- dev auth is enabled.
- cookies are localhost cookies, not Fly HTTPS cookies.
- wallet balance reads use the same rapid PFTL host PFTasks uses on this
  machine by default: `wss://178.156.143.199:6005` first with local
  self-signed TLS allowed, then `http://178.156.143.199:5005` fallback. This is
  a current-balance path, not a historical ledger/archive pull path.
- historical context restore uses `PFTL_HISTORY_RPC_URL`, defaulting to
  `https://rpc.testnet.postfiat.org`, so context CID discovery does not depend
  on the rapid balance node's ledger depth.

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

If local production Docker was tested, also run:

```bash
SMOKE_BASE_URL=http://127.0.0.1:8080 npm run smoke
FRAME_BASE_URL=http://127.0.0.1:8080 npm run frame-smoke
```

Deploy:

```bash
fly deploy -a tasknodeofficial-dev -c fly.toml --remote-only
```

Verify:

```bash
curl -s https://tasknodeofficial-dev.fly.dev/health
SMOKE_BASE_URL=https://tasknodeofficial-dev.fly.dev npm run smoke
FRAME_BASE_URL=https://tasknodeofficial-dev.fly.dev npm run frame-smoke
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
  `PFTL_HISTORY_RPC_URL` for full-history `account_tx` discovery.
