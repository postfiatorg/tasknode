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
| `app` | `node server/index.js` (role `web`) | Public web/API process |
| `worker-pftl` | `node server/worker-entry.js` (role `worker:pftl`) | PFTL cache/watcher/archive/reducer/retention work |
| `worker-taskgen` | `node server/worker-entry.js` (role `worker:taskgen`) | Personal and network task generation |
| `worker-task-review` | `node server/worker-entry.js` (role `worker:task-review`) | Verification, review, and reward transitions |
| `worker-context-rewrite` | `node server/worker-entry.js` (role `worker:context-rewrite`) | Async Context rewrites |
| `worker-hive` | `node server/worker-entry.js` (role `worker:hive`) | Hive context secretary, reports, and Kimi activity narrator |
| `worker-memory-profile` | `node server/worker-entry.js` (role `worker:memory-profile`) | Memory and profile/recommendation work |
| `worker-airdrop` | `node server/worker-entry.js` (role `worker:airdrop`) | Daily airdrop work |
| `worker-nft-renderer` | `node server/worker-entry.js` (role `worker:nft-renderer`) | Isolated Profile NFT image rendering |
| `board-secretary` | `node scripts/hive-board-secretary-worker.mjs` | Advisory Hive board-status memo generation |

Kimi K3 in the operator-host Corbanu TUI is the production task manager.
`board-secretary` writes advisory project-status memos. The obsolete GLM Hive
selector, legacy automatic manager launchers, experimental project planner,
and disabled accounting harvester have been deleted. No deployment flag can
restart those modules. `worker-hive` retains the three support workers above.

## Current Release Command

The checked-in production wrapper is:

```bash
npm run fly:deploy:prod
```

Its sequence is:

1. run the migration-discovery smoke;
2. run the Fly deploy preflight, which requires the explicit production-host
   confirmation and `restart=always` coverage for every process group;
3. run remote `fly deploy`; Fly runs `node scripts/migrate-db.mjs` as the
   release command before replacing any machine, and a failing migration
   aborts the release; and
4. run the background guard.

The background guard is **read-only by default**. It verifies one active,
`restart=always` machine for each of the nine background groups
(`worker-pftl`, `worker-taskgen`, `worker-task-review`,
`worker-context-rewrite`, `worker-hive`, `worker-memory-profile`,
`worker-airdrop`, `board-secretary`, `worker-nft-renderer`). The `app` group is
covered by the Fly HTTP health check on `/health`. The guard changes machines
only when `scripts/fly-worker-guard.mjs` is invoked with `--fix`.

## State and Durability

| Store | Current role | Durability requirement |
| --- | --- | --- |
| Postgres | Chat, billing, Context revisions, Memory, Tasks/projections, Hive, profiles, collaboration state, PFTL cache, queues | Managed database with tested backups/restores and migration control |
| Runtime-store JSON | Remaining unmigrated state only (for example Telegram bot preferences and wallet-initiation grant eligibility inputs). Sessions, accounts, auth challenges, wallet links, deposit accounts, and terminal sessions must be Postgres-backed or public startup is refused (`assertDurableRuntimeAuthority`) | Fly volume at `/data/runtime-store.json`; never an undeclared `/tmp` path in production |
| Browser state | Cookies, contact-label cache, encrypted wallet vault, same-tab unlocked session | User/browser controlled; not recovered from server backups |
| PFTL/IPFS | Protocol transactions/pointers and applicable encrypted/public payloads | External canonical/replay boundary varies by event kind |
| Nostr relays | Encrypted NIP-17 user-message gift wraps | Independent best-effort retention; not a guaranteed archive |
| PFDocs deployment | Collaborative document runtime | Separate service, storage, backup, and capability boundary |

The runtime store still holds unmigrated product state. Deleting or replacing
its volume can change Telegram preferences and wallet-initiation eligibility
even when Postgres is intact. The volume also pins the `app` group to one
machine; finishing the Postgres migration removes that constraint.

## Secrets and Least Privilege

The deployment requires environment-specific classes of secrets for:

- application session/auth signing;
- database access;
- Vercel primary inference and Ambient backup;
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
