# Database Architecture

Status: proposed target architecture
Last updated: 2026-05-17

Implementation status:

- Done first: Postgres migrations and repository coverage for chat history,
  conversation recents, conversation rename/delete, usage billing ledger,
  O(1) account billing summaries, native context current-draft cache, and historical
  context pointer caches.
- Database use is guarded by `TASKNODE_DATABASE_ENABLED=true`; this is
  intentionally stricter than merely detecting `DATABASE_URL`.
- Still JSON-backed: account/session auth records, wallet links, and Ethereum
  deposit account records. Context keeps JSON fallback during migration.
  Public startup now refuses runtime-store auth state unless a durable store is
  explicitly declared or a reviewed override is set, but the target remains
  moving these auth/account models to Postgres.
- Next cutovers should keep using repository modules rather than importing raw
  SQL from handlers.

## Purpose

Task Node Official currently keeps application state in a JSON runtime store.
That was acceptable for rapid UI and protocol iteration, but it is not
acceptable for durable accounts, chat restore, context editing, usage billing,
deposit credits, or task projections.

The target database architecture is Postgres-first for app state, while keeping
PFTL pointer events plus encrypted IPFS payloads as the canonical task protocol.
The app database is the canonical source for account, auth, context, chat, and
billing state. For tasks, it is a cache, index, queue, and read model that can
be rebuilt from PFTL/IPFS.

## Core Boundaries

1. Account state is app-native.
   OAuth identities, email identities, sessions, linked providers, billing
   balances, chat history, and native context documents belong to the Task Node
   app account.

2. Wallet state is proof-bound.
   PFT wallets are linked to accounts after wallet proof. Wallets are required
   for task protocol actions, PFT balance reads, historical PFTL context
   imports, task acceptance, submissions, and rewards.

3. Current context does not require a wallet.
   The current context document is account-scoped, saved off-chain on every
   edit, and restored from Postgres. Wallet unlock is only required for
   decrypting historical wallet-owned context CIDs before using one as a draft.

4. Chat does not require a wallet.
   User conversations, assistant responses, model metadata, attachment
   metadata, usage, and restore state are account-scoped and restored from
   Postgres.

5. Billing does not depend on the PFT wallet.
   Usage credit and Ethereum deposit addresses are keyed by app account ID, not
   linked PFT wallet address. Delinking a PFT wallet must not alter billing
   identity, credit, usage history, or top-up address.

6. Tasks require wallet ownership.
   Task surfaces may be reached through the app account, but task state is
   wallet-scoped. The database stores a fast wrapper/projection over task
   history; canonical task truth comes from PFTL pointer events and encrypted
   IPFS payloads.

7. Vector search is an index.
   pgvector helps retrieval over context, chat, and task summaries. It is never
   a source of truth. Vectors can be deleted and rebuilt from Postgres rows and
   pointer/IPFS projections.

## Deployment Shape

### Local Docker

Local Docker should run Postgres 16 with the `pgvector` extension enabled.

```text
web container
  -> api container
      -> postgres container
```

Recommended local services:

- `postgres:16`
- durable Docker volume `tasknodeofficial_pg_data`
- `DATABASE_URL=postgres://tasknodeofficial:...@db:5432/tasknodeofficial`
- migration command executed before API startup or as an explicit dev command

The existing JSON file at `/data/runtime-store.json` becomes migration input
only.

### Fly

Fly deployments should use a managed Postgres attachment or an external managed
Postgres provider exposed through `DATABASE_URL`.

The Fly app must not rely on:

- `/tmp/tasknodeofficial-runtime-store.json`;
- a JSON file in the container image;
- a single-machine volume for account, billing, or chat state.

### Optional Redis

Redis can be added later for rate limits, short-lived locks, and hot ephemeral
caches. It must not own account, billing, task, context, or chat truth.

## Logical Schema

The schema should be split by product boundary. Feature code should not import
raw database clients directly. Use repository modules so future migrations do
not spread SQL across the app.

Recommended modules:

