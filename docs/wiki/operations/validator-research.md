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

Chat Deep Research defaults to GoodAlexander for every signed-in account, billed at cost from its Task Node balance. `CHAT_RESEARCH_PROVIDER=corbanu` is an explicit rollback switch for new jobs only; leaving it unset selects GoodAlexander. Missing GoodAlexander configuration makes research unavailable rather than silently choosing another provider. The selected provider is persisted per chat job, so polling and retries continue through the original provider even if the binding changes. GA chat jobs use the same durable reservation and settlement path as research API jobs; completed reports and exact/billed costs are saved in the conversation. The separate Research page is removed. Models are linked from the account menu and Validator settings; research API keys remain in Settings → API keys.

Every signed-in account can use chat research with at least $0.50 available Task Node USD credit. Research API keys and models remain validator-gated; validator monthly rewards are unchanged. Chat first requests a free routing preview: the structured research router chooses fast or agent and returns an account/question/mode-bound token valid for 15 minutes. The user reviews the maximum before a second submit starts research. The default is $1.50 for fast or $3 for agent, reduced to available credit when at least $0.50 remains after pending reservations. An explicit chat maximum accepts $0.05–$10 with at most six decimal places; it is never rounded upward. Preview failure starts no job and does not guess a mode. Editing the question invalidates the displayed preview. An explicit user maximum is preserved and must fit available credit. Omitted-cap retries reuse the stored maximum even if the balance or default changes. Admission reserves the selected maximum cost. Completion debits the actual provider cost rounded up once to $0.000001, including costs incurred by failed jobs, and releases unused reserved credit. Repeated status or result reads do not charge again.

Configure `GA_RESEARCH_URL=https://research.goodalexander.com:18443/ga-research` and `GA_RESEARCH_HMAC_SECRET` as deployment secrets. The gateway, registry and pinned signer use the branded host on port 18443. The former base `https://178-156-143-199.sslip.io:18443` remains reachable as an operator rollback endpoint through November 4, 2026; preserve that TLS alias for the seven-day transition. Clients refuse redirects; rollback uses an explicit endpoint/config change. The gateway signs the internal `/v1/research` path, uppercase method, Unix timestamp, account ID, and SHA-256 of exact request bytes with newline-separated HMAC-SHA256. It sends X-GA-Account, X-GA-Timestamp, X-GA-Signature. GET bodies are empty. HTTPS redirects are refused. POST calls allow 45 seconds and GET calls 20 seconds; these are individual request limits, not job lifetimes. Provider status and result must agree on job ID and total USD cost. Failed jobs retain their incurred provider costs.

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

## Post Fiat L1 devnet

Settings → Validator has a network choice. Select **Post Fiat L1 devnet** to get:

```sh
curl -fsSL https://tasknode.postfiat.org/l1-validator.sh | sh -s -- <token>
```

Run as root on the Linux x86_64 host running `postfiat-node transport-validator-serve`. The wrapper reads that process's exact `--key-file` / `--data-dir` arguments and the public node ID from `node_state.json`; it never searches directories for keys. `sh l1-validator.sh --discover` reports only the configured path and public validator ID. Python 3 and `unshare` are required. Ambiguous/missing processes, relative paths, unsupported platforms, and unavailable network isolation fail before signing.

The wrapper downloads the static signer from `https://research.goodalexander.com:18443/l1-registry/l1-validator-signer-linux-x86_64`, refuses redirects and checks SHA-256 `63c5e3d56556447dc06cbcd9fd0b4d8e620dc17068166bb51d3cdb41f50f6eca`. It executes from a sealed anonymous memory file under `unshare --net`, with core dumps disabled. The helper reads the configured private key only inside that offline child. No helper, key or proof file is written to disk. It sends only the connect capability, network, validator ID, ML-DSA public key and signature to Task Node.

Task Node verifies pure FIPS 204 ML-DSA-65 with pinned `@noble/post-quantum` 0.7.1, over the exact UTF-8 challenge with context `postfiat-l1-v2/tasknode-validator-binding/v1`. The fixed trusted registry is `https://research.goodalexander.com:18443/l1-registry/registry.json`, chain `postfiat-wan-devnet-2`. Each proof fetches a bounded (1 MiB), timed (10 seconds), no-redirect snapshot. Validation requires the expected schema/network/chain, distinct agreeing source observations, valid commit metadata, unique IDs/keys, and age at most one hour (future tolerance 60 seconds). Fresh observation time does not imply fresh blocks. Unknown/inactive IDs, a key different from the registry, malformed/wrong-context signatures, expired or reused challenges, and mixed Ledger/L1 proof fields are refused.

