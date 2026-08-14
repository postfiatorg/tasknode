# Docs and Team deployment runbook

Status: enabled in production on 2026-08-12. Docs uses an embedded PFDocs
workspace; Team and Docs retain independent feature flags.

## Release units

1. `tasknodeofficial`: migration 110, collaboration APIs, wallet challenge
   proofs, encrypted Docs library, directional Team grants, read-only teammate
   task views, and `#help` route migration.
2. `pftdocs`: strict-origin `/tasknode/` capability bridge, rich-text-only
   product surface, and bounded storage retention defaults.

Task Node Postgres is authoritative for identity, invitations, grants,
revocations, and the opaque document index. PFDocs channels are authoritative
for encrypted document content. The Task Node server never receives pad edit or
view URLs in plaintext. Nostr binding is optional and is not an entitlement
source.

## Required production configuration

PFDocs:

```text
PFDOCS_TASKNODE_ORIGINS=https://tasknode.postfiat.org
PFDOCS_MAIN_ORIGIN=https://tasknode-pfdocs.fly.dev
PFDOCS_SANDBOX_ORIGIN=https://tasknode-pfdocs-sandbox.fly.dev
```

Task Node:

```text
PFDOCS_PUBLIC_ORIGIN=https://tasknode-pfdocs.fly.dev
PFDOCS_TASKNODE_BRIDGE_PATH=/tasknode/
TASKNODE_TEAM_ENABLED=true
TASKNODE_DOCS_ENABLED=true
TASKNODE_PFDOCS_EDITOR_ENABLED=true
TASKNODE_DOCS_ODV_ENABLED=true
```

`TASKNODE_DOCS_ENABLED` controls the native Task Node Docs screen and encrypted
library APIs. It may be enabled independently of the editor transport.
`TASKNODE_PFDOCS_EDITOR_ENABLED` controls create/open operations and must remain
false until both PFDocs origins are HTTPS and the PFDocs main and sandbox
origins are distinct and healthy.
`TASKNODE_DOCS_ODV_ENABLED` independently disables the `@ODV` document-chat
inference path without disabling encrypted human chat or document editing.

Production PFDocs runs in the dedicated `tasknode-pfdocs` Fly app with its own
encrypted `pfdocs_data` volume. Its isolated editor origin is the stateless
`tasknode-pfdocs-sandbox` Fly app. It must not run on the Task Node app machine
or on the `productionrpc` host.

## Deployment order

1. Back up PFDocs datastore/block/blob/pin volumes and Task Node Postgres.
2. Deploy PFDocs with `PFDOCS_TASKNODE_ORIGINS` configured. Verify `/tasknode/`
   denies an unlisted origin and creates separate edit/view links for the
   listed Task Node origin.
3. Deploy Task Node with both feature flags false. Migration 110 applies on
   application startup.
4. Enable `TASKNODE_TEAM_ENABLED=true` for the dark-launch environment. With
   two real accounts and wallets, test Collaborator, Manager, and Direct Report
   from both viewpoints, then test grant revocation.
5. Enable `TASKNODE_DOCS_ENABLED=true` for the dark-launch environment. Test
   setup, embedded create, rename sync, embedded open, viewer share, editor
   share, accept/decline, archive/restore, recovery export, locked-wallet
   behavior, and confirm no popup is created.
6. Measure PFDocs datastore growth under repeated edits and confirm the 180-day
   inactive, 30-day archive, and 20 MiB upload settings on the deployed config.
7. Enable Team and then Docs in production. Keep the flags independent.

## Security acceptance

- Database challenge rows are single-use, five-minute, payload-digest-bound,
  and verified against the currently linked wallet.
- Exact identity resolution does not provide fuzzy directory enumeration.
- All Docs and Team APIs require a Task Node session and have rate limits.
- Teammate task list and detail share one `requireTaskHistoryGrant` gate.
- A Manager relationship exposes the subject's tasks only to the manager; a
  Direct Report relationship exposes the report's tasks only to the manager;
  Collaborator creates both directions.
- PFDocs `postMessage` uses an exact configured origin, validates request IDs,
  and never uses `*`.
- Task Node accepts PFDocs events only from the configured iframe window and
  exact PFDocs origin. PFDocs sandbox CSP permits exactly PFDocs main and Task
  Node in the nested ancestor chain.
- PFDocs title events carry an exact channel hash; Task Node re-encrypts owned
  document titles locally and stores only the encrypted metadata envelope.
- Human document-chat names come from the authenticated Task Node handle or
  linked wallet context. `@ODV` rechecks document/channel access before sending
  the bounded current document and recent chat packet to Ambient GLM 5.2.
- Wallet delink is blocked when that wallet is the active Docs envelope unless
  the caller explicitly acknowledges permanent Docs access loss.

CryptPad capabilities are bearer capabilities. Removing a Task Node grant
stops mailbox/list delivery but cannot make a capability already copied by a
recipient disappear. For a compromised or revoked edit capability, the owner
must rotate the pad password/capability in PFDocs and re-share the replacement.
The UI and operator runbook must not claim server-side revocation erases an
already-delivered capability.

## Verification commands

Task Node:

```bash
npm run build
npm run collaboration-contract-smoke
npm run migration-registration-smoke
npm run jsx-react-import-check
```

PFDocs:

```bash
node --test scripts/tests/postfiat-tasknode-bridge.test.js
node scripts/pfdocs-tasknode-embed-smoke.mjs
npx eslint www/tasknode/main.js lib/env.js
```

## Rollback

Set `TASKNODE_DOCS_ODV_ENABLED=false` to disable only document-chat inference.
Set `TASKNODE_DOCS_ENABLED=false` and/or `TASKNODE_TEAM_ENABLED=false`; this
hides the navigation and makes the corresponding API return disabled without
deleting encrypted data or grant history. Roll back PFDocs separately only
after leaving its persistent volumes intact. Migration 110 is additive and
does not need to be reversed for application rollback.
