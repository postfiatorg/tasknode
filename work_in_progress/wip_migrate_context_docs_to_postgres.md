# WIP: Migrate Context Documents To Postgres

Status: implemented locally; pending production backfill decision
Owner: Task Node Official
Created: 2026-05-17

## Current Task

Move native context documents and historical context import metadata out of the
JSON runtime store and into Postgres.

This is not a product spec and not long-term documentation. This file is the
active work tracker for the current milestone.

## Why This Matters

Context must work without a wallet. A user should be able to sign in, edit their
current context document, leave, return, and recover that context from durable
account-scoped storage.

Wallet-linked historical context is a separate path. Historical PFTasks/PFDocs
context CIDs remain wallet-owned PFTL/IPFS records. The app should cache pointer
metadata and selected restoration results, but delinking or locking a wallet
must not remove or hide the user's current native context document.

## Current Repo State

- Chat history is Postgres-backed.
- Chat text attachments are Postgres-backed.
- Billing ledger and billing summaries are Postgres-backed.
- Native context documents are Postgres-backed when
  `TASKNODE_DATABASE_ENABLED=true`, with JSON fallback during migration.
- Historical context import snapshots are cached in Postgres when
  `TASKNODE_DATABASE_ENABLED=true`, with JSON fallback during migration.
- Existing context APIs already provide the product boundary:
  - `GET /api/context`
  - `POST /api/context/edit/save`
  - `GET /api/context/history`
  - `POST /api/context/history/indexed`
  - `POST /api/context/history/rpc/import`
  - `GET /api/context/history/ipfs/:cid`
  - `POST /api/context/manifest/ink`

## Scope

Implement the Postgres storage path for:

- One active native context document per account.
- Revision history for native context edits.
- Historical context import runs.
- Historical context pointer rows discovered from indexed fixtures or PFTL RPC.
- Compatibility reads from JSON during migration.
- Idempotent JSON-to-Postgres import.

## Non-Goals

- Do not redesign the context page UX in this milestone.
- Do not make wallet unlock required for native current context.
- Do not store broad decrypted historical context plaintext by default.
- Do not make PFTL RPC the primary read path for normal page loads.
- Do not migrate task engine state in this milestone.

## Target Tables

The target schema should match `docs/DATABASE_ARCHITECTURE.md` unless we discover
a concrete reason to revise it during implementation.

### `context_documents`

Account-scoped current document metadata.

Expected responsibilities:

- stable `id`
- `account_id`
- `title`
- `current_revision_id`
- timestamps
- soft-delete or lifecycle fields if needed later

### `context_revisions`

Append-only native context edit history.

Expected responsibilities:

- `context_document_id`
- `account_id`
- `title`
- `body`
- body hash
- word count
- source metadata such as `native_editor`, `historical_restore`, or `import`
- optional provenance pointer for restored historical CIDs
- timestamps

### `context_history_imports`

One row per historical import/discovery attempt.

Expected responsibilities:

- `account_id`
- optional `wallet_address`
- source type such as `indexed_snapshot` or `pftl_rpc`
- counts
- status
- error metadata
- timestamps

### `context_history_pointers`

Normalized historical context CID metadata.

Expected responsibilities:

- `account_id`
- `wallet_address`
- `cid`
- pointer/provenance fields
- transaction hash and ledger metadata when available
- observed timestamp
- source
- dedupe key
- no decrypted plaintext body by default

## Implementation Checklist

- [x] Add a Postgres migration for context tables.
- [x] Add `server/repositories/context.js`.
- [x] Preserve the current API response shapes.
- [x] Route `GET /api/context` through Postgres when database use is enabled.
- [x] Route `POST /api/context/edit/save` through Postgres when available.
- [x] Route historical indexed imports through Postgres.
- [x] Route historical PFTL RPC imports through Postgres.
- [x] Keep JSON runtime fallback for local/dev safety during migration.
- [x] Add an idempotent importer from existing `runtime-store.json` context data.
- [x] Add smoke tests for save/load, revision creation, import dedupe, and wallet
      delink behavior.
- [x] Confirm the UI still shows current context when no wallet is linked.
- [x] Confirm historical wallet pointers do not appear as current context unless
      explicitly restored by the user.

## Acceptance Criteria

- A logged-in account can save current context and reload it after server restart.
- Current context still works with no linked PFT wallet.
- Delinking a wallet does not delete or hide the current context document.
- Historical context pointer lists are restored from Postgres without requiring a
  fresh PFTL history scan on every page load.
- Historical encrypted CIDs are only decrypted through the existing wallet unlock
  flow.
- The server does not log native context bodies or decrypted historical bodies.
- JSON runtime context data can be imported once without duplicating revisions or
  pointer rows.

## Verification Commands

```bash
npm run db:migrate
npm run check
npm run db:context-smoke
```

```bash
DATABASE_URL=postgres://tasknodeofficial:tasknodeofficial@127.0.0.1:5436/tasknodeofficial \
TASKNODE_DATABASE_ENABLED=true \
npm run db:context-smoke
```

## Open Decisions

- Whether native context body plaintext is acceptable in Postgres for MVP, or
  whether account-scoped envelope encryption should land in the same milestone.
- Exact retention policy for deleted context revisions.
- Whether restored historical context should create a full native revision body
  immediately or require a user confirmation step first.
- Whether context embeddings should be created in this milestone or deferred to
  the pgvector retrieval milestone.
