# Task Node

Task Node is Post Fiat's account-first coordination application. It combines AI
chat, personal and network tasks, context and memory, browser-held wallet
identity, PFTL task replay, encrypted documents, profiles, Hive coordination,
and NIP-17 private messaging.

This source candidate intentionally excludes official production deployment
configuration, credentials, operator tooling, incident/verification evidence,
generated run artifacts, and private operations documentation. Possessing this
code does not grant access to the official hosted service.

## Data boundaries

- AI Chat plaintext is persisted by the application and sent to the configured
  inference provider.
- More -> Messages encrypts in the unlocked browser and connects directly to
  independent Nostr relays; the Task Node server stores identity bindings, not
  message bodies or private Nostr keys.
- Wallet recovery phrases and signing keys are browser-side secrets. Never put
  them in configuration, logs, issues, prompts, or support messages.
- Public-chain and independently retained relay/IPFS data cannot be erased by a
  Task Node account deletion.

Read `PRIVACY.md`, `SECURITY.md`, and `TERMS.md` before operating a hosted fork.

## Local setup

Requirements are Node 20.20, npm 10.8, and optionally Docker.

```bash
npm ci
npm run check:fast
npm run build
PORT=8080 npm start
```

The process binds to `127.0.0.1` outside production unless
`TASKNODE_BIND_HOST` is explicitly set.

The default Docker stack is loopback-only and disables external protocol
workers and paid-model credentials:

```bash
npm run docker:dev -- -d
```

Testnet connectivity is an explicit override:

```bash
npm run docker:integration -- -d
```

## Hosted runtime images

Build the public HTTP service and background workers as separate images:

```bash
docker build --target web-runtime -t tasknode-web .
docker build --target worker-runtime -t tasknode-worker .
```

The web target contains the HTTP entrypoint, browser assets, and 16 declared
backend packages. It does not contain worker orchestration. The worker target
contains the worker entrypoint and six declared backend packages; it contains
neither the HTTP entrypoint nor browser assets. Both targets omit npm/npx and
run as the unprivileged `node` user.

Deploy them as separate services using `fly.example.toml` and
`fly.worker.example.toml` as synthetic examples. Every worker process must set
one explicit split role such as `TASKNODE_PROCESS_ROLE=worker:taskgen`; the
worker entrypoint rejects the broad monolith role in production. Give each
service only the database role and provider credentials required for its work.

## Contributing and support

See `CONTRIBUTING.md` for review and verification rules, `SECURITY.md` for
private vulnerability reporting, and `SUPPORT.md` for product support. Project
names and logos remain governed by `TRADEMARKS.md`.

Task Node is distributed under the MIT License. Project names and logos remain
governed separately by `TRADEMARKS.md`.
