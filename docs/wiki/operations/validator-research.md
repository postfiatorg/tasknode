# Validator research operations

The HTTP process owns validator proof, API-key, gateway, and gated-viewer routes. `worker-validator-research` uses `TASKNODE_PROCESS_ROLE=worker:validator-research` to reconcile durable research jobs every 30 seconds and run monthly rewards on the first UTC day. Research reconciliation continues after the browser closes. Retry uses the durable job ID as the upstream request ID.

## Validator signing

Settings → Validator issues a one-time, account-bound challenge that expires after 30 minutes. Its signature proves control of the registered devnet or testnet validator master key; Task Node verifies the signature and binds the key to the account. Nothing is submitted to the ledger. The private key stays on the validator host.

When the key is inside the running `postfiatd` container:

```sh
docker exec postfiatd validator-keys --keyfile /root/.ripple/validator-keys.json sign "<challenge>"
```

When the key file lives on the host:

```sh
docker run --rm --network none -v /path/to/validator-keys.json:/keys/validator-keys.json:ro --entrypoint /usr/local/bin/validator-keys <postfiatd image> --keyfile /keys/validator-keys.json sign "<challenge>"
```

Replace `<challenge>` with the complete challenge from Settings. For the host command, replace the source file path with the existing validator key path and `<postfiatd image>` with the Post Fiat image already used on that host. The ephemeral container runs without networking, with the key mounted read-only. Run only the signing command; do not inspect, copy, print or move key files or validator tokens. Submit only the master public key and returned signature to Task Node.

## Billing and monthly rewards

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

Migrations 152–153 add validator proofs, bindings, keys, jobs, grants, and encrypted bundles, and revoke old viewer grants during the origin-binding repair. Existing billing tables and the reward rollup view are not altered. Rollback retains the compatible added tables and grant receipts.

Focused verification: `node scripts/validator-research-smoke.mjs`, then `node scripts/validator-research-postgres-smoke.mjs` and `node scripts/index-viewer-smoke.mjs` against an isolated PostgreSQL database. The DB suite exercises concurrent credit admission, concurrent completion/reward settlement, failures, origin attacks, replay, ownership, and revocation.
