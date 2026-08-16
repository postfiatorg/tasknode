# Bootup

This page describes the current checkout-to-local-app path. It does not grant
authority to deploy the official service.

## Prerequisites

- Node 20
- npm and the checked-in lockfile
- Docker and Docker Compose for the normal full-stack workflow
- a browser
- Chrome only for browser/frame smoke scripts that require it

Fly CLI and official-service credentials are production-operator tools, not
public development prerequisites.

## Install and Build

From the repository root:

```bash
npm ci
npm run build
```

The checked-in npm configuration disables lifecycle scripts, the automatic npm
audit prompt, funding output, and registry retries. That is installation
behavior, not proof that dependencies are secure. Run the explicit audit in the
open-source release gate.

## Local Node Start

To run the built web/API process without Docker:

```bash
PORT=8080 npm start
```

Open `http://127.0.0.1:8080`.

Without a configured database/provider environment, the server uses
development fallbacks and configuration-gated responses. It is useful for
contract work but does not reproduce the complete production system.

For frontend-only iteration:

```bash
npm run dev
```

Open `http://127.0.0.1:5174`. Vite alone does not prove API, database, worker,
wallet, or provider behavior.

## Local Docker Start

The current full-stack command is:

```bash
npm run docker:dev -- -d
```

Open `http://localhost:5174`. Stop the stack with:

```bash
npm run docker:dev:down
```

Current safety warning: `docker-compose.dev.yml` publishes Postgres, API, and
Vite ports on the host, enables dev authentication, starts PFTL cache activity,
and uses external/testnet RPC defaults unless they are overridden. One local
PFTL path allows insecure TLS explicitly. Run this stack only on a trusted
machine and do not treat it as a network-isolated sandbox.

Before broad public onboarding, the default stack must bind to loopback, use
synthetic data, disable external network calls/autonomous workers, and require
an explicit integration profile for testnet access.

## Current State Stores

Task Node has two application state layers:

- Postgres stores Chat, billing, Context revisions, Memory, Tasks/projections,
  Hive, profiles, collaboration metadata, PFTL cache rows, and worker queues.
- The JSON runtime store still holds security-relevant account/session,
  connected-identity, wallet-link, OAuth/email challenge, and related fields
  not yet migrated to Postgres.

Docker persists these through named volumes. The API runtime-store path in the
container is `/data/runtime-store.json`. The non-Docker development fallback is
under `/tmp` and is not durable. Public startup guards reject an undeclared
temporary store and development auth for a public origin.

Browser cookies, local storage, and encrypted wallet vaults are separate from
both server stores. Starting a new origin or browser profile does not copy them.

## Focused Verification

Choose checks for the boundary changed. Common commands are:

```bash
npm run format-check
npm run lint
npm run build
npm run runtime-smoke
git diff --check
```

For a running local Node server:

```bash
SMOKE_BASE_URL=http://127.0.0.1:8080 npm run smoke
FRAME_BASE_URL=http://127.0.0.1:8080 npm run frame-smoke
```

Frame smoke writes screenshots to an operating-system temporary directory
unless `FRAME_SCREENSHOT_DIR=0` is set.

The aggregate `quality` and `check` commands are not currently green because
`file-size-check` fails. The checker also needs binary-file and exception-expiry
repairs. A passing focused smoke must not be represented as a passing repository
release gate.

## First Failure Triage

If the app does not start:

- confirm Node 20 and a clean `npm ci`;
- run `npm run build` and confirm `dist/` exists;
- verify the configured port is free;
- check `/health` before debugging React state; and
- inspect database migration/startup output when database use is enabled.

If Chat does not execute:

- check `/api/chat/modes` and `/api/readiness`;
- confirm the account has usable credit;
- verify the selected mode/persona is accepted;
- verify Ambient configuration and provider reachability; and
- distinguish an interrupted browser stream from a provider failure by
  checking the persisted conversation/model-run state.

If login fails:

- check `/api/session` and `/api/auth/providers`;
- confirm cookie origin/proxy behavior;
- verify `TASKNODE_AUTH_SECRET` in production-like environments; and
- check the selected provider's callback URL, credential, and provider-side
  domain configuration. Implemented provider code is not the same as a
  correctly configured provider.

If wallet actions fail:

- confirm application login separately from local wallet unlock;
- check `/api/wallet/actions` and the account's linked-wallet metadata;
- use the supported BIP39 flow and verify the expected wallet address; and
- never paste, log, screenshot, or send a real recovery phrase while debugging.

If Context, Tasks, Hive, Profile, or rewards appear stale:

- inspect `/api/system/status` and the owning worker process;
- inspect the durable queue/projection row rather than assuming a live chain
  scan; and
- distinguish account-scoped state from wallet-scoped PFTL state.

## Official Production

`https://tasknode.postfiat.org` is the official hosted service.

Production deployment authority and topology are maintained in a separate,
access-controlled operations package. A public clone has no official deployment
target or production-data bridge.
