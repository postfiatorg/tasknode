# Task Node Official

Task Node is Post Fiat's account-first work application. It combines AI chat,
personal and network tasks, context and memory, wallet-backed identity, PFTL
task replay, encrypted documents, profiles, Hive coordination, and private
Nostr messaging.

Production is served at `https://tasknode.postfiat.org`. The Fly application
retains the historical internal name `tasknodeofficial-dev`; that name does not
mean the deployment is a development environment.

## Publication Status

Task Node is licensed under the permissive MIT License. The public release is
generated from a reviewed publication allowlist so production operations,
credentials, private evidence, and internal-only material do not enter the
distributed source archive.

The evidence and release gates are in
[`docs/open-source-readiness.md`](docs/open-source-readiness.md). Generate a
release only from a clean protected commit that passes the documented gates.

## Current Product

The implemented application includes:

- Ambient-backed AI chat with streaming, account-scoped conversation history,
  attachments, usage billing, Context and Memory, and selectable personas and
  modalities;
- email, GitHub, Telegram, Discord, and X account paths, each enabled only when
  its environment-specific callback and credential configuration is complete;
- browser-created PFTL wallets, local encrypted seed vaults, wallet ownership
  proofs, transfers, activity, balances, relink/delink, and explicit signing
  confirmations for wallet-bound actions;
- personal and network task generation, acceptance, submission, verification,
  reward processing, Postgres projections, and PFTL/IPFS replay boundaries;
- native Context editing plus encrypted historical context restore;
- a PFDocs-backed encrypted Docs library, Team task-history grants, Directory,
  Profile/NFT, Memory, Hive, Help, and System Status surfaces;
- wallet-derived Nostr identities and NIP-17 user-to-user Messages addressed by
  Task Node handle; and
- split production workers for PFTL caching, task generation/review, Context
  rewrite, Hive, memory/profile work, airdrops, NFT rendering, and the Hive
  board secretary.

The system is production software, not an early interface mock or thin shell.
The implementation in `src/`, `server/`, `scripts/`, migrations, and `fly.toml`
is authoritative when a document disagrees with code.

## Data Boundaries

- AI Chat message bodies are stored in Task Node Postgres and sent to the
  configured inference provider. Attachments and derived Memory may also be
  persisted.
- More -> Messages is different: message text is encrypted in the browser and
  sent directly to independent Nostr relays. Task Node stores the public
  identity/handle binding and relay preferences, not message bodies or the
  Nostr private key.
- Wallet recovery phrases and decrypted private keys are browser-side secrets.
  The server receives public addresses, public keys, signed proofs, and signed
  transactions where required, never the recovery phrase.
- Native Context is server-side account data. Historical PFTL/IPFS context
  payloads remain encrypted until the unlocked browser decrypts them.

These statements describe the implementation; they are not a substitute for
the privacy policy and retention inventory required before public release.

## Repository Map

```text
src/                         React application
server/                      API, repositories, workers, and runtime services
server/db/migrations/        Ordered Postgres migrations
shared/                      Shared product and protocol contracts
reference_clients/           External client implementations and tests
scripts/                     Focused smoke, operator, migration, and release tools
prompts/                     Source-controlled runtime prompts
docs/wiki/                   Current user, product, and architecture documentation
docs/archive/                Historical material; not current authority
docs/verification/           Internal evidence pending public-release classification
fly.toml                     Current official production topology (pending extraction)
docker-compose.dev.yml       Local development stack
```

The in-app Help surface imports an explicit set of wiki pages and prompts from
`src/features/docs/docs-content.js`. Today that set includes internal material;
creating a reviewed public allowlist is a P0 open-source release requirement.

## Local Development

Requirements:

- Node 20;
- npm with the checked-in lockfile; and
- Docker for the normal full-stack workflow.

Install and build:

```bash
npm ci
npm run build
PORT=8080 npm start
```

Open `http://127.0.0.1:8080`.

Docker development:

```bash
npm run docker:dev -- -d
```

Open `http://localhost:5174`.

Important: the current Compose file publishes Postgres, API, and Vite ports on
the host, enables development auth, and has external PFTL/testnet defaults. Use
it only on a trusted development machine. Loopback-only, synthetic,
network-minimal defaults are a P0 requirement before broad public onboarding.

Frontend-only iteration is available with:

```bash
npm run dev
```

## Verification

Run the smallest focused check for the boundary being changed. Useful common
commands are:

```bash
npm run format-check
npm run lint
npm run build
npm run runtime-smoke
git diff --check
```

`npm run file-size-check`, and therefore the aggregate `quality` and `check`
commands, is known to fail at the reviewed baseline. Do not describe the
repository as green until the checker and violations are repaired and the
fresh-clone CI gate passes.

There are hundreds of specialized npm aliases and focused smoke scripts. They
are current engineering tools, but the command surface must be consolidated
before broad external contribution.

## Documentation

Start here:

1. [`docs/README.md`](docs/README.md) — documentation authority and audiences;
2. [`docs/wiki/index.md`](docs/wiki/index.md) — user/product Help index;
3. [`docs/wiki/architecture/current-system.md`](docs/wiki/architecture/current-system.md)
   — current runtime and trust boundaries;
4. [`docs/wiki/architecture/bootup.md`](docs/wiki/architecture/bootup.md) — local
   startup and focused checks;
5. [`docs/open-source-readiness.md`](docs/open-source-readiness.md) — publication
   blockers and release checklist.

Production deployment instructions are operator-only until official operations
are extracted from the candidate public repository. Do not run the Fly deploy
scripts from an untrusted checkout or against credentials whose target has not
been independently verified.
