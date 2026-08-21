# Current System

This page describes the implemented Task Node runtime as of
2026-08-15. It is a production system, not an early mock or a thin frontend
shell.

## Product Boundary

Task Node is an account-first work application with optional wallet-backed
authority. A user can sign in, chat, and maintain native Context without a PFTL
wallet. Wallet proof and an unlocked local vault are required only for actions
that need wallet identity, signing, decryption, or protocol publication.

The product currently combines:

- AI Chat, server-owned conversations, attachments, personas/modalities,
  Context, Memory, search, and usage billing;
- personal and network Tasks with generation, acceptance, submission,
  verification, reward, projection, and replay paths;
- PFTL wallet creation/linking, a browser-encrypted seed vault, balances,
  activity, transfers, and explicit signing boundaries;
- Hive projects/chat/coordination, Directory, Profile/NFT, daily airdrops, and
  System Status;
- a PFDocs-backed Docs library and directional Team task-history grants; and
- NIP-17 encrypted user-to-user Messages addressed by Task Node handle.

PFTasks is legacy migration material. PFDocs is a separately deployed service
integrated by the Docs surface. Neither is the executable runtime for this
repository.

## Trust and Data Boundaries

### Browser

The browser owns recovery-phrase entry, wallet derivation, encrypted local-vault
storage, wallet signing, reconstruction of the wallet-derived Nostr key, NIP-17
message encryption/decryption, and decryption of supported historical encrypted
payloads. An unlocked recovery phrase may exist in page/session memory while
the wallet is unlocked; it is not sent to the Task Node API.

### Task Node web/API process

The web process serves the React build and API. It handles sessions, linked
identity metadata, wallet ownership proofs, chat/provider orchestration,
billing, Context, Tasks, Hive, profiles, collaboration metadata, and worker
control/read models. AI Chat and native Context are not end-to-end encrypted
from the Task Node service.

### Postgres and runtime-store JSON

Postgres stores chat bodies, attachments/metadata, billing, Context revisions,
Memory, Tasks and projections, Hive, profiles, collaboration state, PFTL cache
rows, and worker queues.

The durable JSON runtime store remains a production dependency for account,
session, connected-identity, wallet-link, OAuth/email challenge, and related
state that has not moved to Postgres. Production mounts it at
`/data/runtime-store.json`; a `/tmp` fallback is development-only and not
durable.

### External systems

- Ambient handles general inference. The Profile NFT renderer is an isolated
  OpenAI image-generation exception after privacy abstraction/review.
- PFTL endpoints provide balance, transaction, pointer, and replay data; IPFS
  stores applicable encrypted or public payloads.
- The separately deployed PFDocs service owns its document runtime.
- Independent Nostr relays store encrypted NIP-17 gift wraps. Task Node stores
  the public handle/key binding and relay preferences but does not proxy or save
  message bodies or the Nostr private key.
- OAuth/email providers, Ethereum RPC services, and configured analytics are
  subprocessors or external dependencies with their own data boundaries.

These boundaries require a complete public privacy/retention inventory before
open-source release.

## Repository Layout

```text
src/                         React application and browser cryptography
server/                      HTTP routes, services, repositories, workers
server/db/migrations/        Ordered Postgres migrations
shared/                      Shared contracts
reference_clients/           External client implementations/tests
scripts/                     Smoke, migration, operator, and release tooling
prompts/                     Source-controlled runtime prompts
docs/wiki/                   User/product and architecture documentation
docs/archive/                Historical material
docs/verification/           Internal evidence pending publication review
docker-compose.dev.yml       Current local stack
fly.toml                     Current official production topology
```

Large central files remain a known maintainability problem; the presence of a
feature directory does not imply that its whole boundary has been extracted
from `src/main.jsx`, `server/product-contracts.js`, or other central modules.

## Runtime Processes

The current Fly process map is defined by `fly.toml`:

| Process | Responsibility |
| --- | --- |
| `app` | Public web/API process |
| `worker-pftl` | PFTL cache, watcher, archive, reducer, retention, and replication loops |
| `worker-taskgen` | Personal and network task generation |
| `worker-task-review` | Verification, review, and reward transitions |
| `worker-context-rewrite` | Asynchronous full-document Context rewrites |
| `worker-hive` | Hive task manager, secretary/project/report/accounting work |
| `worker-memory-profile` | Chat memory and profile/recommendation work |
| `worker-airdrop` | Daily airdrop work |
| `worker-nft-renderer` | Isolated Profile NFT image rendering |
| `board-secretary` | Hive board-secretary loop |

`start:board-manager` remains only as a deliberately disabled legacy command.
Documentation or operations that expect a live `board-manager` Fly process are
obsolete.

## Authentication and Identity

