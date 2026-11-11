# Finance Hub on-demand file loading

Scope: fix the reported multi-minute Finance Hub startup by serving only requested
files from private encrypted storage. The user's November 11 performance request
authorizes this bounded implementation. Financial data and access rules stay intact.

## Current code

- `server/validator-bundles.js` reads the entire approximately 19 MB encrypted
  archive in 1 MiB database chunks, decrypts it, and expands every file before
  serving one asset. Its cache reduces repeat work but every publication is cold.
- `scripts/publish-validator-bundle.mjs` currently publishes one encrypted map.
- `src/features/research/FinanceHubView.jsx` embeds the gated file endpoint. The
  separately published model viewer already uses relative per-file fetches.
- Existing public ciphertext downloads and legacy clients need compatibility.

## Work and acceptance

1. Add versioned, individually encrypted file storage and atomic publication.
   - Each file is compressed/encrypted separately and authenticated with its
     index ID, archive version and path; only ciphertext enters the database.
   - Publication switches catalog, archive and file rows in one transaction;
     preserve the preceding version for in-flight requests and rollback.
   - Legacy encrypted archive downloads and older publications keep working.
2. Fetch requested files after the existing validator authorization check.
   - A cold `index.html` read never requests/decrypts the full archive or models.
   - Coalesce identical concurrent reads; bound cached decoded bytes and entries.
   - Keep authorization on cached reads and reject invalid paths before data reads.
   - Missing or corrupt file rows do not trigger a hidden full-archive load.
3. Validate and deliver the actual behavior.
   - Exercise encryption integrity, version isolation, concurrent reads, cache
     eviction, failed-read recovery, authorization, legacy compatibility and SQL
     publication/rollback against an isolated database.
   - Measure cold home/model reads using the real export, preserving financial
     bytes. Record query/transfer sizes and browser navigation results.
   - Run focused tests, migration registration, lint/build and relevant CI.
     Verify publication/runtime state before claiming the live site is fixed.

## Validation, November 11

- `node --test scripts/validator-bundle-files.test.mjs scripts/validator-encrypted-bundle.test.mjs`:
  15 passing tests, including 40 simultaneous cold requests, auth on cache hits,
  integrity/version/path isolation, legacy compatibility and cache bounds.
- `scripts/validator-bundle-files-postgres.test.mjs` against an isolated PostgreSQL
  container: actual publisher exercised; injected insert failure rolls back the
  catalog/archive/files together; preceding-version retention and pruning pass.
- Replayed the existing 59-model production export in that isolated database:
  363 files, 45,592,102 plaintext bytes, 19,162,677-byte legacy ciphertext.
  The 12 home assets read 221,307 encrypted bytes (98.85% less); no company model
  was read. All 59 model output files matched source bytes exactly.
- Headless Chromium against the real HTTP file handler and isolated database:
  home ready in 231 ms locally; AAPL summary, NVDA target, MSTR income statement
  and Macro rendered with no page errors or failed local asset requests. The
  external optional live-price request was disabled for this local measurement.
  These timings are not a production latency claim.
- Migration registration, lint, security checks, unit/integration tests, all 195
  existing unit smoke scripts, build and asset-budget checks passed. The first
  end-to-end invocation lacked `google-chrome`; the remaining end-to-end checks
  passed with the installed Playwright Chromium through `CHROME_BIN` (all ten
  application routes and the static-asset fallback).

Local evidence is under `/home/postfiat/outputs/finance-hub-loading-20261111/`.
Private exported model content remains outside git. Production rollout requires
the migration, reader/publisher release and a republish before the file path is
active; local validation alone does not establish live closure.