```text
server/db/
  migrations/
  pool.js
  migrate.js

server/repositories/
  accounts.js
  auth.js
  wallets.js
  context.js
  chat.js
  billing.js
  deposits.js
  tasks.js
  pftl-index.js
  vectors.js
  jobs.js
```

## Accounts And Linked Identities

The app account is the stable user identity for the web app. Provider accounts
are linked to it.

Tables:

```text
app_accounts
  id
  status
  display_name
  primary_provider
  assurance
  primary_email_canonical
  primary_email_verified
  created_at
  updated_at
  last_seen_at

account_identities
  id
  account_id
  provider
  provider_user_id_hash
  provider_user_id_ciphertext nullable
  username
  profile_url
  email_canonical nullable
  email_verified
  linked_at
  last_login_at
  status
  unique(provider, provider_user_id_hash)

account_merge_events
  id
  source_account_id
  target_account_id
  actor_account_id
  reason
  created_at
  metadata_json
```

Rules:

- One external provider identity maps to one app account.
- Account linking is explicit. Provider conflicts fail closed.
- Email-only accounts can exist, but email identity does not qualify for
  wallet initiation rewards.
- Future GitHub/X/Telegram/Discord linking should use this same identity table,
  not provider-specific one-off columns.
- Account merge is an audited operation, not an implicit side effect.

## Sessions And Auth Challenges

Sessions and challenges are app-native and short-lived.

Tables:

```text
account_sessions
  id
  account_id
  assurance
  created_at
  expires_at
  revoked_at nullable
  user_agent_hash nullable
  ip_hash nullable

oauth_states
  id
  provider
  account_id nullable
  redirect_path
  code_verifier_hash nullable
  created_at
  expires_at
  consumed_at nullable

email_challenges
  id
  email_canonical
  code_hash
  attempt_count
  created_at
  expires_at
  consumed_at nullable
```

Expired rows may be deleted by a maintenance job after a retention window.

## Wallet Links

Wallet links are proof records. They never store seed phrases, private keys,
mnemonics, wallet passwords, or local vault ciphertext.

Tables:

```text
pft_wallet_links
  id
  account_id
  wallet_address
  public_key
  status
  linked_at
  delinked_at nullable
  last_proof_at
  proof_method
  unique(account_id, wallet_address, status active)

wallet_challenges
  id
  account_id
  purpose
  challenge_hash
  created_at
  expires_at
  consumed_at nullable

wallet_initiation_grants
  id
  account_id
  wallet_address
  amount_drops
  amount_pft
  status
  provider
  provider_identity_hashes_json
  faucet_address nullable
  tx_hash nullable
  error nullable
  created_at
  updated_at
```

Rules:

- Delink marks the active wallet link inactive. It does not delete historical
  link rows.
- Relink requires a fresh wallet proof.
- Wallet initiation reward eligibility is enforced by account ID, wallet
  address, and provider identity hash.
- The wallet link is not the billing identity.

## Current Context Documents

Current context is account-scoped and off-chain. It should be saved in Postgres
on every edit or explicit save. It must work before a wallet is linked.

Tables:

```text
context_documents
  id
  account_id
  title
  current_revision_id
  revision
  created_at
  updated_at
  deleted_at

context_revisions
  id
  context_document_id
  account_id
  revision
  title
  body
  body_sha256
  word_count
  created_at
  source
  provenance_json
```

Rules:

- One active native context document per account.
- Native editor saves update the current draft row in place. They are durable
  enough to restore the current document, but they are not long-term history.
- The only long-term context history is the PFTL/IPFS pointer stream. Publishing
  to PFT creates the immutable record; cached pointer metadata lives under
  `context_history_pointers`.
- The server may read the current context body for chat/task context assembly.
  That means it cannot require wallet unlock.
- Database backups and logs must treat context as sensitive. Do not log bodies.
- Deleting or delinking a wallet must not delete the current context document.

## Historical Context Projection

Historical context documents are wallet-owned PFTL/IPFS records. The app
caches pointer metadata and optional previews separately from the current
native context document.

Tables:

