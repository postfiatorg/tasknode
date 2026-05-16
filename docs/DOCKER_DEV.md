# Local Docker Dev

Use this path for fast local iteration. It does not replace the production
Dockerfile or Fly deploy path.

For the full deployment matrix, including local production Docker and Fly, read
`DEPLOYMENT.md`.

## Start

```bash
cd /home/pfrpc/repos/tasknodeofficial
docker compose -f docker-compose.dev.yml up --build
```

Or detached:

```bash
npm run docker:dev -- -d
```

Open:

```text
http://localhost:5174
```

The Vite container serves the app and proxies API/config calls to the local Node
API container.

Useful local endpoints:

```text
http://localhost:5174
http://localhost:5174/api/app-state
http://localhost:8080/health
```

## Local PFTL Balance Reads

`docker-compose.dev.yml` points wallet balance reads at the same rapid PFTL host
PFTasks uses on this machine:

```text
PFTL_WSS_URL=wss://178.156.143.199:6005
PFTL_WSS_REJECT_UNAUTHORIZED=false
PFTL_RPC_URL=http://178.156.143.199:5005
```

The balance endpoint uses WSS first, then falls back to JSON-RPC:

```text
http://localhost:5174/api/wallet/balance
```

The endpoint requires a signed-in session with a linked wallet, so a plain curl
without cookies should return `wallet_login_required`.

Use this local node for current balances only. It intentionally has less ledger
history than the canonical public Post Fiat endpoints, so historical transaction
or context pulls should keep their archive/index-first path.

## Edit Loop

- Frontend edits in `src/` hot reload through Vite.
- Server edits in `server/` restart the API through `node --watch`.
- Runtime JSON state persists in the Docker volume `tasknodeofficial_dev_data`.
- Dev auth is enabled and cookies are plain localhost cookies, not Secure
  Fly/HTTPS cookies.

## Local GitHub OAuth

GitHub login needs local OAuth credentials in the API container:

```bash
GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=... npm run docker:dev -- -d
```

The local GitHub OAuth callback URL is:

```text
http://localhost:5174/api/auth/callback/github
```

Use a separate GitHub OAuth app for local development unless the existing app is
configured for that exact callback URL.

## Logs And Shells

```bash
npm run docker:dev:logs
docker compose -f docker-compose.dev.yml exec api sh
docker compose -f docker-compose.dev.yml exec web sh
```

## Stop

```bash
npm run docker:dev:down
```

To wipe local app state:

```bash
docker compose -f docker-compose.dev.yml down -v
```

## Release Path

Keep using the production path for deployable releases:

```bash
npm run build
npm run smoke
fly deploy -a tasknodeofficial-dev -c fly.toml --remote-only
```

Local Docker dev is for rapid iteration. Fly deploys are for release candidates
that need remote machine testing.