Email, GitHub, Telegram, Discord, and X start/callback implementations exist.
Each provider is live only when its environment credentials, callback URL, and
provider-side configuration are correct. Development auth is permitted outside
production and is rejected by public-production startup guards.

Sessions use an HttpOnly, SameSite=Lax cookie. Connected providers resolve into
an account identity cloud. Wallet linkage is a separate signed proof; local
wallet unlock is not application login.

The route inventory and declared auth classes live in
`server/route-policies.js`, with handlers spread across `server/index.js` and
route modules. The central policy function currently enforces methods and rate
limits, not the declared `auth` field. Until authorization is centralized or a
complete route-by-route negative audit exists, the route registry is
documentation metadata rather than an authorization guarantee.

## Product Surfaces

### Chat, Context, and Memory

Chat streaming, server-side recents/history, search, attachments, usage debits,
personas/modalities, and retry/recovery behavior are implemented. Chat bodies
are plaintext application data in Postgres and request packets are sent to the
configured inference provider. Context and Memory are account-scoped inputs to
eligible chats.

Native Context is editable without wallet unlock after account login. Historical
PFTL/IPFS context restore uses cached pointer metadata and browser-side
decryption after wallet unlock. Context Refine and billed asynchronous Context
Rewrite are separate implemented paths.

### Tasks, Hive, and rewards

Task request/generation, network routing, acceptance, evidence submission,
verification requests, review decisions, reward transitions, recovery, and
Postgres projections are implemented. The deployed configuration uses the
off-chain task-lifecycle path and multiple background workers while retaining
PFTL/IPFS replay and pointer boundaries where configured. Documentation must
state which record is canonical for each event rather than claiming every row
is already chain-native.

Hive includes projects, Hive Chat, network-task routing, task management,
secretary/reporting work, contributor accounting, and the board-secretary
process. The legacy autonomous Board Manager execution flags are disabled in
the current Fly configuration.

### Wallet and top-up

Browser wallet creation, link/relink/delink proofs, local encrypted seed-vault
storage, session unlock, balance/activity reads, transfers, and explicit
wallet-bound signing flows exist. The server must never receive a recovery
phrase or decrypted private key.

Account-scoped Ethereum mainnet deposit addresses and balance sync are
configuration-gated by the xpub/RPC setup. Custody/sweep keys are not part of
the web application.

### Docs, Team, and Messages

Docs embeds a dedicated PFDocs deployment and stores the metadata/capabilities
needed for wallet-encrypted collaboration. Team grants directional read-only
task-history access and does not grant wallet, Docs, Context, Memory, or message
access.

Messages activation binds a discoverable Task Node handle to a wallet-derived
Nostr public key. The browser encrypts/decrypts NIP-17 events and talks directly
to configured relays. Contact labels may be cached in browser local storage;
message bodies and private keys are not written there by the Messages feature.

## Configuration-Gated and Intentionally Disabled Areas

Configuration-gated behavior includes provider login, inference, email
delivery, PFDocs/Docs assistants, Nostr messaging, Ethereum deposits, PFTL/IPFS
publication, analytics, and the background worker families. A route existing in
source does not prove its external provider or worker is healthy.

Current intentional limits include:

- legacy autonomous Board Manager execution is disabled; `board-secretary` is
  the active process;
- the deployed task-pointer reducer and task-accounting harvester flags are
  disabled;
- automatic/background Context manifest publication is not the default;
- MetaMask/Phantom funding and Notion/Google Docs Context imports are not live;
- Nostr relay retention is not a guaranteed permanent message archive; and
- the official deployment currently uses Post Fiat testnet endpoints named in
  `fly.toml`.

Use `/api/readiness`, `/api/system/status`, queue/database evidence, and
provider-specific checks to distinguish configured code from working runtime.

## API and Test Sources of Truth

Do not maintain another hand-copied endpoint list on this page. The executable
route/auth inventory is `server/route-policies.js`, and route ownership is in
`server/index.js` plus the route modules it dispatches to. A generated public
API/auth reference is an open-source readiness requirement.

Focused regression coverage is primarily under `scripts/` and
`reference_clients/`. The repository currently has hundreds of npm aliases and
smoke scripts rather than a conventional discoverable JavaScript test suite,
and no checked-in CI runs the aggregate gate. `npm run file-size-check` is
currently failing, so `npm run quality` and `npm run check` are not green.

## Documentation and Publication Boundary

`src/features/docs/docs-content.js` imports wiki pages and complete prompt files
into the frontend. Imported content is public to production browsers. Dated
plans, production operations, incident evidence, and unapproved prompts must be
removed from that graph before a public release.

The implementation wins when a dated plan or historical page disagrees with
current code. `docs/open-source-readiness.md` tracks the work required to create
a safe public-source, contributor, security, and production-operations
boundary.
