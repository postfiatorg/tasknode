# Deployment

This page records the current deployment shape without serving as a public
production-operator handbook. Official deployment authority, incident response,
credential ownership, data bridges, backup/restore commands, and destructive
operations must move to an access-controlled operations repository before this
codebase is made public.

## Current Official Service

The public service is `https://tasknode.postfiat.org`. Its Fly application
retains the historical name `tasknodeofficial-dev`, but it is production. Do
not call it “Fly dev” or assume its database, volume, workers, or credentials
are disposable.

`fly.toml` currently defines these process groups:

| Group | Command | Role |
| --- | --- | --- |
| `app` | `npm run start:web` | Public web/API process |
| `worker-pftl` | `npm run start:worker:pftl` | PFTL cache/watcher/archive/reducer/retention work |
| `worker-taskgen` | `npm run start:worker:taskgen` | Personal and network task generation |
| `worker-task-review` | `npm run start:worker:task-review` | Verification, review, and reward transitions |
| `worker-context-rewrite` | `npm run start:worker:context-rewrite` | Async Context rewrites |
| `worker-hive` | `npm run start:worker:hive` | Hive task manager, secretary/project/report/accounting work |
| `worker-memory-profile` | `npm run start:worker:memory-profile` | Memory and profile/recommendation work |
| `worker-airdrop` | `npm run start:worker:airdrop` | Daily airdrop work |
| `worker-nft-renderer` | `npm run start:worker:nft-renderer` | Isolated Profile NFT image rendering |
| `board-secretary` | `npm run start:board-secretary` | Advisory Hive board-status memo generation |

The legacy `start:board-manager` command intentionally starts a disabled stub.
The deployed Board Manager execution flags are false. The active
`board-secretary` writes advisory project-status memos and does not execute
Board Manager actions.

## Current Release Command

The checked-in production wrapper is:

```bash
npm run fly:deploy:prod
```

Its actual sequence is:

1. run the migration-registration smoke;
2. run the Fly deploy preflight;
3. require the explicit production-host confirmation;
4. run remote `fly deploy` against the application/config in `package.json` and
   `fly.toml`; and
5. run the background guard.

The background guard is **read-only by default**. It verifies one active,
`restart=always` machine for these eight groups:

```text
worker-pftl
worker-taskgen
worker-task-review
worker-context-rewrite
worker-hive
worker-memory-profile
worker-airdrop
board-secretary
```

It does not “start or repair” machines unless the lower-level worker guard is
explicitly invoked with `--fix`. The deploy wrapper does not pass `--fix`.

The current aggregate background guard also omits `worker-nft-renderer`, and it
does not verify the public `app` group. Until the guard is corrected, a release
is not proven complete without separate evidence for the web process and NFT
renderer. This is a deployment-gate defect, not an operator convention.

Raw `fly deploy` bypasses the repository preflight and should not be the normal
official release path. Conversely, the npm wrapper is not safe public tooling:
any shell with matching Fly credentials can target the official app. Extracting
production configuration and approval to private operations is a P0
open-source requirement.

## Release Verification

A healthy HTTP response proves only the `app` process. A complete release must
verify:

- the deployed commit/image and migration registration;
- `/health` and the expected public origin;
- every process group in `fly.toml`, including `worker-nft-renderer`;
- `restart=always` for active background machines;
- required enablement flags for the worker families;
- queue progress and recent successful rows, not merely a running process;
- provider/RPC/IPFS/PFDocs/Nostr readiness for the changed boundary; and
- no unexpected database, volume, or runtime-store target.

`/api/system/status` is the product read model for many of these checks, but it
does not replace Fly machine inventory, database evidence, or an external
health probe.

The current worker guard verifies required environment values only in its
mutating `--fix` path. Read-only guard success therefore does not by itself
prove that all required worker flags are set. The release tooling should be
changed so read-only verification checks configuration too.

## State and Durability

| Store | Current role | Durability requirement |
| --- | --- | --- |
| Postgres | Chat, billing, Context revisions, Memory, Tasks/projections, Hive, profiles, collaboration state, PFTL cache, queues | Managed database with tested backups/restores and migration control |
| Runtime-store JSON | Sessions, account/connected identities, wallet links, OAuth/email challenges, and remaining unmigrated state | Fly volume at `/data/runtime-store.json`; never an undeclared `/tmp` path in production |
| Browser state | Cookies, contact-label cache, encrypted wallet vault, same-tab unlocked session | User/browser controlled; not recovered from server backups |
| PFTL/IPFS | Protocol transactions/pointers and applicable encrypted/public payloads | External canonical/replay boundary varies by event kind |
| Nostr relays | Encrypted NIP-17 user-message gift wraps | Independent best-effort retention; not a guaranteed archive |
| PFDocs deployment | Collaborative document runtime | Separate service, storage, backup, and capability boundary |