```text
context_history_imports
  id
  account_id
  wallet_address
  source
  status
  pointer_count
  context_update_count
  task_event_count
  metadata_json
  created_at

context_history_pointers
  id
  import_id
  account_id
  wallet_address
  cid
  pointer_type
  kind
  kind_label
  tx_hash
  ledger_index
  memo_index
  pointer_created_at nullable
  source
  metadata_json
```

Rules:

- Pointer rows are scoped by account plus linked wallet.
- Without the linked wallet, historical rows are hidden from the UX.
- Wallet unlock is required only for browser-side decryption of encrypted
  context CIDs.
- If a historical document is restored with "Use as draft", it becomes a new
  native `context_revisions` row. The original pointer row remains historical
  metadata.
- Previews may be cached only after an explicit decrypt/restore flow and should
  be short, policy-controlled summaries, not a second hidden context document.

## Chat And Attachments

Chats are app account state. They must restore from Postgres across sessions and
devices.

Tables:

```text
chat_conversations
  id
  account_id
  title
  status
  created_at
  updated_at
  last_message_at
  last_message_preview
  mode

chat_messages
  id
  conversation_id
  account_id
  role
  body
  provider
  model
  response_id nullable
  created_at
  metadata_json

chat_model_runs
  id
  conversation_id
  account_id
  request_message_id
  response_message_id nullable
  provider
  model
  mode
  status
  input_tokens
  output_tokens
  total_tokens
  web_search_calls
  tool_cost_usd
  model_cost_usd
  total_cost_usd
  started_at
  completed_at nullable
  error nullable

chat_attachments
  id
  account_id
  conversation_id
  message_id
  ordinal
  name
  mime_type
  kind
  source
  size_bytes
  sha256
  text_content nullable
  text_excerpt nullable
  storage_uri nullable
  created_at
  metadata_json
```

Rules:

- The thread list comes from `chat_conversations`.
- The visible transcript comes from `chat_messages`.
- Pasted code/text and text-file content is persisted in `text_content` because
  it is part of the user interaction and required for restore/replay.
- PDFs, images, and binary files store metadata plus hash only unless an
  encrypted external object store/IPFS pointer is added in `storage_uri`.
- Provider run cost and token accounting comes from `chat_model_runs` and the
  billing ledger.
- Large files should live in object storage or IPFS-compatible storage, not in
  Postgres bytea by default.
- Attachment extracted text can be chunked into retrieval tables, but the
  original attachment metadata remains the source.

## Billing, Usage, And Deposits

Billing is account-scoped. The ledger is append-only. Balance is derived, not
mutated directly.

Tables:

```text
billing_accounts
  account_id
  currency
  status
  created_at
  updated_at

billing_ledger_entries
  id
  account_id
  kind
  amount_usd
  source
  conversation_id nullable
  model_run_id nullable
  deposit_event_id nullable
  idempotency_key nullable
  metadata_json
  created_at
  unique(idempotency_key)

ethereum_deposit_accounts
  id
  account_id
  chain_id
  network
  address
  address_key
  derivation_index
  derivation_path
  status
  custody
  withdrawals_enabled
  sweep_status
  created_at
  updated_at
  unique(address_key)

ethereum_deposit_observations
  id
  deposit_account_id
  asset
  contract_address nullable
  block_tag
  observed_raw_balance
  credited_raw_balance
  observed_at
  tx_hash nullable
  metadata_json

ethereum_deposit_credit_events
  id
  deposit_account_id
  account_id
  asset
  raw_delta
  amount_usd
  billing_ledger_entry_id
  observed_at
  idempotency_key
  unique(idempotency_key)
```

Ledger entry kinds:

```text
account_credit
chat_debit
top_up_credit
refund_credit
reward_credit
admin_adjustment
```

Rules:

- USD credit is computed from ledger rows:
  `credits - debits + adjustments`.
- Ethereum deposit addresses are keyed by account ID.
- ETH, USDC, and USDT deposit sync writes observations first, then idempotent
  credit events, then billing ledger credit rows.
- Sweeps must not create negative credits or double-count deposits.
- A linked PFT wallet has no authority over USD app credit.

## Task Wrapper And PFTL Index

