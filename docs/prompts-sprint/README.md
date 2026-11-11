# Encrypted Task Node prompts

A prompt is a deliberate Docs document backed by a CryptPad markdown pad. **Docs → New → New prompt** creates an `Untitled prompt — YYYY-MM-DD` document. Rename it in the editor. The **Prompts** library view shows titles, last edits, saved-version counts, UTC 7/30-day statistics, and a per-prompt timeline. **Save version** snapshots the current editor text; CryptPad revision history remains available in **File → Version history**.

Prompt documents suppress Task Node assistants. Both assistant endpoints reject prompt document IDs, and the browser and PFDocs bridge block assistant dispatch. Human document sharing still uses the existing Docs capability grants. Personal prompt history and device access are separate from those grants.

## Encryption and persistence

The browser creates a random prompt-library key and wraps it with the unlocked Docs root key. Prompt metadata and each history event use AES-256-GCM with a fresh random nonce. The history table contains only `event_id`, `account_id`, `document_id`, `created_at`, and a ciphertext envelope. SQL triggers reject event UPDATE/DELETE. Appends are idempotent by event ID and tenant-scoped. Event kinds, full saved text, patches, session timing, and TIH scores are inside the ciphertext.

Active time counts unique seconds containing local input, not elapsed editor-open time. More than two minutes without input ends a session. Thirty-second encrypted checkpoints and a final checkpoint on leaving the editor use a stable session ID; stats select the latest checkpoint so overlapping checkpoints do not inflate time. Input across midnight is split into UTC dates. Browser and CLI use the same local reducer. An abrupt process kill can lose input since the last checkpoint; the editor reports failed saves.

Migrations: `160_prompt_documents.sql` and `161_prompt_devices.sql`. No production migration or deployment is performed by this branch. The append-only trigger intentionally prevents generic deletion of history; any future account-erasure/retention design must explicitly reconcile that policy.

## Local agents

The CLI requires Node 22 or newer. Run `tasknode connect` (or the installer) and complete normal account sign-in. It generates an X25519 device keypair locally, registers only its public key, saves the private device file with mode 0600, and registers **tasknode-prompts** beside the hosted **tasknode** MCP entry. The curl installer now retains its runtime modules and dependencies in the user's Task Node configuration directory.

In the unlocked Docs browser, match the device fingerprint printed by the CLI and select **Approve prompt access**. The browser uses the same X25519/XChaCha20 envelope as Docs grants to wrap the prompt-library key to that device. `/connect` lists these devices and can revoke them; the approval link opens Docs so the wallet remains the browser's unlock boundary. Each local tool call and relay request checks the terminal session and device grant. Revocation blocks future relay access but cannot erase content or pad capabilities already obtained by an authorized device.

Local tools: `prompt_list`, `prompt_create`, `prompt_read`, `prompt_edit`, `prompt_save_version`, `prompt_history`, `prompt_stats`, `prompt_log_tih_run`. Edits use unique exact-text replacement patches and reject stale/ambiguous matches. Reads and writes join PFDocs through ChainPad, with content decryption entirely in the local process. The hosted `/mcp` tool catalogue gains no prompt plaintext tool. TIH is run by the user's agent locally; its tool only records before/after scores.

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
5. Run `for test in history stats device assistant pad; do node "scripts/prompt-$test-smoke.mjs" || break; done`. History smoke defaults to the isolated local Postgres port 5438; override `DATABASE_URL` for another loopback database.

The runner saves JSONL stages, a raw ciphertext-only history row dump, and a browser screenshot under ignored `artifacts/prompts/acceptance-*`. Device files and runtime credentials remain ignored and must never be copied into review artifacts. The approved evidence subset is copied into `docs/prompts-sprint/acceptance/` after a pass.

## Production baseline

PFDocs is rebased onto the manager's recovered full production source, `production-source-20260905` (`79f8a2a`), superseding the client-only baseline. It restores the ordinary-Docs stylesheet and corrected bridge tests that were missing from the first recovery. All 23 prompt, bridge, and chat protocol tests pass on the final base. No production migration, pad creation, or deployment was performed during this continuation.
