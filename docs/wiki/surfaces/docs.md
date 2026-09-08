# Docs

Docs is a first-class Task Node screen for wallet-encrypted collaborative documents, spreadsheets, and personal folders. Task Node owns the account-scoped library, identity resolution, encrypted metadata envelopes, grants, and audit state. The dedicated PFDocs Fly apps own the encrypted realtime document channels.

## User Flow

1. Open **Docs** from the primary sidebar. If the wallet is locked, the page shows one **Unlock** button. Unlocking opens the whole library; encrypted placeholder cards are never shown.
2. Complete one-time Docs setup. The browser creates a random Docs root key and wraps it to the wallet-derived encryption key.
3. Use **New** to create a document, spreadsheet, or folder. Open folders with one click, follow breadcrumbs, and search across the entire library. The row menu provides rename and move actions. Removing a folder moves its documents and subfolders up one level without deleting any document. New documents are placed in the current folder. Create or open a rich-text document or spreadsheet inside the embedded PFDocs editor. The editor stays in the Task Node shell; it does not open a disruptive popup.
4. Rename from Task Node or PFDocs. The owner browser synchronizes the canonical title in both directions and stores only encrypted title metadata in Task Node.
5. Share with a validated Task Node member selected from the handle/wallet suggestions as viewer or editor. Recent recipients sort first and the most recently used valid recipient is selected when the dialog opens. A recipient must accept the encrypted capability grant.
6. To open the document outside Task Node, use **Share document → Link access**, then copy either the view link or edit link. The unlocked browser copies the selected PFDocs capability directly to the clipboard; Task Node never receives the plaintext link.
7. Use the document chat for human discussion. `@ODV` and `@coach` are explicit Vercel GLM 5.3 (with Ambient backup) actions.

The library uses compact file rows with document type, access, update date, and an action menu. Shared rows indicate pending access; the Share dialog lists every active or pending recipient, role, and acceptance state before a new capability is sent. Task links are selected from an auto-filtered list of the user's current outstanding and verification tasks; arbitrary task IDs are not accepted by the UI.

## Encryption And Identity

The durable library owner is the Task Node `account_id`. The current linked wallet authorizes setup, signing, and local decryption; it is not the database owner. Task Node and PFDocs servers do not receive the mnemonic, private key, decrypted Docs root key, raw edit/view capability URL, or plaintext library title envelope.

Document content remains in PFDocs/CryptPad's end-to-end encrypted channel. Task Node Postgres stores opaque channel hashes, encrypted metadata, encrypted capability grants, state, and audit timestamps. Human chat identity is derived from the authenticated Task Node handle, falling back to the linked wallet. Nostr is optional transport identity and never grants document access.

CryptPad links are bearer capabilities. The Share Document dialog exposes separate view and edit PFDocs capabilities and warns that both links contain the document decryption key. Anyone who receives a link can retain and forward its access; an edit link also permits document changes. Revoking a Task Node grant removes normal library delivery but cannot erase a capability that a recipient already copied. Rotate the PFDocs capability/password and re-share when a link may be compromised.

## Folders

Folders belong to the current account’s personal library, including organization of accepted shared documents. Moving a document changes its placement only; it does not change its owner or grants. Folders can contain subfolders; moving a folder into itself or one of its descendants is rejected. Sharing a document does not share its personal folder tree.

The browser encrypts `{ version: 1, folders, placements }` with the Docs root key. Postgres stores only `encrypted_library_metadata` and `library_metadata_version` on `docs_accounts` (migration `133_docs_library_folders.sql`). `PATCH /api/docs/library` accepts the opaque envelope and expected version under the authenticated session, and increments the version atomically. A stale save returns 409; the UI reloads the current organization and asks the user to retry. A failed folder decrypt never permits overwriting the encrypted organization with an empty tree. Recovery exports include this encrypted folder state.

## Embedded Editor And Titles

The Task Node bridge is strict-origin and iframe-only. PFDocs main and sandbox origins must be distinct HTTPS origins. `postMessage` traffic validates the exact origin, iframe window, request ID, and channel hash.

PFDocs emits document-title events. For an owned document, the unlocked browser re-encrypts the new title with the Docs root key and patches the Task Node metadata envelope. A Task Node rename is also sent to PFDocs. Recipient title snapshots never overwrite the owner's canonical title. When the wallet is locked, the library shows a single unlock screen and unmounts the editor. Decrypted document titles and folder names are cleared from the view and in-memory library state.