Tasks are wallet-scoped. The database stores projections so the UI is fast, but
canonical task history must replay from PFTL pointer events and encrypted IPFS
payloads.

Tables:

```text
pftl_pointer_events
  id
  wallet_address
  counterparty_wallet nullable
  tx_hash
  ledger_index
  tx_index
  memo_index
  direction
  pointer_kind
  schema_version
  cid
  task_id nullable
  context_id nullable
  flags_json
  observed_at
  source_rpc
  unique(tx_hash, memo_index)

ipfs_payload_cache
  cid
  content_kind
  schema_version
  encrypted_sha256
  encrypted_size
  hydrated_at nullable
  hydrate_status
  decrypt_status
  summary_json nullable
  error nullable

task_events
  id
  task_id
  event_type
  source
  source_tx_hash nullable
  source_cid nullable
  actor_wallet nullable
  subject_wallet
  authority_wallet nullable
  allocation_wallet nullable
  canonical_order
  payload_json
  created_at
  unique(task_id, event_type, source_tx_hash, source_cid)

task_projections
  task_id
  subject_wallet
  account_id nullable
  status
  title
  description_preview
  task_kind
  reward_offer_pft nullable
  reward_actual_pft nullable
  accept_by nullable
  deadline_at nullable
  latest_event_id
  source_confidence
  sync_status
  updated_at

wallet_task_sync_checkpoints
  wallet_address
  last_hot_ledger_seen nullable
  last_archive_ledger_checked nullable
  last_full_replay_at nullable
  last_pointer_gap_detected_at nullable
  source_confidence
  updated_at
```

Rules:

- The UI reads `task_projections`.
- The reducer rebuilds `task_projections` from `task_events`.
- `task_events` can be rebuilt from `pftl_pointer_events` plus hydrated IPFS
  payloads.
- PFTasks rows may be imported as bridge events while migration is incomplete,
  but they are not the target source of truth.
- Wallet-linked account mapping can annotate projections for the app UI, but
  wallet state remains canonical for tasks.

## Retrieval And pgvector

Use pgvector in the same Postgres database first. Split to a specialized vector
service only if volume or latency proves it is necessary.

Tables:

```text
retrieval_documents
  id
  account_id
  source_type
  source_id
  title
  content_sha256
  status
  created_at
  updated_at

retrieval_chunks
  id
  retrieval_document_id
  account_id
  source_type
  source_id
  chunk_index
  text
  token_count
  text_sha256
  created_at

retrieval_embeddings
  id
  chunk_id
  account_id
  embedding_model
  embedding vector
  dimensions
  created_at
  unique(chunk_id, embedding_model)
```

Candidate sources:

- current context draft;
- chat messages;
- attachment extracted text;
- task projection summaries;
- decrypted task/context summaries where policy allows.

Rules:

- Retrieval rows are account-scoped.
- Vector rows are rebuildable.
- Do not embed seed phrases, private keys, wallet passwords, or raw secrets.
- Deleting a chat, current context draft, or attachment must enqueue deletion of its
  retrieval rows.

## Jobs And Outbox

Long-running work should be explicit and idempotent.

Tables:

```text
job_queue
  id
  kind
  status
  priority
  run_at
  attempts
  max_attempts
  idempotency_key nullable
  payload_json
  last_error nullable
  locked_by nullable
  locked_at nullable
  created_at
  updated_at
  unique(idempotency_key)

outbox_events
  id
  topic
  aggregate_type
  aggregate_id
  payload_json
  status
  created_at
  published_at nullable
```

Initial jobs:

- sync Ethereum deposit balances;
- import historical context pointers;
- hydrate IPFS payload metadata;
- reconcile PFTL task pointer history;
- generate chat/context embeddings;
- expire sessions and auth challenges;
- retry wallet initiation payout;
- replay task projections.

## Migration From JSON Runtime Store

Current JSON store keys and target tables:

```text
accounts
  -> app_accounts

accountEmails
  -> account_identities(provider = email)

accountIdentities
  -> account_identities(provider = github/x/telegram/discord/etc.)

sessions
  -> account_sessions

oauthStates
  -> oauth_states if unexpired, otherwise drop

emailChallenges
  -> email_challenges if unexpired, otherwise drop

accountWallets
  -> pft_wallet_links

walletChallenges
  -> wallet_challenges if unexpired, otherwise drop

walletInitiationGrants
  -> wallet_initiation_grants

ethereumDepositAccounts
  -> ethereum_deposit_accounts

ethereumDepositAddressIndex
  -> derived unique index, not a table

ethereumDepositCursor
  -> deposit allocator metadata or sequence

ledgerEntries
  -> billing_ledger_entries plus chat_model_runs where applicable

conversations
  -> chat_messages

conversationMeta
  -> chat_conversations

contextDocuments
  -> context_documents and context_revisions

contextHistorySnapshots
  -> context_history_imports and context_history_pointers
```

Migration procedure:

1. Stop writes or put the app in maintenance mode.
2. Snapshot the JSON file and record its SHA-256.
3. Apply Postgres migrations.
4. Run an idempotent importer from JSON to Postgres.
5. Validate row counts and representative account restores.
6. Start the API in Postgres-read mode.
7. Keep the JSON snapshot read-only for rollback inspection.
8. Remove JSON writes after one clean deploy cycle.

Importer requirements:

- deterministic ID mapping where current IDs already exist;
- idempotency on source IDs and hashes;
- no import of seed phrases or local vault material;
- no import of expired challenges unless needed for a short cutover window;
- clear count report by source key and target table;
- dry-run mode that prints intended writes without mutating Postgres.

## Implementation Phases

### Phase 1: Database Foundation

- Add Postgres and pgvector to local Docker.
- Add `server/db` pool and migration runner.
- Add initial schema for accounts, sessions, wallet links, context, chat, and
  billing.
- Add repository modules.
- Keep JSON runtime store as fallback only during migration.

### Phase 2: Account, Context, Chat, Billing Cutover

- Move account/session reads and writes to Postgres.
- Move native context reads and saves to the Postgres current-draft cache.
- Move chat conversations/messages/model runs to Postgres.
- Move usage ledger and Ethereum deposit records to Postgres.
- Add smoke tests for restart persistence.

### Phase 3: JSON Importer

- Build `scripts/import-runtime-store-to-postgres.mjs`.
- Support dry-run and execute modes.
- Import local Docker JSON state.
- Import Fly JSON state only if a valid snapshot exists.
- Confirm no duplicate account identity, wallet grant, or billing ledger rows.

### Phase 4: Task Projection Store

- Add PFTL pointer index tables and task reducer tables.
- Move mock task surface behind a `task_projections` repository.
- Add PFTasks bridge importer as a source, not the source.
- Add archive reconciliation jobs.

### Phase 5: Retrieval Layer

- Add retrieval document/chunk/embedding tables.
- Embed context revisions and chat messages first.
- Add task summaries after task projections are reliable.
- Add account-scoped retrieval APIs for future chat context features.

## Non-Negotiable Invariants

- No seed phrase, private key, wallet password, or decrypted local vault is ever
  stored in Postgres.
- Current context is account-scoped and must work without a wallet.
- Historical context imports are account plus wallet scoped.
- Billing credit is account-scoped and append-only.
- Top-up addresses are account-scoped, not PFT-wallet-scoped.
- Task projections are rebuildable.
- PFTL/IPFS stays canonical for task protocol events.
- pgvector rows are rebuildable.
- Feature code uses repositories instead of open-coded SQL.
- Every external money or reward action has an idempotency key.

## Open Questions

1. Should native context bodies be application-readable plaintext in Postgres,
   or encrypted with a server-side application key while still remaining
   wallet-independent?
2. Should provider user IDs be stored only as hashes, or encrypted as well for
   support workflows?
3. What retention policy applies to deleted chats and current context drafts?
4. Should task projection rows store account IDs, or only wallet addresses with
   account ownership resolved at query time?
5. Should vector embeddings live in the primary app database permanently, or be
   split once retrieval volume grows?
6. What is the required backup/PITR window for billing and chat?
7. Do we need row-level security in Postgres now, or is strict repository-level
   scoping sufficient for the first implementation?
