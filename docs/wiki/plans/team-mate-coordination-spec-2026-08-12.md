# Team Mate Coordination Spec

Status: implemented and enabled in production; current surface details live in [Docs](#docs/docs) and [Team](#docs/team)
Owner: Task Node engineering
Date: 2026-08-12

## Goal

Add two account-scoped collaboration surfaces to Task Node:

1. **Docs**: a minimal Task Node document library backed by the existing
   PFDocs/CryptPad fork, with wallet-unlocked end-to-end encryption and sharing
   by Task Node identity or verified wallet identity.
2. **Team**: a clear teammate directory with explicit task-history visibility
   relationships: Collaborator, Manager, and Direct Report.

Docs is a first-class primary sidebar screen. Team lives in the sidebar
**More** menu. Both use the UX direction in `mocks/docs.jsx` and
`mocks/team.jsx`. They are separate permission systems:
adding a teammate never grants access to a document, and sharing a document
never grants access to task history.

## Product Outcome

A signed-in user should be able to:

- open Docs from the primary sidebar and see private and shared documents associated with their
  Task Node account;
- unlock the current linked wallet to create, open, edit, or share encrypted
  documents without sending seed material or plaintext document capabilities
  to Task Node servers;
- share a document with an exact Task Node handle or a verified PFT wallet;
- open More -> Team and see who can read whose task history;
- request a Collaborator, Manager, or Direct Report relationship;
- accept, decline, change, or revoke a relationship with understandable
  consequences;
- message a teammate through a linked Nostr identity when both sides have a
  valid binding, without treating Nostr as the authorization source.

The implementation is deliberately not a second full productivity suite.
Task Node owns the library, identity, sharing, permissions, and storage policy.
PFDocs supplies the encrypted realtime rich-text editor.

## Sources Reviewed

### Task Node product inputs

- `mocks/docs.jsx`
- `mocks/team.jsx`
- `src/main.jsx`, including the existing More menu and the current `docs` Help
  route
- `src/features/docs/DocsView.jsx`, which is currently the product wiki rather
  than a user document library
- `server/account-wallet-cloud.js`
- `server/db/migrations/103_account_linked_wallets.sql`
- `docs/wiki/architecture/auth-and-connected-accounts.md`
- `docs/wiki/architecture/auth-wallet-boundary.md`
- `docs/wiki/architecture/encryption.md`
- `docs/wiki/architecture/nostr.md`
- `docs/wiki/surfaces/tasks.md`

### PFDocs archaeology

The relevant fork is `/home/pfrpc/repos/pftdocs`, whose upstream is CryptPad.
It is a stronger starting point than the older `pfdapp/cryptpad` customization.
The following existing PFDocs assets are useful:

- `src/postfiat/nostr-identity.mjs`
- `src/postfiat/live-pad-share.mjs`
- `src/postfiat/nostr-private-share.mjs`
- `src/postfiat/nostr-relay-client.mjs`
- `src/postfiat/private-share-workflow.mjs`
- its wallet-bound Nostr directory proof and forged-directory regression tests;
- its upload quota, wallet-session, sanitizer, and log-redaction repairs.

The older `pfdapp/cryptpad` wallet customization is reference material only. It
contains obsolete MetaMask Snap, wallet-generation, faucet, wallet-switching,
theme-injection, and standalone login behavior that must not be ported into
Task Node.

## Decisions

### Identity authority

The Task Node `account_id` is the durable product owner. The active wallet is a
cryptographic authorization and decryption identity, not the permanent database
owner of the Docs library or Team relationship.

This follows the existing account-cloud rule: providers and wallets may change,
but account-owned product state remains keyed by `account_id`.

### Encryption authority

Task Node and PFDocs servers must not receive:

- wallet mnemonics or private keys;
- a decrypted Docs root key;
- raw CryptPad edit/view capability URLs;
- decrypted document titles or bodies in API logs;
- Nostr private keys.

On first Docs setup, the browser generates a random 32-byte `docs_root_key`. It
is wrapped to the current wallet-derived X25519 key and persisted only as an
encrypted envelope. That stable root key encrypts the library index. Nostr keys
are separate and optional; Docs setup must not silently enroll a user in Nostr.

This gives the Task Node account a stable Docs identity while still requiring a
linked, unlocked wallet to decrypt it. The Task Node service is not an implicit
recipient.

### Wallet replacement

Wallet replacement cannot magically preserve end-to-end encrypted data. Before
delinking or replacing a wallet that is the only Docs key recipient, the UI must
require one of these outcomes:

1. unlock the old wallet and re-wrap the Docs root key to the new verified
   wallet;
2. export an encrypted recovery package; or
3. explicitly acknowledge that Docs access will be lost.

The normal path is re-wrap before delink. A server-side recovery copy that Task
Node itself can decrypt is out of scope.

### Canonical state

- Task Node Postgres is canonical for account ownership, document index rows,
  opaque sharing state, relationship grants, revocations, and audit history.
- PFDocs/CryptPad channels are canonical for encrypted live document state.
- Nostr is an encrypted delivery and messaging transport. It is not canonical
  for Task Node identity, Team permissions, task state, rewards, or document
  ownership.
- PFTL/IPFS durable publication remains an explicit advanced export later. It is
  not the default document-sharing path.

## Information Architecture

### Primary navigation and More menu

Add **Docs** to the primary sidebar, following Hive and before Wallet. It is a
native Task Node library screen and must not disappear merely because the
separate PFDocs editor transport is degraded.

Add these normal rows to the existing sidebar More popout:

1. Team
2. divider
3. Context Refine
4. Context Rewrite
5. Hive Brain
6. Memory

Docs and Team are account collaboration destinations rather than chat tools.
Signed-out selection opens login and returns to the requested page after
authentication.

### Resolve the existing Docs/Help collision

`src/main.jsx` currently uses the `docs` view for the in-app Help/wiki, and
`DocsView.jsx` writes `#docs/<wiki-slug>` URLs. The new user-facing document
library needs the product name **Docs**.

The route migration is:

- `#docs` and `#docs/<document-id>` -> new Docs library;
- `#team` -> Team;
- `#help` and `#help/<wiki-slug>` -> existing wiki, renamed internally from
  `DocsView` to `HelpView` when practical;
- profile-menu Help navigates to `#help`;
- known legacy `#docs/<wiki-slug>` links redirect once to the matching
  `#help/<wiki-slug>` route.

The redirect must use the known wiki slug registry. It must not classify an
arbitrary document id as a legacy Help slug.

### Page shell

Use the real Task Node sidebar and responsive layout. Do not import JSX from
`mocks/`; the mocks are visual references only.

Both pages need honest loading, empty, locked, degraded, and error states. Mock
counts, wallet addresses, document titles, task totals, and people must never
ship as runtime fallback data.

## Docs Page Specification

### Mock elements to keep

Keep the following direction from `mocks/docs.jsx`:

- cream background, white hairline cards, compact metadata, green state accents,
  amber encrypted state, and monospace identity strings;
- page title, document counts, private/shared summary, PFDocs sync state, and a
  clear New document action;
- All, Shared, and Archived filters;
- compact document rows with title, type, last edited time, collaborators, and
  encryption state;
- a wallet/key status block near the header;
- optional task linkage shown as metadata rather than the primary hierarchy.

Change these mock assumptions:

- Templates are not a launch tab because the minimal product does not ship a
  template marketplace.
- The launch editor type is Rich text only. Sheet, code, kanban, whiteboard,
  slides, forms, and other CryptPad apps are not exposed.
- Do not claim `XSALSA20`, "keys never leave this device", version counts, or a
  PFDocs version until those facts come from runtime state.
- "My Context Doc" is not automatically a PFDocs document. Context remains its
  own Task Node surface unless the user explicitly exports or links it.
- "Publish to PFT" is an advanced future action and must not appear in the
  launch UI.

### Header states

The header status block has four states:

| State | Copy | Primary action |
| --- | --- | --- |
| No linked wallet | Wallet required for encrypted Docs | Open Wallet |
| Wallet linked, vault locked | Docs locked | Unlock wallet |
| Wallet unlocked, Docs not initialized | Set up encrypted Docs | Set up Docs |
| Ready | Encrypted Docs ready | New document |
| Degraded | PFDocs temporarily unavailable; library metadata remains visible | Retry |

Document titles are encrypted metadata. When the wallet is locked, rows render
as `Encrypted document`, type, last activity, and sharing state only. They must
not leak cached plaintext titles from a prior unlocked account after logout or
account switching.

### Filters and search

- **All**: documents the account owns plus accepted shares.
- **Shared**: documents with another active reader/editor, plus documents shared
  to the user.
- **Archived**: user-hidden documents pending deletion policy.
- Search runs locally over the decrypted title/index. The server does not receive
  plaintext search queries or titles.

### Document row actions

Each row supports:

- Open;
- Share;
- Rename;
- Link/unlink a Task Node task;
- Export rich text or Markdown;
- Archive;
- Leave shared document, when the current user is not the owner.

Delete is owner-only, requires confirmation, creates a tombstone, and enters the
30-day recoverable archive window. Shared recipients see that the owner removed
the document; the system does not pretend it can erase copies they already
exported.

### Create flow

1. Require signed-in account, current linked wallet, and unlocked local vault.
2. Initialize Docs root key if necessary.
3. Create a rich-text PFDocs channel.
4. Encrypt the capability and display metadata locally.
5. Persist the opaque Task Node document row and encrypted metadata.
6. Open the editor only after both PFDocs creation and Task Node index creation
   succeed.

If PFDocs creation succeeds but Task Node indexing fails, retry the idempotent
index write with a client-generated `document_id`; do not create another pad.

### Editor launch

The editor renders as an in-page workspace inside the first-class Docs screen.
Task Node embeds the dedicated PFDocs main origin; PFDocs in turn embeds its
separate sandbox origin. Both CSPs enumerate the exact required ancestor chain.
No editor action opens a popup or replaces the Task Node tab.

Use a user-initiated, exact-origin bridge:

1. Task Node creates an iframe bridge URL bound to action, request ID, and the
   configured Task Node origin.
2. PFDocs validates the request ID and return origin against its configured
   allowlist and records whether the caller is its parent frame.
3. For an existing document, the edit/view capability is carried only in the
   URL fragment. It is never placed in a query parameter or server log.
4. PFDocs posts create and title events only to the configured Task Node origin.
5. Task Node accepts an event only when both `event.origin` and `event.source`
   match the configured PFDocs iframe.
6. On rename, Task Node matches the exact PFDocs channel to an owned document,
   encrypts the new title with the wallet-unlocked Docs root key, and persists
   only the encrypted metadata envelope.

On owner open, an explicit encrypted PFDocs title wins reconciliation and is
re-published to Task Node. This repairs library snapshots that missed rename
events before channel-hash persistence was fixed. Task Node seeds PFDocs only
when the document has no explicit PFDocs title. Later renames flow in either
direction over the same exact channel hash. Shared recipients never push their
title snapshot over the owner's PFDocs title.

Never use `postMessage(..., "*")`, query-string pad secrets, localStorage
capabilities, mnemonic transfer, or broad same-origin `BroadcastChannel`
export. Closing the editor returns to the in-page Docs library.

### Document chat and @ODV

The existing encrypted CryptPad pad chat is enabled and opened by default for
Task Node-launched documents. Human messages use the signed-in Task Node Hive
handle (for example `@alice`) or the linked wallet address when no handle is
available. The label is supplied by the authenticated Task Node parent and is
accepted only through the exact-origin bridge.

The encrypted pad-chat worker is retained independently of the deprecated
standalone CryptPad Contacts app. The drawer is ready only after its encrypted
channel is joined, the pad room is active, and the message input is available;
rendering the drawer shell or spinner does not satisfy this contract.

### Task Node editor shell

Task Node-launched documents use the focused editor treatment defined by
`mocks/docs_view.jsx`, adapted onto the real PFDocs runtime rather than its
prototype `contentEditable` state. Task Node owns the back navigation,
wallet-encrypted canonical title, encryption/save status, sharing controls,
and File/Chat commands. PFDocs retains CKEditor formatting, encrypted realtime
state, history, import/export, and the encrypted pad-chat channel. The native
CryptPad inline-comments rail is not exposed in the Task Node skin: its empty
rail and detached reveal control duplicate the document chat and consume editor
width. Existing document content remains intact.

The legacy PFDocs logo, account menu, duplicate document title, drive-storage
prompt, help banner, and standalone navigation are hidden only after the
validated Task Node document context is accepted. Import, export, history, and
chat-toggle commands cross the exact-origin bridge with the current request ID
and channel hash and are restricted to a fixed command allowlist.

On desktop, Docs owns the workspace's top row, so the otherwise empty global
Task Node topbar is removed for this route. The editor header uses
container-width breakpoints to collapse secondary controls before the title or
primary Share/Chat actions can overlap. Mobile retains the global topbar so
navigation remains reachable.

The PFDocs formatting row must never wrap. Common writing groups remain visible
in priority order, while groups that do not fit move into a keyboard-accessible
`More formatting` menu using their original CKEditor elements and handlers.
Word count and version history render in a bottom document-status bar instead of
floating among formatting controls. Chat uses padded, visually separated message
bubbles, can be collapsed from inside the drawer, and becomes an overlay before
its width can compress the formatting row or document canvas.

Document chat follows `mocks/docs_view.jsx`: the current user's messages are
right-aligned black bubbles and assistant replies are neutral off-white cards
with preserved paragraph spacing. Persona/model routing headers remain inside
the encrypted transport record but are not rendered as bold message content.
ODV and Coach must not introduce green/yellow response backgrounds or hover
states. The composer uses the mock's bordered inner field, upward send action,
document-readable disclosure note, and neutral focus treatment.

An `@ODV` or `@coach` mention in the pad chat is an explicit inference action:

1. The PFDocs client extracts plain text from the current decrypted rich-text
   document and the last 12 encrypted chat turns in the browser.
2. PFDocs sends that packet to the Task Node parent through the validated frame
   bridge. It does not call an inference provider directly.
3. Task Node rechecks that the signed-in account owns or has an accepted grant
   for the exact `document_id` and PFDocs channel hash.
4. Task Node derives the persona from the actual mention and injects the
   application-owned canonical prompt: the Future-AI/hyperstitional entity
   prompt for `@ODV`, or the Telegram Trading Coach/X2519 prompt for `@coach`.
5. By default Task Node sends only the current document and the current
   request. If the user explicitly checks `Full context` for the open editor
   session, Task Node additionally includes recent encrypted document-chat
   turns and loads the requester's context document, memory, and recent task
   packet. This opt-in resets to off when the document closes.
6. Task Node calls Ambient `z-ai/glm-5.2` with tools disabled and treats every
   supplied context packet as untrusted reference data.
7. The client writes the answer back into encrypted pad chat with the selected
   persona and `GLM 5.2 via Ambient` label.
8. Mention turns are serialized per open pad chat. Mentions submitted while one
   inference is active snapshot the decrypted document and bounded recent chat,
   remain in an ordered client queue, expose an active and queued status in the
   composer, and advance after either success or failure; no accepted encrypted
   chat message may be silently dropped from routing.

Ordinary document and chat activity remains end-to-end encrypted. The explicit
persona action discloses the bounded current document text and request to Task
Node and Ambient for that response. Recent document chat, Task Node profile,
memory, context-document, and task data is disclosed only for a response made
while `Full context` is explicitly enabled.
The request is limited to 80,000 document characters and 12 recent turns.
Prompt sources are vendored under `prompts/docs/` and reproducibly refreshed
with `scripts/sync-doc-persona-prompts.mjs`.

### Sharing flow

The share sheet accepts an exact Task Node `@handle` or PFT wallet address. It
does not provide a fuzzy endpoint that enumerates private accounts.

1. Resolve the input to one Task Node account and its current verified wallet.
2. Require the recipient to have initialized a wallet-bound Docs/Nostr inbox.
3. Display the resolved public handle, truncated wallet, and requested access
   (`Can edit` or `Can view`).
4. The sender signs the share operation and encrypts the PFDocs capability to
   the recipient's verified, wallet-bound Nostr inbox key.
5. Publish a NIP-44/NIP-59 gift wrap to TLS-only configured relays.
6. Store an opaque pending share row in Task Node for inbox discovery and
   idempotency. Store the Nostr event id and encrypted envelope, not the raw
   capability.
7. The recipient accepts, decrypts locally, and re-encrypts the capability into
   their Docs root-key index.

Share delivery should retry safely by `share_id`; it must never duplicate the
logical grant because multiple relays accepted the same event.

### Document access roles

| Role | Open/read | Edit live pad | Re-share | Archive/delete for everyone |
| --- | ---: | ---: | ---: | ---: |
| Owner | Yes | Yes | Yes | Yes |
| Editor | Yes | Yes | No by default | No |
| Viewer | Yes | No | No | No |

CryptPad edit links are capabilities. The client must issue a view capability
for viewers rather than trusting the Task Node UI to hide editing controls.

### Revocation truth

Revoking a live capability stops future Task Node launches and removes the grant
from the active library. It cannot make a capability or plaintext already copied
by a recipient disappear.

Strong revocation requires creating a new PFDocs channel/capability and sharing
it only with remaining members. The UI must call this **Rotate document access**
and explain that it creates a replacement collaboration channel. It must not
claim retroactive erasure.

### Task links

An owner/editor can attach a document to a visible Task Node task. The link is
account-scoped metadata with `document_id`, `task_id`, creator, and timestamp.
It does not copy document content into task evidence, chat context, memory, or a
model prompt.

Opening a task-linked document still requires document access and wallet
unlock. Team task visibility alone does not satisfy document authorization.

## PFDocs Production Cut

### Keep

Keep only the PFDocs capabilities needed for the product:

- encrypted realtime rich-text pads;
- owner/editor/view capability modes;
- autosave and presence required for collaboration;
- bounded revision restore;
- Markdown/HTML export;
- wallet/docs-root-key account derivation;
- Nostr identity, directory proof, NIP-44/NIP-59 private delivery, and relay
  helpers;
- quota enforcement, upload size enforcement, sanitizer fixes, log redaction,
  and admin-only operational health.

### Remove from normal user UX

Deprecate or make unreachable from production navigation:

- standalone PFDocs marketing/home shell;
- PFDocs Task Node clone, chat, AI provider settings, Superthink, RunPod, and
  model-key storage;
- CryptDrive and its full folder/contact/profile experience;
- CryptPad username/password registration and wallet creation/restore UI;
- MetaMask Snap, wallet switching, faucet, balance, and transaction panels;
- public/anonymous pad creation;
- raw profile-link and raw pad-link sharing as normal actions;
- templates, teams, calendar, polls, forms, kanban, whiteboard, code, diagram,
  slides, presentation, and spreadsheet apps;
- donation, premium upsell, instance listing, and user-facing admin/debug pages;
- automatic IPFS/PFTL publication;
- browser-local provider keys and all PFDocs-owned inference paths. Explicit
  `@ODV`/`@coach` requests are handled by the Task Node server through Ambient;
  PFDocs itself receives no inference credential.

Maintainer-only CryptPad administration can remain unlinked and separately
authenticated where necessary to operate the service.

### Security gates inherited from PFDocs audit

Before production, verify the existing fixes rather than assuming the fork is
safe because they are documented:

- wallet-directory events require canonical wallet proof and reject forged or
  expired bindings;
- no mnemonic or PFDocs account capability crosses BroadcastChannel,
  postMessage, localStorage, logs, or the server;
- chunked upload paths enforce declared size and account quota;
- unsafe rich-text URLs are rejected;
- sensitive auth/challenge fields are redacted from logs;
- production uses separate safe/sandbox origins;
- Nostr relays are `wss://` only;
- SSO cookies are CSPRNG, Secure, HttpOnly, SameSite, path-scoped, and
  short-lived;
- every frame and message listener checks exact origin and source;
- residual CKEditor and `unsafe-inline` exposure receives an explicit release
  security decision or the editor is upgraded/replaced.

## Storage and Revision Policy

The defaults are intentionally modest and configurable:

| Limit | Launch default |
| --- | ---: |
| Active document count per account | 100 |
| Total owner-charged storage per account | 50 MiB |
| Single attachment | 5 MiB |
| Total logical size per rich-text document | 20 MiB |
| Restorable revision window | 30 days |
| Named/checkpoint revisions exposed per document | 50 |
| Archived document recovery | 30 days |
| Unclaimed/anonymous channel retention | 7 days |
| Encrypted backup retention | 7 daily backups |

Attachments are disabled at first launch unless upload quota accounting passes
the retained PFDocs security tests. Inline images count against both document
and owner quota.

Owner storage is charged once even when a document is shared. Received shares
do not duplicate the underlying channel bytes into every recipient's quota.
Exports and browser caches are outside server quota and must be cleared on
logout where the browser permits.

CryptPad history is an operation chain, so "50 revisions" cannot be implemented
by hiding rows in the UI. Before launch, add or validate a safe compaction job
that checkpoints current encrypted state and removes superseded history outside
the 30-day restore window without corrupting active channels. Until that is
proven, the service must monitor physical history growth and enforce the 50 MiB
account quota rather than claiming bounded history.

Set integrated eviction deliberately; the fork currently contains defaults that
can leave eviction disabled. Production needs scheduled inactive, archived, and
orphan cleanup with dry-run reporting and deletion counters.

## Docs Data Model

Add migrations after the current migration head.

### `docs_accounts`

- `account_id` primary key;
- `status`: `active`, `locked`, `rekey_required`, `disabled`;
- `pfdocs_account_hash` opaque unique identifier;
- `encrypted_root_key_envelope` JSONB;
- `envelope_wallet_address`;
- `envelope_key_version`;
- `storage_limit_bytes`;
- `storage_used_bytes` cached measurement;
- `initialized_at`, `updated_at`, `last_opened_at`.

### `docs_documents`

- `document_id` UUID primary key generated by the client;
- `owner_account_id`;
- `pfdocs_channel_hash`, never a raw capability URL;
- `document_type`, launch value `rich_text`;
- `encrypted_metadata` and metadata version;
- `status`: `creating`, `active`, `archived`, `deleting`, `deleted`, `orphaned`;
- `storage_bytes`;
- `created_at`, `updated_at`, `archived_at`, `delete_after`.

### `docs_access_grants`

- `grant_id` UUID;
- `document_id`;
- `owner_account_id`;
- `recipient_account_id`;
- `recipient_wallet_address` at grant time;
- `access_role`: `viewer`, `editor`;
- `status`: `pending`, `accepted`, `declined`, `revoked`, `left`;
- `encrypted_capability_envelope`;
- `nostr_event_id`, relay receipt metadata, and protocol version;
- creator/acceptor/revoker signature hashes and timestamps;
- unique active grant per document/recipient.

### `docs_task_links`

- `document_id`, `task_id` composite unique key;
- `linked_by_account_id`;
- `created_at`.

### `docs_audit_events`

Append-only metadata events for create, share, accept, decline, role change,
revoke, rekey, archive, restore, delete, quota reject, and launch failures. Do
not store document plaintext, raw capability URLs, private keys, or unredacted
Nostr payloads.

## Docs API Contract

All routes require the existing Task Node session. Mutation routes use CSRF
protection, rate limits, idempotency keys, and the same account id resolved from
the session rather than request-body ownership fields.

- `GET /api/docs` -> encrypted library rows, counts, quota, wallet/key state;
- `POST /api/docs/setup/start` -> wallet-bound setup challenge;
- `POST /api/docs/setup/complete` -> verified encrypted root-key envelope;
- `POST /api/docs/rekey/start` and `/complete` -> old/new wallet re-wrap flow;
- `POST /api/docs` -> idempotent creating row;
- `POST /api/docs/:id/complete` -> attach the created PFDocs channel hash and
  encrypted metadata;
- `PATCH /api/docs/:id` -> encrypted rename/status metadata;
- `POST /api/docs/:id/launch` -> one-time scoped PFDocs launch nonce;
- `POST /api/docs/:id/share/resolve` -> exact identity resolution;
- `POST /api/docs/:id/share` -> wallet-signed encrypted grant;
- `POST /api/docs/grants/:id/accept|decline|revoke|leave`;
- `POST /api/docs/:id/archive|restore|delete`;
- `PUT /api/docs/:id/tasks/:taskId` and `DELETE` equivalent;
- `GET /api/docs/health` for authenticated product readiness, with a separate
  operator health detail route.

Every document route re-checks owner or active grant server-side. A PFDocs
capability is never returned merely because the caller knows a `document_id`.

## Team Page Specification

### Mock elements to keep

Keep the direction from `mocks/team.jsx`:

- one page titled Team;
- clear grouped sections for Collaborators, Your Manager, and Direct Reports;
- compact identity cards with public handle, truncated wallet, role, recent
  task activity, and directional visibility indicators;
- a strong Invite action;
- explicit copy explaining who sees whose tasks;
- manager cards withholding the manager's task totals when the current user has
  no grant to see them.

Change these mock assumptions:

- do not display fake PFT totals, task counts, active state, wallet, or signed
  grant state;
- do not say "unfettered" without defining the exact data boundary;
- do not let a user unilaterally assign someone as a Direct Report and thereby
  gain their history;
- pending invitations need their own section and status;
- each active card needs Manage and, when authorized, View tasks actions;
- Nostr messaging appears only for a verified linked identity.

### Relationship semantics

Model access as directional task-history grants:

```text
subject account --grants task-history read--> viewer account
```

The three labels are a presentation over those grants:

| Relationship shown to me | I see their tasks | They see my tasks | Required grants |
| --- | ---: | ---: | --- |
| Collaborator | Yes | Yes | reciprocal active grants |
| My Manager | No | Yes | I grant them access |
| Direct Report | Yes | No | they grant me access |

If reciprocal access exists, the relationship is a Collaborator even if one
side originally invited the other as manager/report. The database must not hold
contradictory role labels as authority.

### Consent rules

- **Collaborator invite** requests two grants. The inviter signs their outgoing
  grant immediately; the invitee accepts and signs the reciprocal grant.
- **Manager invite** means "I want this person to see my tasks." The inviter can
  activate their own outgoing grant after an explicit confirmation; the
  recipient must accept the relationship label before it appears as active.
- **Direct Report invite** means "I am asking this person to let me see their
  tasks." It remains pending until the recipient explicitly accepts and signs
  the outgoing grant from their account.
- A user can always revoke a grant they issued. Revocation is immediate.
- Adding visibility requires the newly exposed subject's consent. Removing
  visibility does not require the former viewer's consent.
- Role changes are implemented as a reviewed grant delta, not an in-place label
  flip with hidden side effects.

### What task-history access includes

An active grant includes all of the subject's Task Node task projections and
task detail fields that the normal Task surface can render:

- Personal, Network, and Alpha tasks;
- current and terminal lifecycle state;
- task title, description, requirements, deadlines, rewards, and reviewer
  messages;
- task event chronology and ordinary text evidence already available through
  Task Node's authorized task-detail read model.

"All task history" means no per-task cherry-picking within this scope. It does
not include:

- Context documents;
- Docs/PFDocs documents or capabilities;
- chat transcripts or Memory;
- profile-private fields or undisclosed provider aliases;
- wallet seed/private key material;
- billing, deposits, auth events, raw observability logs, or operator-only
  forensics;
- attachment bytes that require a separate encryption recipient grant.

Encrypted attachments must either be explicitly re-wrapped to the viewer or
render as unavailable. The server must never weaken attachment encryption to
make Team cards look complete.

Team task history is not automatically inserted into chat, task generation,
Memory, Context Rewrite, profile generation, or any model context packet. A
later explicit "use teammate context" product may define a narrower consent
flow; it is out of scope here.

### Team task viewer

`View tasks` expands a card-scoped task history without leaving Team. Every
task is an actual keyboard-focusable button with an explicit dialog affordance;
selecting it opens a right-side detail popout on desktop and a bottom sheet on
mobile. The popout keeps the teammate identity visible and presents the task
brief, status, reward, deadline, steps, evidence requirement, recent review or
submission activity, and copyable task ID. It closes by its Close action,
backdrop, or Escape and restores focus to the selected task row.

The popout loads through the dedicated `GET
/api/team/:accountId/tasks/:taskId` read-only API. It never routes the task into
the current user's normal Tasks surface and exposes no lifecycle mutations. A
manager or collaborator must not accept, submit, refuse, verify, reward, or
cancel another user's task through Team.

### Invite and identity resolution

Invite accepts:

- exact public `@handle`;
- exact Task Node account invitation code; or
- exact PFT wallet address.

Resolution rules:

- public/discoverable handles may resolve normally;
- wallet lookup may resolve current and historical wallet-cloud records, but
  the confirmation must show the currently active wallet and must not disclose
  unrelated historical wallets;
- private accounts are not enumerable;
- self-invites, duplicates, conflicting pending invites, and already-active
  grant sets return structured, non-leaking errors;
- a wallet with no Task Node account can receive an opaque invitation record,
  but no task access activates until it is verified into an account.

### Card and page states

Each person card shows only authorized facts:

- public handle/display name and selected public avatar;
- active verified wallet prefix when public or directly relevant to the signed
  relationship;
- relationship label and both visibility lanes;
- task count, reward summary, and current task only when the current viewer has
  task-history access;
- last synced time, not speculative presence;
- verified Nostr/NIP-05 identity and Message action only when explicitly linked.

Pending invites are grouped by Incoming and Sent. Empty states explain the
permission direction and offer Invite; they do not render sample teammates.

## Team Data Model

### `team_relationship_invites`

- `invite_id` UUID;
- `inviter_account_id`;
- `invitee_account_id` nullable until resolved;
- `invitee_wallet_address` nullable;
- `requested_relationship`: `collaborator`, `manager`, `direct_report`;
- `requested_grants_json` deterministic directional grant list;
- `status`: `pending`, `accepted`, `declined`, `cancelled`, `expired`;
- `expires_at`, default 14 days;
- signature payload versions/hashes;
- `created_at`, `updated_at`, terminal actor and timestamp.

### `task_history_grants`

- `grant_id` UUID;
- `subject_account_id` whose history is exposed;
- `viewer_account_id` who may read it;
- `scope` fixed to `task_history_v1`;
- `status`: `active`, `revoked`, `expired`;
- subject wallet address at signing time;
- canonical payload, wallet signature, and verification metadata;
- source invite id;
- `created_at`, `activated_at`, `revoked_at`;
- one active grant per subject/viewer/scope.

### `account_nostr_identities`

- `account_id`;
- `nostr_pubkey_hex` and normalized `npub`;
- optional NIP-05 identifier and verification timestamp;
- preferred TLS relay set;
- source wallet and canonical wallet proof;
- monotonically increasing sequence, expiry, and revocation state;
- visibility setting: private, teammates, or public;
- created/updated/revoked timestamps.

### `team_audit_events`

Append-only invite, accept, decline, grant activation, role delta, revoke,
identity bind, identity revoke, and denied-access events. Sensitive identifiers
use the existing observability redaction/hashing policy.

## Team API Contract

- `GET /api/team` -> active relationship projection, directional visibility,
  pending invites, and authorized summaries;
- `POST /api/team/invites/resolve` -> exact identity resolution;
- `POST /api/team/invites` -> create signed requested grant set;
- `POST /api/team/invites/:id/accept|decline|cancel`;
- `POST /api/team/relationships/:accountId/change` -> proposed grant delta;
- `POST /api/team/grants/:id/revoke`;
- `GET /api/team/:accountId/tasks` -> authorized read-only task list;
- `GET /api/team/:accountId/tasks/:taskId` -> authorized read-only task
  detail;
- `GET|POST|DELETE /api/team/nostr` for the signed-in account and
  `GET /api/team/:accountId/nostr` for an authorized teammate;
- `POST /api/team/members/:accountId/message/start` -> validated Nostr message
  launch metadata, never a task-history grant.

The authorization helper must be centralized, for example
`requireTaskHistoryGrant({ subjectAccountId, viewerAccountId })`, and used by
both list and detail queries. Do not scatter role-string checks across routes.

## Nostr Boundary

Task Node currently documents Nostr as TBD; there is no active
Task-Node-Official Nostr identity/chat runtime to assume. PFDocs contains useful
working modules, but they must be integrated behind Task Node account and wallet
proof rather than treated as pre-existing production state.

The launch role of Nostr is narrow and optional:

- mirror an already-authorized opaque PFDocs notification or envelope after
  Task Node mailbox delivery succeeds;
- provide optional teammate-to-teammate encrypted chat;
- provide NIP-05/public-key discovery after explicit identity linking;
- carry opaque invite notifications if useful.

Nostr must not:

- grant task or document access by itself;
- carry plaintext task history, document titles, raw pad links, Context, Memory,
  or model packets;
- replace Task Node invite/grant rows;
- replace PFTL as canonical task/reward state;
- auto-link a relay pubkey to an account without a canonical wallet proof and
  explicit account consent.

Relay metadata remains observable. Use `wss://`, bounded event retention,
padding where supported, minimum necessary relay fan-out, and an optional
first-party relay proxy. Never claim that Nostr hides IP address, timing, relay
choice, or payload size from relay operators.

## Signed Grant Payloads

Document shares, Team grants, revocations, and Nostr bindings use versioned,
domain-separated canonical payloads. A Team grant payload includes at least:

```json
{
  "type": "tasknode.task_history_grant.v1",
  "grant_id": "uuid",
  "subject_account_id": "account",
  "viewer_account_id": "account",
  "scope": "task_history_v1",
  "wallet_address": "r...",
  "issued_at": "ISO-8601",
  "expires_at": null,
  "nonce": "single-use challenge"
}
```

The server consumes the nonce before activating the grant, verifies the
signature against the current linked wallet, records the canonical payload and
signature metadata, and never trusts a client-supplied account owner.

## Authorization and Privacy Requirements

- All Docs and Team reads are account-scoped from the authenticated session.
- Wallet unlock is required for cryptographic Docs operations and wallet-signed
  grants, not for reading already-authorized Team summaries.
- Every relationship and document grant is deny-by-default.
- Revocation invalidates API access immediately and clears relevant server and
  browser caches.
- Browser cache keys include current `account_id`; logout/account switch clears
  decrypted Docs index and teammate task data.
- Team API responses cannot reveal a manager's hidden task counts through totals,
  pagination counts, errors, timing-friendly existence checks, or activity
  labels.
- Public handles are presentation identifiers, not authorization keys.
- Historical wallets support attribution and recovery workflows but cannot sign
  new grants after another account owns that wallet.
- Docs and teammate task bodies are excluded from analytics and ordinary
  observability logs.
- Rate-limit identity resolution, invitations, Nostr relay work, PFDocs launch,
  and relationship changes.
- Blocked accounts, deleted accounts, and abuse holds cannot establish new
  grants; existing grants can still be revoked.

## Implementation Boundaries

### Task Node Official

Expected owners:

- `src/features/docs-library/` for the new Docs page;
- rename or logically separate existing `src/features/docs/` as Help/wiki;
- `src/features/team/` for Team and teammate task viewer;
- `server/docs-routes.js` and `server/repositories/docs.js`;
- `server/team-routes.js` and `server/repositories/team.js`;
- one shared exact identity resolver using current profile/account wallet-cloud
  boundaries;
- migrations for Docs, Team, Nostr identities, and audit rows;
- app-state should include only small badge counts/readiness summaries. Full
  document and teammate task payloads load from their own routes.

### PFDocs

Expected owners:

- retained rich-text editor and encrypted channel runtime;
- minimal Task Node launch/nonce bridge;
- scoped capability receive/clear logic;
- retained and hardened Nostr private-share modules;
- quota/physical storage measurement, compaction, eviction, and health;
- no Task Node chat/inference/task-history clone.

The integration should import or port small audited PFDocs modules. Task Node
must not add `/home/pfrpc/repos/pftdocs` as an opaque runtime dependency or copy
its entire app shell into `tasknodeofficial`.

## Delivery Plan

### Phase 0: Freeze and audit

- Inventory the deployed PFDocs instance, volumes, domains, versions, and data.
- Take an encrypted backup before destructive deprecation.
- Confirm license/source-publication obligations for the AGPL fork.
- Re-run the retained PFDocs security suite and resolve release-blocking residual
  findings.
- Decide the exact `docs.postfiat.org` and sandbox origins.

### Phase 1: Shared identity and grants

- Add exact account/handle/wallet resolver.
- Add wallet-signed challenge contract.
- Add optional Nostr identity binding with wallet proof, sequence, expiry, and
  revocation; Team and Docs must remain usable without it.
- Add Team invite/grant migrations, repository, API, and audit events.
- Build Team page and read-only teammate task viewer from `mocks/team.jsx`.

Team can ship behind a flag before PFDocs because its task-history grants do not
depend on document storage.

### Phase 2: Minimal PFDocs runtime

- Remove/deactivate the deprecated PFDocs surfaces.
- Prove rich-text create/open/edit/view collaboration.
- Add root-key envelope, launch handshake, safe/sandbox origins, quota,
  compaction/retention, and health checks.
- Prove no plaintext capability or wallet secret crosses server/log boundaries.

### Phase 3: Docs library and sharing

- Add Docs migrations, repository, API, and Task Node page from `mocks/docs.jsx`.
- Implement encrypted client-side index and locked state.
- Implement create/open/rename/archive/export.
- Implement exact identity share, Task Node encrypted mailbox delivery,
  optional Nostr gift-wrap mirroring, accept/decline,
  viewer/editor mode, revoke, and access rotation.
- Add optional task links without context ingestion.

### Phase 4: Production cutover

- Dark-launch both pages to operator accounts.
- Run two-account/two-wallet collaboration and permission tests against the
  production-shaped PFDocs instance.
- Measure physical storage and history growth under edit load.
- Enable Team, then Docs, with independent flags and rollback.
- Leave deprecated PFDocs routes returning a clear gone/redirect response; do
  not silently keep two identity systems active.

Recommended flags:

```text
TASKNODE_TEAM_ENABLED=false
TASKNODE_DOCS_ENABLED=false
TASKNODE_NOSTR_TEAM_CHAT_ENABLED=false
PFDOCS_TASKNODE_LAUNCH_ENABLED=false
PFDOCS_LEGACY_UI_ENABLED=false
```

## Regression and Acceptance Tests

### Docs contract tests

- signed-out Docs selection returns to Docs after login;
- no-wallet, locked-wallet, setup, ready, and PFDocs-degraded states render
  honestly;
- account A cannot read account B's encrypted index or request a launch nonce;
- stale Help `#docs/<known-wiki-slug>` links migrate to `#help` while arbitrary
  document ids do not;
- create retry is idempotent after PFDocs success/Task Node timeout;
- decrypted titles disappear on lock, logout, and account switch;
- exact handle and wallet shares resolve the intended account without directory
  enumeration;
- forged, expired, wrong-wallet, wrong-origin, and lower-sequence Nostr directory
  events are rejected;
- viewer receives a view capability and cannot edit;
- editor can edit but cannot delete or re-share by default;
- revoked recipient loses new launch/API access;
- strong rotation excludes the revoked recipient from the replacement channel;
- task links do not expose documents to teammates without document grants;
- upload, per-account quota, document limit, archive cleanup, and physical usage
  accounting hold under chunked and concurrent writes;
- no mnemonic, root key, raw capability, title, or body appears in API logs,
  observability events, or errors.

### Team permission matrix

Test at least these perspectives, not only one literal invite sentence:

| Setup | A reads B | B reads A |
| --- | ---: | ---: |
| No relationship | No | No |
| Collaborator accepted | Yes | Yes |
| A lists B as manager | No | Yes |
| A lists B as direct report, pending | No | No |
| B accepts A as manager / A sees B as report | Yes | No |
| One reciprocal collaborator grant revoked | Direction of remaining grant only | Direction of remaining grant only |
| All grants revoked | No | No |

Also verify:

- paraphrased invite intents route to the same deterministic relationship
  contract;
- duplicate/crossing invites converge without duplicate grants;
- decline, expiry, cancellation, account deletion, wallet replacement, and
  block/abuse states fail closed;
- hidden manager task totals do not leak through counts or task-id probing;
- teammate task viewer has no mutation controls and mutation APIs reject the
  teammate viewer;
- collaborator access includes all task categories but excludes Context, Docs,
  Chat, Memory, billing, auth, and operator-only data;
- teammate tasks never enter model context automatically;
- revocation removes access without waiting for a worker cycle;
- Nostr Message appears only for a verified, non-revoked binding and sends no
  task content by default.

### Visual verification

At desktop and mobile widths, compare the implemented pages to the mocks for:

- hierarchy, spacing, card density, type scale, state colors, avatar treatment,
  and compact identity strings;
- readable directionality for manager/report permissions;
- locked and empty Docs states;
- pending invites and long handles/titles;
- keyboard navigation, focus states, screen-reader labels, and reduced motion.

## Observability

Track metadata only:

- Docs setup/launch success and categorized failure;
- PFDocs availability and launch latency;
- active documents, encrypted bytes, archived bytes, history bytes, quota
  rejects, compaction results, orphan channels, and eviction results;
- share sent/accepted/declined/revoked counts and relay delivery result;
- Team invite/grant/revoke counts and denied-access reasons;
- Nostr relay health by configured endpoint without event plaintext;
- security counters for invalid wallet proofs, replayed nonces, origin mismatch,
  forged directory records, and unauthorized task/document reads.

Never place document titles, document bodies, task bodies, raw handles paired
with private wallets, pad capabilities, Nostr ciphertext, signatures, keys, or
mnemonics in metrics labels.

## Production Readiness Gates

The feature is deployable only when:

- the new route collision is resolved and Help deep links have a tested
  compatibility path;
- PFDocs exposes only the retained product/editor surface to normal users;
- Task Node account identity and wallet-unlocked Docs identity survive reload,
  lock, and supported wallet re-key;
- two real test accounts can create, share, accept, co-edit, revoke, and reopen a
  document without server-visible capability material;
- the Team permission matrix passes against production-shaped Postgres task
  rows;
- Nostr directory proofs and exact-origin launch checks pass the adversarial
  fixtures;
- quota and physical-storage alarms are configured and cleanup is scheduled;
- backup and restore of encrypted PFDocs state is rehearsed;
- no legacy PFDocs inference keys, wallet-generation endpoints, faucet paths,
  public registration, or raw-link sharing remain reachable in the normal UX;
- operator runbooks name the Task Node and PFDocs rollback independently.

## Explicit Non-Goals

- Google Docs feature parity.
- A general file drive or large binary storage service.
- Spreadsheets, presentations, kanban, whiteboards, forms, code pads, or
  templates at launch.
- Automatic model access to documents or teammate task history.
- Automatic document sharing with all teammates.
- On-chain publication or payment for ordinary shares.
- Claiming cryptographic revocation of plaintext a recipient already obtained.
- Treating Nostr follows, contacts, DMs, or relay events as Task Node access
  control.
- Replacing the existing Task Node Context editor with PFDocs.

## Definition of Done

The work is complete when Docs and Team are real More-menu pages backed by
production data, all three Team relationships enforce the directional grant
matrix, PFDocs is reduced to the retained encrypted rich-text collaboration
runtime, wallet-linked document access works across two accounts, Nostr is a
verified optional transport rather than an entitlement source, storage remains
bounded and observable, and the regression/security gates above pass in a
production-shaped environment.