Task Node owns the embedded document header, title, status, sharing, and access controls. PFDocs suppresses its duplicate account and collaboration chrome in Task Node sessions. Rich-text documents retain their focused formatting row. Document chat starts closed, opens only from the Task Node **Chat** control, and uses the same restrained message, label, and composer language as Task Node Chat. Spreadsheets use a compact neutral editing ribbon and the same encrypted chat drawer. Chat starts closed; opening it keeps the composer within the viewport, and closing it restores the full-width grid. Both document types expose **Chat** and **Full context** in the Task Node header. A late preference callback cannot override the user’s drawer choice.

Task Node keeps a native loading cover over the embedded frame until the authenticated PFDocs bridge sends its ready event. This prevents CryptPad's transient bootstrap state from flashing as a document error. Library API errors and local capability-decryption failures are tracked separately: one malformed or stale share envelope cannot blank otherwise valid documents or present a transient page-level error.

## Document Chat And Assistants

Normal document chat stays within the PFDocs encrypted chat channel and uses the authenticated Task Node display identity. Assistant invocation is mention-based:

- `@ODV` loads the source-controlled ODV/Lindy persona prompt.
- `@coach` loads the source-controlled Telegram Trading Coach persona prompt.

The assistant receives the current document title/content, the user's explicit mention, and up to 12 messages from that same document-chat channel in canonical order. This bounded active-conversation window makes follow-ups and requests about earlier messages work without exposing another document or conversation. Enabling **Full context** additionally permits bounded Task Node Context, Memory, and task state; it does not control active chat continuity. Both assistants use Vercel `zai/glm-5.3` with Ambient backup; the server rechecks account, document, and channel access before inference. Document content and chat are untrusted reference data, not system instructions.

For spreadsheets, the browser snapshots cell values with worksheet names and row numbers from A1:AN200 on up to eight sheets, bounded to 80,000 characters. The context identifies these bounds; cells outside them are not included. Extraction reads the current OnlyOffice workbook, without modifying cells. Explicit mention parsing and assistant header decoding use ordinary protocol parsing, with regression checks prohibiting regex in the shared chat protocol.

Mention turns are processed sequentially per open document chat. A second `@coach` or `@ODV` message sent while GLM 5.3 is answering is queued in send order rather than discarded or run concurrently. Each accepted mention snapshots the current decrypted document and bounded recent chat before waiting. The composer reports the active persona and queued mention count, and each clean response card retains a small `Trading Coach` or `ODV` label without exposing the mechanical routing header as message content.

Both assistants allow 32,768 completion tokens, including reasoning. A provider `finish_reason: length` triggers one retry at 65,536 tokens with the same request. Complete replies are preserved through the API, iframe bridge, and encrypted chat instead of being cut at 12,000 characters. Provider attempts have five minutes and share a nine-minute overall deadline; the iframe query and Fly connection allow ten minutes. Errors expose a readable retry or response-limit message, while server diagnostics retain only persona, provider, failure category, status, and budget—not document content or upstream error text.

## Runtime And Failure Boundaries

- Native library: `src/features/docs-library/DocsLibraryView.jsx` and `GET /api/docs`.
- Collaboration API: `server/collaboration-routes.js` and `server/repositories/collaboration.js`.
- Assistant boundary: `server/docs-odv.js`.
- Schema: migration `110_docs_team_collaboration.sql`.
- PFDocs production main app: `tasknode-pfdocs` with its own persistent volume.
- PFDocs sandbox app: `tasknode-pfdocs-sandbox`, stateless and isolated.

`TASKNODE_DOCS_ENABLED` controls the library. `TASKNODE_PFDOCS_EDITOR_ENABLED` controls create/open transport independently, so a PFDocs outage must not erase or hide the library. `TASKNODE_DOCS_ODV_ENABLED` disables assistant mentions without disabling documents or human chat. The PFDocs apps do not run on the Task Node web/worker machines.

Verification: `node scripts/docs-assistant-limits-smoke.mjs`, `node scripts/docs-folders-smoke.mjs`, `node scripts/docs-library-visual-smoke.mjs` (fresh Chrome CDP target on port 9347; local source app on port 5192), `npm run collaboration-contract-smoke`, the PFDocs bridge tests in the `pftdocs` repository, and the production checks in [Docs and Team Deployment Runbook](#docs/team-mate-coordination-deploy-runbook).
