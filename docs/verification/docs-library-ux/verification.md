# Docs library and spreadsheet chat

Deployed on 2026-09-05 to Task Node production (release 701) and PFDocs (release 60).

## Changes

- One page-level Unlock button opens the existing wallet dialog; locked files and folders are not rendered. Relocking clears decrypted library state and unmounts the editor.
- The library uses the application canvas, a compact file list, search, breadcrumbs, restrained creation controls, and row action menus.
- Personal nested folders support create, rename, move, and remove. Removing a folder preserves its files and children. Accepted shared documents can be organized without changing their grants.
- Folder names, hierarchy, and placements are encrypted with the existing Docs root key. Session-scoped writes use an atomic expected version to reject stale/conflicting updates. Migration `133_docs_library_folders.sql` adds the opaque envelope and revision.
- The Task Node Chat control now works for spreadsheets. PFDocs shares its conversation drawer skin across editor types, contains the composer on narrow screens, keeps it closed initially, and ignores late preference reads after Task Node takes control.
- Editor readiness is emitted after the editor is ready and waits for the outer bridge handler. Spreadsheet mentions include bounded worksheet cell values and active chat history. Assistant protocol parsing does not use regex.

## Verification

Task Node:

```sh
npm run lint
npm run build
node scripts/docs-folders-smoke.mjs
node scripts/collaboration-contract-smoke.mjs
node scripts/docs-library-visual-smoke.mjs
git diff --check
```

The folder smoke uses a connection-local temporary Postgres table, applies the migration, and exercises the actual repository and route handler. It checks missing sessions, session account isolation, concurrent/stale saves, malformed envelopes, wrong decryption keys, cycles, nested moves, name conflicts, and preservation on removal.

The browser fixture runs the actual Task Node shell and Docs components with a generated fixture wallet and encrypted document envelopes. It verifies the native wallet unlock dialog, nested folder creation, spreadsheet movement, global search, reload persistence, mobile containment, and no decrypted filenames after relocking.

PFDocs:

```sh
node --test scripts/tests/postfiat-tasknode-chat-protocol.test.js scripts/tests/postfiat-tasknode-bridge.test.js
DOC_TYPE=sheet SCREENSHOT_DIR=/home/pfrpc/repos/tasknode/docs/verification/docs-library-ux/screenshots node scripts/pfdocs-tasknode-chat-visual-smoke.mjs
DOC_TYPE=pad SCREENSHOT_DIR=/home/pfrpc/repos/tasknode/docs/verification/docs-library-ux/screenshots node scripts/pfdocs-tasknode-chat-visual-smoke.mjs
```

Nineteen focused PFDocs tests pass. The browser checks use real encrypted PFDocs test channels with this working tree's bridge/style modules overlaid in a fresh Chrome session. They verify human-message delivery, parent Chat commands, assistant request/response transport, current worksheet context, active conversation history, and composer containment at 1440×960 and 390×844. Assistant responses are fixtures; this task did not repeat live model-provider tests.

The worksheet adapter uses OnlyOffice's [worksheet range API](https://api.onlyoffice.com/docs/office-api/usage-api/spreadsheet-api/ApiWorksheet/Methods/GetRange/) and [range values API](https://api.onlyoffice.com/docs/office-api/usage-api/spreadsheet-api/ApiRange/Methods/GetValue/). Context explicitly states the A1:AN200/eight-sheet bounds; it does not represent the full contents of a larger workbook.

## Visual evidence

- [Before, locked](screenshots/before-locked-desktop.png)
- [Before, unlocked](screenshots/before-unlocked-desktop.png)
- [After, one unlock action](screenshots/after-locked-desktop.png)
- [After, folders on desktop](screenshots/after-folders-desktop.png)
- [After, folders on mobile](screenshots/after-folders-mobile.png)
- [After, spreadsheet chat on desktop](screenshots/after-sheet-chat-desktop.png)
- [After, spreadsheet chat on mobile](screenshots/after-sheet-chat-mobile.png)
- [After, rich-text chat on mobile](screenshots/after-pad-chat-mobile.png)

## Rollout

The deployable change spans Task Node (migration, authenticated library route, UI) and the PFDocs main app (shared styles, editor readiness, chat protocol and worksheet adapter). The sandbox proxies the main app's sources. Existing unrelated working-tree changes were preserved. No commits or pushes were made for this task.

## Production verification

Task Node release 701 and PFDocs release 60 completed successfully. Migration `133_docs_library_folders.sql` applied at `2026-09-05T14:22:28.976Z`. The production schema contains both encrypted library columns, the deployed backend modules match this working tree, and unauthenticated library writes return 401. App health and worker guards passed. Public model configuration remains GLM 5.3 for Thinking and GLM 5.3 Flash for Instant through Vercel with Ambient backup.

Fresh-browser library tests passed against the deployed frontend at desktop and mobile sizes, including the single Unlock action, native wallet unlock, nested folders, moving a spreadsheet, search, reload, and relock. The tests use synthetic API data and locally served wallet-seeding helpers; application assets come from production.

The deployed PFDocs spreadsheet and rich-text browser checks passed without local source overlays: editor readiness, initial closed drawer, encrypted human-message delivery, assistant request/response transport, live worksheet cell context, collapse/reopen, and desktop/mobile composer containment. Assistant replies remain fixtures; provider inference was verified during the preceding model deployment. Twenty source hashes match across the main PFDocs and sandbox origins.

Deployment details: [deployment.json](deployment.json). Browser evidence: [production/browser-results.json](production/browser-results.json), [production/sheet-results.json](production/sheet-results.json), [production/pad-results.json](production/pad-results.json), and screenshots under [production/screenshots](production/screenshots).
