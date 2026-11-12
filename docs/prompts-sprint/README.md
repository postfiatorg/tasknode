# Encrypted Task Node prompts

A prompt is a deliberate Docs document backed by a CryptPad markdown pad. **Docs → New → New prompt** creates an `Untitled prompt — YYYY-MM-DD` document. Rename it in the editor. The **Prompts** library view shows titles, last edits, saved-version counts, UTC 7/30-day statistics, and a compact activity summary. Open a prompt and select **Prompt timeline** to read saved versions. **Agent access** is a secondary control below the library. **Save version** snapshots the current editor text; CryptPad revision history remains available in **File → Version history**.

Prompt documents suppress Task Node assistants. Both assistant endpoints reject prompt document IDs, and the browser and PFDocs bridge block assistant dispatch. Human document sharing still uses the existing Docs capability grants. Personal prompt history and device access are separate from those grants.

## Encryption and persistence

The browser creates a random prompt-library key and wraps it with the unlocked Docs root key. Prompt metadata and each history event use AES-256-GCM with a fresh random nonce. The history table contains only `event_id`, `account_id`, `document_id`, `created_at`, and a ciphertext envelope. SQL triggers reject every event UPDATE and direct history DELETE during normal use. Parent document/account erasure is allowed by migration 162. Appends are idempotent by event ID and tenant-scoped. Event kinds, full saved text, patches, session timing, and TIH scores are inside the ciphertext.

Active time counts unique seconds containing local input, not elapsed editor-open time. More than two minutes without input ends a session. Thirty-second encrypted checkpoints and a final checkpoint on leaving the editor use a stable session ID; stats select the latest checkpoint so overlapping checkpoints do not inflate time. Input across midnight is split into UTC dates. Browser and CLI use the same local reducer. An abrupt process kill can lose input since the last checkpoint; the editor reports failed saves.

Migrations: `160_prompt_documents.sql`, `161_prompt_devices.sql`, and forward migration `162_prompt_history_erasure.sql`. No production migration or deployment is performed by this branch. Account deletion erases owned prompts, their history, and account-wide prompt devices in its transaction. Hard deletion and the deleted/deleting document states erase that document’s history; archiving preserves it. Deleting one document does not revoke an agent’s account-wide access to other prompts. Document registration and its pre-encrypted creation event commit atomically.

## Local agents

The CLI requires Node 22 or newer. Run `tasknode connect` (or the installer) and complete normal account sign-in. It generates an X25519 device keypair locally, registers only its public key, saves the private device file with mode 0600, and registers **tasknode-prompts** beside the hosted **tasknode** MCP entry. The curl installer downloads a content-addressed manifest and verifies every runtime file, including the lockfile, before `npm ci --omit=dev --ignore-scripts`. Each attempt uses a private staging directory and publishes a complete immutable runtime; existing MCP entries keep their previous runtime if a transfer or hash check fails. Optional prompt enrollment failure does not prevent hosted connection completion or old-token cleanup.

**One-click pairing (default).** `tasknode connect` prints a sign-in link whose fragment holds the device public key and a one-time secret. Approving that link stores both in the browser; the next time Docs is unlocked it wraps the prompt-library key to that public key and includes an HMAC of the pairing commitment under the secret. The CLI waits up to 90 s for this and otherwise the local MCP server pairs on first use. The manual path below remains for sign-ins made by typing the short code.

In the unlocked Docs browser, open **Agent access**, match the device fingerprint printed by the CLI and select **Approve prompt access**. The browser uses the same X25519/XChaCha20 envelope as Docs grants to wrap the prompt-library key to that device. Paste the pairing line it shows to your local agent. The agent’s `prompt_pair` tool (or `tasknode prompts-pair --device-id ID --code CODE` in a terminal) compares the browser’s SHA-256 commitment over the library key, account and device identity with the decrypted candidate. Until this independent comparison succeeds all local prompt tools refuse access. The verified commitment is pinned in the private device file; changing keys requires new device enrollment. The code is never sent to the relay. Reopen **Pair local agent** to show it again. `/connect` lists these devices and can revoke them; the approval link opens Docs so the wallet remains the browser's unlock boundary. Each local tool call and relay request checks the terminal session and device grant. Revocation blocks future relay access but cannot erase content or pad capabilities already obtained by an authorized device.

Local tools: `prompt_pair`, `prompt_list`, `prompt_create`, `prompt_read`, `prompt_edit`, `prompt_save_version`, `prompt_history`, `prompt_stats`, `prompt_log_tih_run`. Edits use unique exact-text replacement patches and reject stale/ambiguous matches. Reads and writes join PFDocs through ChainPad, with content decryption entirely in the local process. The hosted `/mcp` tool catalogue gains no prompt plaintext tool. TIH is run by the user's agent locally; its tool only records before/after scores.

The CLI's pad adapter supports the unpassworded v2 `/code/` edit capabilities created by this sprint. Revalidate the capability encoding, signed code JSON, SmartJSONTransformer, and pinned ChainPad packages during the separate CryptPad upgrade track.

