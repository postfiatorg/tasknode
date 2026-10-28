# Validator research operations

The HTTP process owns validator proof, API-key, gateway, and gated-viewer routes. `worker-validator-research` uses `TASKNODE_PROCESS_ROLE=worker:validator-research` to reconcile durable research jobs every 30 seconds and run monthly rewards on the first UTC day. Research reconciliation continues after the browser closes. Retry uses the durable job ID as the upstream request ID.

## Validator signing

Settings → Validator issues a one-time connect token bound to the signed-in account and valid for 30 minutes. The default command is:

```sh
curl -fsSL https://tasknode.postfiat.org/validator.sh | sh -s -- <token>
```

`public/validator.sh` reads the running node's `--conf` path and `server_info.pubkey_validator`, then signs with the `[validator_token]` ephemeral Ed25519 or secp256k1 key inside a new container using the existing image. Python stdlib parses the token and identifies the signing algorithm from its public manifest, independently of the master key type. The image's OpenSSL derives the matching public key and signs raw UTF-8 for Ed25519 or SHA512Half for secp256k1. Ed25519 uses an anonymous memory file for the public challenge because OpenSSL requires its input length; private DER stays on a pipe. Secret input stays in memory/anonymous pipes. The signer has `--network none`, `--read-only`, read-only volumes, `--log-driver none`, `--cap-drop ALL`, `no-new-privileges`, and core dumps disabled; it runs as the input file's owner. No downloads, installs, secret files, stdout, or token transmission. Only `{token, master_public_key, signing_public_key, signature, manifest}` leaves the host; `token` here is the Task Node connect capability, never the validator token.

The server checks the current `signing_key` on the master key's devnet/testnet VHS row on every delegated proof, verifies the challenge signature against that key, and validates both signatures in the public manifest when supplied. It rejects revoked masters, unknown/current-key-missing/stale signing keys and invalid manifests. The original binding retains its public signature evidence; `validator_connect_tokens.proof` records each successful connect/reconnect's public proof. Migration 155 adds only public proof fields to these validator tables.

Master-key signing is available only with explicit `--keyfile /existing/path/validator-keys.json`; there is no home directory or backup search. The file must be accessible on the host or through a mounted volume. This path also uses the offline image and a read-only mount. Append `--diagnose` to show safe step names and distinguish config-read, token/manifest decoding, public-key derivation and signing failures. Exception text, config contents and secrets are never logged. Download/inspect instructions and manual signing remain under disclosures.

Only the SHA-256 token hash is stored. Creating a token requires a session; challenge and completion accept the token as a short-lived capability. A supplied session must belong to the token account. The challenge and token are consumed together with the binding in one transaction. Expired, reused, wrong-account and invalid-signature proofs fail. Reconnecting a key already bound to that same account confirms the existing binding without unbinding. Another account cannot take it. The owning browser polls an account-scoped status endpoint and refreshes its access after completion. Keep command tokens out of logs, screenshots intended for public sharing, and issue trackers.

The default signature proves control of the registered validator’s current delegated signing key. The master public key remains the stable identity. Nothing is submitted to the ledger. **Advanced** retains these manual commands.

When the key is inside the running `postfiatd` container:

```sh
docker exec postfiatd validator-keys --keyfile /root/.ripple/validator-keys.json sign "<challenge>"
```

When the key file lives on the host:

```sh
docker run --rm --network none -v /path/to/validator-keys.json:/keys/validator-keys.json:ro --entrypoint /usr/local/bin/validator-keys <postfiatd image> --keyfile /keys/validator-keys.json sign "<challenge>"
```

Replace `<challenge>` with the complete challenge from Settings. For the host command, replace the source file path with the existing validator key path and `<postfiatd image>` with the Post Fiat image already used on that host. The ephemeral container runs without networking, with the key mounted read-only. For manual signing, do not inspect, copy, print or move key files or validator tokens. Submit only the master public key and returned signature to Task Node.

## Billing and monthly rewards

Chat Deep Research selects GoodAlexander for accounts with an active validator binding; other accounts retain Corbanu. The selected provider is persisted per chat job, so polling and retries continue through the original provider even if the binding changes. GA chat jobs use the same durable reservation and settlement path as research API jobs; completed reports and exact/billed costs are saved in the conversation. The separate Research page is removed. Models are linked from the account menu and Validator settings; research API keys remain in Settings → API keys.

