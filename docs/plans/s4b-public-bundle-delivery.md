# Finance Hub encrypted bundle delivery

Scope authorized by the founder on 2026-11-10: repair, test, merge and deploy the public bundle serving route without changing authentication, keys or database configuration.

The public /content route bypassed the existing viewer's version cache and in-flight deduplication. Each request fetched a 19,121,411-byte bytea value (twice that in Postgres text transport). Production reported Query read timeout; three prior outside requests returned bundle_unavailable. The expected replacement is intact: SHA-256 1c6e33d1ca0e493f9f2360a9b02637d6934f96f48f504a4304a9a333b7fa91a2.

Share a bounded, hash-verified encrypted loader between public downloads and authenticated decoding. Retain two versions, derived from MAX_CACHED_BUNDLES=2. Serialize cold reads and coalesce concurrent requests. Pin the database read to the catalog hash so concurrent publication cannot cache mismatched bytes. Preserve method, publication-time, tier, AES-GCM, decompression, path and MIME checks. Log only fixed failure categories. No database timeout or pool change.

Acceptance: concurrent HTTP-handler requests produce one blob read; transient failures can recover on the next request; wrong bytes never return 200; future/missing bundles and unauthorized viewer requests remain denied. Run existing loader, route/auth checks and npm check/CI. Deploy through npm run fly:deploy:prod from an isolated pfrpc checkout, verify process groups, read back source hashes and perform concurrent public full-body reads with exact byte/hash checks.

Follow-up live verification found that coalescing alone did not eliminate a single large-row read timing out. A live comparison returned Query read timeout at 10,166 ms for one blob; 19 version-pinned 1 MiB reads reconstructed the exact current blob in 645 ms. Use 1 MiB as a conservative bounded read size; it changes transport only. Maximum accepted size 128 MiB comes from the existing decompression bound, and minimum 28 bytes is the existing 12-byte IV plus 16-byte GCM tag. No timeout/pool setting changes. Tests reject publication changes, changing lengths, truncation and malformed/oversized rows before serving.
