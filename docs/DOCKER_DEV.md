# Local Docker Dev

Use this path for fast local iteration. It does not replace the production
Dockerfile or Fly deploy path.

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

## Edit Loop

- Frontend edits in `src/` hot reload through Vite.
- Server edits in `server/` restart the API through `node --watch`.
- Runtime JSON state persists in the Docker volume `tasknodeofficial_dev_data`.
- Dev auth is enabled and cookies are plain localhost cookies, not Secure
  Fly/HTTPS cookies.

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

Keep using the existing production path for deployable releases:

```bash
npm run build
npm run smoke
fly deploy -a tasknodeofficial-dev -c fly.toml --remote-only
```

Local Docker dev is for rapid iteration. Fly deploys are for release candidates
that need remote machine testing.