Accounts with an active validator binding can use research with at least $0.50 available Task Node USD credit. Admission reserves the selected maximum cost. Completion debits the actual provider cost rounded up once to $0.000001, including costs incurred by failed jobs, and releases unused reserved credit. Repeated status or result reads do not charge again.

Configure `GA_RESEARCH_URL` and `GA_RESEARCH_HMAC_SECRET` as deployment secrets. The gateway signs the internal `/v1/research` path, uppercase method, Unix timestamp, account ID, and SHA-256 of exact request bytes with newline-separated HMAC-SHA256. It sends X-GA-Account, X-GA-Timestamp, X-GA-Signature. GET bodies are empty. HTTPS redirects are refused. Provider status and result must agree on job ID and total USD cost. Failed jobs retain their incurred provider costs.

`TASKNODE_VALIDATOR_REWARDS_ENABLED=true` authorizes the worker and CLI to grant real credit. Keep it disabled until deployment approval. The existing HTTP administrative credit route remains disabled. Dry runs do not require the enable flag:

```sh
node scripts/validator-rewards.mjs --month 2026-10
node scripts/validator-rewards.mjs --month 2026-10 --account ACCOUNT_ID --run
```

Each eligible validator key receives $20 on the first UTC day of the payout month. Eligibility requires mean daily VHS agreement of at least 0.95 over the preceding 30 complete UTC days, with at least 25 distinct days reported, on the registered devnet or testnet network. Month names the payout month: October uses the 30 complete UTC days ending October 1; November 1 uses `2026-11` and the window October 2–November 1 (end exclusive). The CLI permits explicit catch-up after an outage. Production deployment and real-credit runs require the operator's approval. Grant and billing projection updates share a transaction; the key `validator-reward:<master-key>:<payout-month>` prevents duplicate grants across workers or account rebindings. A payout in an earlier month does not block the next month's eligible payout. VHS failure excludes the affected key from grants and appears in the report.

## Private bundle publication

Publish private static exports outside the public repository:

```sh
node scripts/publish-validator-bundle.mjs --directory /private/export --id ga-models --title 'GoodAlexander models'
node scripts/publish-validator-bundle.mjs --directory /private/export --id ga-models --title 'GoodAlexander models' --publish
```

Default mode validates without publishing. Publication compresses the static file map and encrypts it with AES-256-GCM. Ciphertext is stored in `index_viewer_bundles`; its key is held by `index_viewer_indices`. `/api/index-viewer/indices/<id>/content` serves only ciphertext. `/api/research/bundles/<id>/index.html` and every relative asset check the signed-in account's tier, then decrypt the bundle in memory. Catalog entries contain no keys. EXPORT.md and MANIFEST.sha256 are excluded. Never commit private exports, archive contents, keys, or internal research. Files must use relative URLs; the bundle is served under a prefix.

Static viewer code exchange requires an explicit allowlisted Origin matching the code's stored return origin. Tokens are also origin-scoped. Configure `INDEX_VIEWER_ALLOWED_ORIGINS` only for trusted viewer origins. Redirects require that same allowlist, HTTPS (or explicitly allowed local HTTP), and no embedded credentials. Unknown tiers fail closed.

Exact provider totals remain in research_gateway_jobs.cost_usd as numeric(30,12). Ledger settlement rounds up once per job to six decimals, using integer decimal arithmetic. Existing billing tables and projections retain their six-decimal precision. Status and result expose the exact usage.total_cost_usd and billing.amount_usd.

Migrations 152–153 add validator proofs, bindings, keys, jobs, grants, and encrypted bundles, and revoke old viewer grants during the origin-binding repair. Migration 154 adds connect tokens and provider/budget columns to chat research jobs. Existing billing tables and the reward rollup view are not altered. Rollback retains the compatible added tables and grant receipts.

Focused verification: `node scripts/validator-research-smoke.mjs`, then `node scripts/validator-research-postgres-smoke.mjs` and `node scripts/index-viewer-smoke.mjs` against an isolated PostgreSQL database. The DB suite exercises concurrent credit admission, concurrent completion/reward settlement, failures, origin attacks, replay, ownership, and revocation.

One-command and chat verification: `node scripts/validator-connect-shell-smoke.mjs` uses synthetic keys and mocked host tools; `node scripts/validator-connect-postgres-smoke.mjs` uses an isolated PostgreSQL database and fixture providers to prove replay/expiry/account isolation, reconnection, chat routing, report persistence, and one ceil6 debit. Never point these fixture tests at production.