Migration 156 adds L1 identity/evidence columns and constraints to `validator_bindings`; existing Ledger key columns and uniqueness retain their meaning. The full ML-DSA public key is stored separately. A unique network/chain/validator-ID index and a unique SHA-256 public-key index protect both identities. The public proof is retained on the consumed connect token; the binding retains registry height/root/genesis/time. Key rotation requires explicitly unbinding the existing identity before reconnecting; it never silently replaces another account's binding. These changes do not alter billing tables or issue credit.

L1 binding immediately enables the same models, research keys and at-cost chat access. **L1 monthly credit waits for observed coverage**. Current chain records cannot establish a retrospective UTC participation window. D63 authorizes timestamped observations using Track E's conservative observer brackets: at least 25 of the last 30 complete UTC days must be reported, with at least 95% unweighted mean daily signed/committed block ratios. Unknown or incomplete days and days without committed blocks do not count. Registry `available` must also be true. The grant boundary fetches fresh trusted evidence for the canonical stored identity and recomputes eligibility; a caller-supplied eligible flag cannot issue credit.

Migration157 adds only `l1_validator_reward_grants`, preserving existing Ledger reward and billing schemas. Both stable network/chain/validator-ID/month and public-key-digest/month are unique. The receipt and $20 ledger entry commit atomically. Account deletion anonymizes but retains the receipt, preventing repeat payouts after rebinding. Existing reward enablement and first-UTC-day scheduling apply. No reward is granted merely for binding or before sufficient observed coverage exists.

Focused checks: `node scripts/l1-validator-smoke.mjs`, `node scripts/l1-validator-shell-smoke.mjs`, `node scripts/l1-validator-postgres-smoke.mjs`, and `node scripts/l1-validator-rewards-postgres-smoke.mjs` against an isolated migrated test database. Fixtures use throwaway keys and Track E's public Rust signature vectors. The shell test checks process discovery, public-only handoff and the sealed/offline invocation; it does not prove a real host's private-key signing. Production acceptance requires an operator to run a fresh command on a Foundation L1 validator, followed by durable binding, replay, entitlement and UI checks. Never run fixture tests against production.

The chat report card displays **Improvement round: done** for `quality.tih.round_status=completed` and **skipped** for `skipped_unaffordable`. An interrupted round is labeled **interrupted**, never done. Missing/unknown metadata on older jobs displays no invented round outcome. The full provider result remains in the existing result JSON; no schema migration is needed.

## Research agent jobs

Migration 158 adds only `research_gateway_jobs.progress_json` and
`deep_research_jobs.research_options`. It does not change billing tables or views.
Mode, budget and the opaque preview token are durable; token text is omitted from
public job responses and does not change idempotency. Existing requests retain
their saved mode/cap. A definitively expired preview releases its reservation at
zero cost; ambiguous network failures retain the request for reconciliation.

Monotonic progress persists sequence, stage, step, document counts, elapsed time
and exact provider spend. Status polls are serialized, survive chat reloads and
continue beyond 15 minutes without submitting a replacement job. Late polls or
attachments cannot erase a terminal report. Provider restarts can fail jobs with
incurred cost; settlement still debits ceil6 exactly once.

Reports render safe Markdown tables, citations and code fences, with bounded typed
result tables (20 tables, 30 columns, 500 rows each) and explicit partial-result
labels. Chart rendering awaits a service chart schema; the current contract
returns an empty charts array. The research path has no direct data-source tools.
It delegates them to GoodAlexander; the import-graph regression forbids Bloomberg
clients, bridge configuration, SQL tables, caches and URLs. Tiingo is permitted.

Focused checks: `node scripts/research-agent-smoke.mjs` and
`node scripts/research-agent-postgres-smoke.mjs` (isolated test database only).
The database fixture checks preview without funding, reservation-aware defaults,
agent cap 3/max 10, a 15-minute job, terminal races, preview expiry, replay, owner
isolation and successful/failed ceil6 settlement. Browser evidence must also
cover preview before submission, reload, mobile tables and both route defaults.
Rollback deploys the prior image and retains the added columns and receipts; do
not drop active job state. Production acceptance uses approved capped UI jobs.