## Reproduce local acceptance

Use only the two sprint checkouts. No production URLs, real accounts, or real wallets are used. The runner creates synthetic local accounts and wallet material in an isolated browser. It seeds the account fixture through the normal repositories because the existing development-login route has a durable-account foreign-key failure; the feature interactions then use real HTTP, browser controls, CLI sign-in, stdio MCP, and Postgres.

1. In Task Node: `npm ci` and `npm ci --prefix packages/tasknode-cli`.
2. Start the isolated stack:
   ```sh
   TASKNODE_POSTGRES_PORT=5438 TASKNODE_API_PORT=8195 TASKNODE_WEB_PORT=3195 \
     docker compose -p tasknode-prompts-20261111 \
     -f docker-compose.dev.yml -f docs/prompts-sprint/compose.local.yml up -d
   ```
   The override uses the checkout's installed dependencies in Node 24 containers. Postgres comes from `docker-compose.dev.yml`; the default disabled worker/provider settings remain in effect.
3. In the rebased PFDocs checkout, install its dependencies/components as documented in its Phase 0 guide. Start:
   ```sh
   CRYPTPAD_CONFIG="$PWD/docs/prompts-sprint/spike/local-config.cjs" DEV=1 node server.js
   ```
   The local config permits only the specified Task Node embedding origin. The branch enables `code` in its normal app allowlist.
4. In Task Node, with the PFDocs spike Playwright dependency and Chromium installed:
   ```sh
   PFDOCS_ROOT=/home/postfiat/repos/pftdocs CHROMIUM_PATH=/path/to/chrome \
     TMPDIR="$PWD/.tmp" node scripts/prompts-local-acceptance.mjs
   ```
5. Run `for test in history deletion stats device assistant pad recovery installer; do node "scripts/prompt-$test-smoke.mjs" || break; done`. History smoke defaults to the isolated local Postgres port 5438; override `DATABASE_URL` for another loopback database.

The runner saves JSONL stages, a raw ciphertext-only history row dump, and five browser screenshots under ignored `artifacts/prompts/acceptance-*`. Device files and runtime credentials remain ignored and must never be copied into review artifacts. The approved evidence subset is copied into `docs/prompts-sprint/acceptance/` after a pass.

## Production baseline

PFDocs is rebased onto the manager's recovered full production source, `production-source-20260905` (`79f8a2a`), superseding the client-only baseline. It restores the ordinary-Docs stylesheet and corrected bridge tests that were missing from the first recovery. All 23 prompt, bridge, and chat protocol tests pass on the final base. No production migration, pad creation, or deployment was performed during this continuation.

## Recovery and manager review

**Export recovery** creates `tasknode.docs.recovery.v2`, containing the wallet-wrapped Docs root, the root-wrapped prompt-library key, encrypted document capabilities, and all ciphertext history rows. The export fails visibly if it cannot obtain complete prompt material. `recoverPromptLibrary` in `src/features/docs-library/prompt-recovery.js` recovers the prompt capabilities and saved text offline after the root key is unwrapped with the Docs wallet. No plaintext key or text is exported.

History is loaded when Prompts is first opened, in cancellable pages with a 15-second request deadline. Snapshot bodies and edit patches are discarded from the library summary state; an editor timeline loads saved text on demand. Ordinary Docs hydration does not wait for history.

The final acceptance writes a private, ignored synthetic review fixture to `artifacts/prompts/review-session.json`. Restore it without displaying credentials:

```sh
TMPDIR="$PWD/.tmp" node scripts/prompts-review-browser.mjs
```

This opens an unlocked synthetic session at `http://localhost:3195/#docs` in a headless Chromium browser with a loopback CDP endpoint at `http://127.0.0.1:3197`. Connect automation to that endpoint and use its existing context/page. On a desktop, add `--headed` to drive the visible browser. The helper imports the retained session and wallet vault, signs in and unlocks automatically; do not print or commit the private fixture. Task Node API is `http://localhost:8195`, PFDocs is `http://localhost:3190` (sandbox `3191`, websocket `3193`), and isolated Postgres listens on `127.0.0.1:5438`. Keep these services running after review.

For full checks with all temporary files inside this checkout, use Node 24 and `TMPDIR="$PWD/.tmp"`. Put `{"type":"commonjs"}` in `.tmp/package.json` so temporary extensionless CLI stubs retain their normal outside-repository module semantics. The local Compose web service runs as uid/gid 1000 to avoid root-owned Vite caches.

For the complete local check, set `CHROME_BIN` to the installed Chromium executable. This host only ships DejaVu; the unchanged validator-layout test also needs Liberation fonts (as available on the Ubuntu CI image). A checkout-local extraction and Fontconfig configuration are retained in `artifacts/prompts/fonts/` and `.tmp/fonts.conf`; use `FONTCONFIG_FILE="$PWD/.tmp/fonts.conf"` here. The route smoke now waits up to 20 seconds for the same required labels, including asynchronous live status, instead of testing those panels after a fixed 400 ms delay.
