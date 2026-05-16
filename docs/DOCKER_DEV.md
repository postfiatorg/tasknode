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

The API container reads `.env.tasknodeofficial-dev` when that ignored local file
exists, then compose overrides the public app URL back to localhost. Keep
`OPENAI_API_KEY` there or export it before starting Docker. Frontier Instant is
the first OpenAI route and defaults to `chat-latest` through the direct OpenAI
API, not OpenRouter. Frontier Thinking uses direct OpenAI `gpt-5.5` with high
reasoning.

Private Instant and Private Thinking use OpenRouter only when
`OPENROUTER_API_KEY` is present and `OPENROUTER_CHAT_ENABLED=true` or
`TASKNODE_ENABLE_OPENROUTER_CHAT=true`. OpenRouter requests are built with
`provider.zdr=true` and `provider.data_collection="deny"`. Private Instant
defaults to `qwen/qwen3-vl-8b-instruct` so image uploads are not left to
unpredictable router selection. Private Thinking defaults to
`deepseek/deepseek-v4-pro` and adds `reasoning.effort="high"` with strict
provider parameter routing.
Image, PDF, and text attachments are mapped into OpenRouter chat-completion
content parts; PDF parsing uses `OPENROUTER_PDF_ENGINE` or `cloudflare-ai` by
default. OpenRouter web search is intentionally separate and remains off unless
`OPENROUTER_WEB_SEARCH_ENABLED=true` or
`TASKNODE_ENABLE_OPENROUTER_WEB_SEARCH=true`.

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

Historical context restore is configured separately and defaults to the
canonical full-history archive WSS endpoint:

```text
PFTL_HISTORY_WSS_URL=wss://ws-archive.testnet.postfiat.org
PFTL_HISTORY_RPC_URL=https://rpc.testnet.postfiat.org:5006/
PFTL_HISTORY_ACCOUNT_TX_LIMIT=200
PFTL_HISTORY_ACCOUNT_TX_MAX_PAGES=8
```

Use `POST /api/context/history/rpc/import` only after signing in and linking a
wallet. The endpoint imports encrypted context CID metadata; wallet unlock and
browser-local decryption happen afterward.

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
