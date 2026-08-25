# Docs

Docs is a first-class Task Node screen for wallet-encrypted collaborative rich-text documents. Task Node owns the account-scoped library, identity resolution, encrypted metadata envelopes, grants, and audit state. The dedicated PFDocs Fly apps own the encrypted realtime document channels.

## User Flow

1. Open **Docs** from the primary sidebar and unlock the linked PFT wallet.
2. Complete one-time Docs setup. The browser creates a random Docs root key and wraps it to the wallet-derived encryption key.
3. Create or open a rich-text document or spreadsheet inside the embedded PFDocs editor. The editor stays in the Task Node shell; it does not open a disruptive popup.
4. Rename from Task Node or PFDocs. The owner browser synchronizes the canonical title in both directions and stores only encrypted title metadata in Task Node.
5. Share with a validated Task Node member selected from the handle/wallet suggestions as viewer or editor. Recent recipients sort first and the most recently used valid recipient is selected when the dialog opens. A recipient must accept the encrypted capability grant.
6. To open the document outside Task Node, use **Share document → Link access**, then copy either the view link or edit link. The unlocked browser copies the selected PFDocs capability directly to the clipboard; Task Node never receives the plaintext link.
7. Use the document chat for human discussion. `@ODV` and `@coach` are explicit Ambient GLM 5.2 actions.

Each owned document card lists the parties with an active or pending grant, including role and acceptance state. The Access/Share dialog repeats the complete current-access list before a new capability is sent. Task links are selected from an auto-filtered list of the user's current outstanding and verification tasks; arbitrary task IDs are not accepted by the UI.

## Encryption And Identity

The durable library owner is the Task Node `account_id`. The current linked wallet authorizes setup, signing, and local decryption; it is not the database owner. Task Node and PFDocs servers do not receive the mnemonic, private key, decrypted Docs root key, raw edit/view capability URL, or plaintext library title envelope.

Document content remains in PFDocs/CryptPad's end-to-end encrypted channel. Task Node Postgres stores opaque channel hashes, encrypted metadata, encrypted capability grants, state, and audit timestamps. Human chat identity is derived from the authenticated Task Node handle, falling back to the linked wallet. Nostr is optional transport identity and never grants document access.

CryptPad links are bearer capabilities. The Share Document dialog exposes separate view and edit PFDocs capabilities and warns that both links contain the document decryption key. Anyone who receives a link can retain and forward its access; an edit link also permits document changes. Revoking a Task Node grant removes normal library delivery but cannot erase a capability that a recipient already copied. Rotate the PFDocs capability/password and re-share when a link may be compromised.

## Embedded Editor And Titles

The Task Node bridge is strict-origin and iframe-only. PFDocs main and sandbox origins must be distinct HTTPS origins. `postMessage` traffic validates the exact origin, iframe window, request ID, and channel hash.

PFDocs emits document-title events. For an owned document, the unlocked browser re-encrypts the new title with the Docs root key and patches the Task Node metadata envelope. A Task Node rename is also sent to PFDocs. Recipient title snapshots never overwrite the owner's canonical title. When the wallet is locked, the library shows encrypted placeholders rather than leaking a title cached by a previous account session.

The embedded layout gives the editor minimum width priority. Less-used formatting actions collapse before the toolbar wraps, the document chat can collapse, and document identity, editor actions, formatting controls, and status occupy separate visual zones.

Task Node keeps a native loading cover over the embedded frame until the authenticated PFDocs bridge sends its ready event. This prevents CryptPad's transient bootstrap state from flashing as a document error. Library API errors and local capability-decryption failures are tracked separately: one malformed or stale share envelope cannot blank otherwise valid documents or present a transient page-level error.

## Document Chat And Assistants

Normal document chat stays within the PFDocs encrypted chat channel and uses the authenticated Task Node display identity. Assistant invocation is mention-based:

- `@ODV` loads the source-controlled ODV/Lindy persona prompt.
- `@coach` loads the source-controlled Telegram Trading Coach persona prompt.

By default the assistant receives only the current document title/content and the user's explicit mention. Enabling **Full context** additionally permits up to 12 recent document-chat messages plus bounded Task Node Context, Memory, and task state. Both assistants use Ambient `z-ai/glm-5.2`; the server rechecks account, document, and channel access before inference. Document content and chat are untrusted reference data, not system instructions.

Mention turns are processed sequentially per open document chat. A second `@coach` or `@ODV` message sent while GLM 5.2 is answering is queued in send order rather than discarded or run concurrently. Each accepted mention snapshots the current decrypted document and bounded recent chat before waiting. The composer reports the active persona and queued mention count, and each clean response card retains a small `Trading Coach` or `ODV` label without exposing the mechanical routing header as message content.

## Runtime And Failure Boundaries

- Native library: `src/features/docs-library/DocsLibraryView.jsx` and `GET /api/docs`.
- Collaboration API: `server/collaboration-routes.js` and `server/repositories/collaboration.js`.
- Assistant boundary: `server/docs-odv.js`.
- Schema: migration `110_docs_team_collaboration.sql`.
- PFDocs production main app: `tasknode-pfdocs` with its own persistent volume.
- PFDocs sandbox app: `tasknode-pfdocs-sandbox`, stateless and isolated.

`TASKNODE_DOCS_ENABLED` controls the library. `TASKNODE_PFDOCS_EDITOR_ENABLED` controls create/open transport independently, so a PFDocs outage must not erase or hide the library. `TASKNODE_DOCS_ODV_ENABLED` disables assistant mentions without disabling documents or human chat. The PFDocs apps do not run on the Task Node web/worker machines.

Verification: `npm run collaboration-contract-smoke`, the PFDocs bridge tests in the `pftdocs` repository, and the production checks in [Docs and Team Deployment Runbook](#docs/team-mate-coordination-deploy-runbook).
