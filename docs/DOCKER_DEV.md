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

Local Docker also starts `tasknodeofficial-db-1`, a Postgres 16 server with the
pgvector image. The API connects to it through Docker DNS at `db:5432`; the host
port defaults to `5436` to avoid colliding with other local Postgres services.
Override it with `TASKNODE_POSTGRES_PORT` if needed. Chat history and usage
billing use this Postgres path because compose sets
`TASKNODE_DATABASE_ENABLED=true` and `DATABASE_URL` for the API. The older JSON
runtime store still backs auth/session/context/wallet records until those
surfaces are cut over.

The API container reads `.env.tasknodeofficial-dev` when that ignored local file
exists, then compose overrides the public app URL back to localhost. Keep
`OPENAI_API_KEY` there or export it before starting Docker. Frontier Instant is
the first OpenAI route and defaults to `chat-latest` through the direct OpenAI
API, not OpenRouter. Frontier Thinking uses direct OpenAI `gpt-5.5` with high
reasoning.

Private Instant and Private Thinking use OpenRouter when `OPENROUTER_API_KEY`
is present. Set `OPENROUTER_CHAT_ENABLED=false` as a kill switch if needed.
OpenRouter requests are built with
`provider.zdr=true` and `provider.data_collection="deny"`. Private Instant
defaults to `deepseek/deepseek-v4-flash`, the ranked ZDR-backed DeepSeek route
for low-latency private text. Private Thinking defaults to
`deepseek/deepseek-v4-pro` and adds `reasoning.effort="high"` with strict
provider parameter routing. Private OpenRouter requests are constrained to a
known ZDR provider allowlist instead of unconstrained price routing.
Image, PDF, and text attachments are mapped into OpenRouter chat-completion
content parts; PDF parsing uses `OPENROUTER_PDF_ENGINE` or `cloudflare-ai` by
default. OpenRouter web search is not enabled for Private modes; web-backed
answers route through Frontier modes only.

Ethereum top-up uses account-scoped deposit addresses, not wallet-connect. To
show live mainnet deposit addresses, configure:

```text
ETH_DEPOSIT_XPUB=<receive xpub for m/44'/60'/0'/0>
ETH_DEPOSIT_START_INDEX=1
ETH_DEPOSIT_RPC_URL=https://...
ETH_DEPOSIT_BALANCE_BLOCK_TAG=latest
```

The rail accepts ETH, USDC, and USDT on Ethereum mainnet. See
`docs/ETHEREUM_TOP_UPS.md` before pointing the app at a production custody
wallet.

Useful local endpoints:

```text
http://localhost:5174
http://localhost:5174/api/app-state
http://localhost:8080/health
```

Useful database commands:

```bash
npm run db:migrate
npm run db:chat-billing-smoke
npm run db:import-chat-billing -- --path /data/runtime-store.json --execute
```

When running the importer from the host instead of inside the API container,
copy the Docker JSON store first or point `--path` at a local snapshot, and set
`DATABASE_URL=postgres://tasknodeofficial:tasknodeofficial@127.0.0.1:5436/tasknodeofficial`.
The scripts opt into the database when `DATABASE_URL` is present; the server
itself requires `TASKNODE_DATABASE_ENABLED=true` so stale Fly or shell
`DATABASE_URL` values are not used accidentally.

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

Context history is populated by the PFTL cache workers and reducer. After
signing in and linking a wallet, use `GET /api/context/history` to inspect the
cached projection; wallet unlock and browser-local decryption happen only when
fetching a selected CID preview.

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

## Reviewer To Do List

Review implementation against this document (DOCKER DEV). Mark each item when verified.

### Memory Efficiency
- [ ] Operational paths use checkpoints, caches, or bounded batch sizes.
- [ ] Hot reload paths do not reload entire Postgres or corpus on every file save.

### Code Quality
- [ ] Commands, env vars, and file paths verified against repo.
- [ ] Compose service names match execution mandate container names.

### Coherence
- [ ] Doc aligns with wiki and spec docs for same topic.
- [ ] Postgres-enabled paths match DATABASE wiki inventory.

### Bloat
- [ ] Engineering doc scoped to its audience; defers product detail to wiki.
- [ ] Dev loop doc scoped to iteration; production detail in DEPLOYMENT.

### Security
- [ ] No secrets committed; custody boundaries explicit.
- [ ] Local dev secrets via env files gitignored; GitHub OAuth callback URLs documented.