The runtime store is still security-critical product state. Deleting or
replacing its volume can invalidate sessions, identity links, wallet links, and
other account behavior even when Postgres is intact.

## Secrets and Least Privilege

The deployment requires environment-specific classes of secrets for:

- application session/auth signing;
- database access;
- Ambient inference;
- the isolated Profile NFT image renderer;
- configured OAuth and email providers;
- Telegram webhook authentication;
- Ethereum deposit address derivation/RPC access;
- PFTL/IPFS publication or privileged protocol actions; and
- any private operations/monitoring integration.

Secret values, suffixes, human credential owners, rotation incidents, and
provider dashboards do not belong in browser Help or a public repository.
Document them in the private operations system and grant each process only the
secrets it needs. `fly.toml` already removes the NFT renderer key from most
process commands; the final image/process design should extend that isolation
to all privileged capabilities.

Changing a Fly secret can restart machines. Treat it as a release: verify the
target application, affected process groups, public health, and owning product
boundary after rollout.

## Protocol and Provider Configuration

The current official configuration uses Post Fiat testnet explorer, WSS, RPC,
and archive endpoints. Current/historical PFTL endpoints have different jobs;
do not point archive scans at a low-retention current node or use an insecure
local TLS exception in production.

Provider readiness is configuration-specific:

- implemented OAuth code is not a working login until callback URLs, domains,
  and credentials match;
- an inference mode is not usable until the provider, model, billing, and
  account-credit checks pass;
- Docs requires the separately deployed PFDocs origin/bridge and its capability
  boundary;
- Messages requires configured relays and an active wallet-bound handle, while
  relay acceptance still does not guarantee permanent retention; and
- Profile NFT generation requires both privacy abstraction and the isolated
  renderer worker.

Do not publish real sender addresses, bot names, raw private hosts, private CA
exceptions, credential ownership, or incident narratives in this page.

## Local Docker Is Not Production

`docker-compose.dev.yml` currently:

- publishes Postgres, API, and Vite ports on the host;
- uses fixed local database credentials;
- enables development authentication;
- mounts the working tree into containers;
- starts cache/worker behavior; and
- contacts external/testnet endpoints by default, including a local-path TLS
  exception.

It is a trusted-machine development stack, not a hardened or isolated
deployment example. The open-source default must become loopback-only,
synthetic, network-minimal, and opt-in for testnet/provider access.

## Remote Data Bridge

The repository contains tooling that can connect local containers to remote
Fly data and a guarded path capable of pushing local data back. This is useful
internal recovery/QA machinery but is inappropriate in the default public
developer interface.

Before public release, move it to private operations and require a target
fingerprint, backup, explicit mutation mode, two-person approval, and restore
evidence. Public documentation should contain only a synthetic fixture import.

## Pause, Shutdown, and Incident Response

Do not preserve obsolete `board-manager` pause/resume instructions as if they
control the active board secretary. They operate legacy scheduler state while
the current secretary has its own enablement, lease, cadence, and memo tables.

Authoritative pause/shutdown/restart procedures must be generated from the
current process map and maintained privately. They must cover:

1. stopping mutating schedulers before data repair;
2. allowing or recovering in-flight jobs;
3. stopping background groups before the public app during full shutdown;
4. protecting Postgres, volumes, and the runtime store from deletion;
5. restarting and proving every queue/process independently; and
6. recording incident evidence without committing credentials or personal data.

The dated credential and worker-stop incident previously embedded in this page
was not appropriate canonical/public documentation. Incident facts belong in
the access-controlled incident system with owners, evidence, rotation status,
and follow-up actions.

## Open-Source Target

The candidate public repository should contain:

- a sanitized deployment architecture overview;
- `fly.example.toml` or equivalent with placeholder app/origin values;
- a safe local synthetic stack;
- public environment-variable documentation without secret values or official
  infrastructure identifiers; and
- CI instructions for building a candidate image without deployment authority.

The official app config, deploy credentials, production data tooling, full
runbooks, and incident records should be a separate protected package. The
complete release gates are in `docs/open-source-readiness.md`.
