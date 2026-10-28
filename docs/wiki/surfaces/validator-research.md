# Validator research

Settings → Validator connects a PFT Ledger devnet/testnet or Post Fiat L1 devnet validator to your Task Node account. The signature proves control of the running validator and binds its master public key to your account. It signs a one-time challenge, not a ledger transaction: nothing is submitted to the ledger. A validator key can belong to one account; an account can bind several keys. Your validator token stays on its host; the master key can stay offline.

Select **PFT Ledger devnet / testnet** for the Ledger command below. For L1, see **Post Fiat L1 devnet** later on this page. Copy the complete command and run it on the validator host:

```sh
curl -fsSL https://tasknode.postfiat.org/validator.sh | sh -s -- <token>
```

Use the complete command from your Settings page, which includes your account's single-use token. It expires in 30 minutes. The script uses the running node’s validator token to sign locally and sends only public proof. Task Node checks the signing key against the current VHS listing and verifies the master-signed delegation. Settings changes to **Validator connected** automatically; nothing needs pasting. Keep this page open until it connects. Connecting the same validator again to its existing account confirms that binding without removing it.

To review the script before running it, open **Download and inspect first**:

```sh
curl -fsSLO https://tasknode.postfiat.org/validator.sh
cat validator.sh
sh validator.sh <token>
```

The host needs Docker access to its running `postfiatd` container, `curl`, `awk`, and `stat`; the image needs Python 3 and OpenSSL 3 with Ed25519 and secp256k1 support. The script reads the running node’s config path and master public key from `server_info`. A temporary container using that same image reads `[validator_token]` from the mounted config. It has no network, a read-only filesystem and volumes, no container logging or core dumps, and runs as the config file’s owner. The secret stays in memory and anonymous pipes: it is never written, printed, or sent. The signing algorithm comes from the public token manifest; Ed25519 and secp256k1 are supported independently of the master key type. No packages or crypto helpers are downloaded. Append `--diagnose` to show which step fails without exposing private input.

There is no master-key search. Only if you explicitly want master-key signing, append `--keyfile /existing/path/validator-keys.json`. The file must be on the host or in a mounted container volume. This fallback also signs offline. A stale signing key, invalid manifest, or mismatched proof is refused without consuming the connect token; wait for VHS to reflect a legitimate key rotation, then retry while the command is still valid.

**Advanced** contains the manual flow and unbinding. Create a manual challenge there, then replace `<challenge>` below with the complete challenge shown in Settings. It expires after 30 minutes and can be used once.

If the key is inside the running `postfiatd` container:

```sh
docker exec postfiatd validator-keys --keyfile /root/.ripple/validator-keys.json sign "<challenge>"
```

If the key file is on the validator host:

```sh
docker run --rm --network none -v /path/to/validator-keys.json:/keys/validator-keys.json:ro --entrypoint /usr/local/bin/validator-keys <postfiatd image> --keyfile /keys/validator-keys.json sign "<challenge>"
```

For the host command, replace `/path/to/validator-keys.json` with the existing key file's path and `<postfiatd image>` with the Post Fiat image already used on that host. The temporary container has no networking and mounts the key read-only. Run either command on the validator host; paste only the master public key (`nH…`) and returned signature into Settings. Never paste, copy or upload the key file or a validator token.

Every signed-in account can use at-cost **Deep Research in chat** through the GoodAlexander API at `research.goodalexander.com:18443`. A bound validator additionally unlocks research API keys, eligible monthly credit and the **GoodAlexander models** link in the account menu and Settings → Validator. There is no separate Research page. Unbinding removes validator API-key and models access when no bound keys remain; chat research remains available with sufficient balance.

In chat, choose **Deep Research** from the composer menu, set the maximum USD cost, and send your question. The default is $1.50, or your available balance if it is between $0.50 and $1.50. You pay actual provider cost, rounded up once to six decimals; the report card says whether its improvement round was done or skipped. Your report appears in the conversation, with citations and a Sources section, and can be downloaded. You can close the browser and return to the chat while research continues.

The job is charged to your Task Node USD credit at the provider's reported cost rounded up to $0.000001 per job. The report card shows both the exact provider total and the ledger charge. You need at least $0.50 available and enough for your chosen maximum. Pending research reserves its maximum cost; completion releases the unused portion. Provider costs incurred by a failed job are still charged. Fetching a result repeatedly never charges twice.

Settings → API keys lets validator accounts create and revoke research keys. Copy each key when it is created; it is shown once. Use `Authorization: Bearer tnr_…` with `POST /api/research/v1/jobs`, then read `GET /api/research/v1/jobs/{job_id}` and `GET /api/research/v1/jobs/{job_id}/result`. The create body contains `question`, optional `max_cost_usd` (up to $5), and optional `request_id`. Reuse the same request ID and body when retrying a submission. A key only accesses its owner's jobs.

Eligible validators earn $20 of Task Node credit per key per payout month. Eligibility requires mean daily agreement of at least 95%, with at least 25 reported days in the preceding 30 complete UTC days. Rewards run on the first UTC day of the month using the registered network's VHS daily reports. The month label is the payout month: November 1 uses `2026-11`, and its 30-day window is October 2 through October 31. A prior month's payout does not block a later month's payout. Settings shows current agreement and the next reward date; eligibility is checked again at payout. Repeating a payout for the same key and payout month does not grant additional credit.


## Post Fiat L1 devnet

Choose **Post Fiat L1 devnet** in Settings → Validator, then run the displayed command as root on your Linux x86_64 L1 validator host:

```sh
curl -fsSL https://tasknode.postfiat.org/l1-validator.sh | sh -s -- <token>
```

Use your Settings page's complete command. The verified signer and validator registry are served from `https://research.goodalexander.com:18443`. The script identifies your running node and signs the single-use challenge with its configured ML-DSA-65 key, with networking disabled during signing. It downloads a checksum-verified signer into memory; it does not install a program or create key/proof files. Only public proof leaves the host. Python 3 and network namespace support (`unshare`) are required. **Download and inspect first** lets you review the wrapper before running it.

Task Node checks your public key against the current trusted L1 registry, refuses registry data older than one hour, and automatically changes the page to **Validator connected**. One validator identity can belong to one account. You can inspect its public ID, chain and public key in Settings. Reconnecting confirms the existing binding; rotating its key requires unbinding that identity first. No transaction is submitted to either chain.

L1 validators immediately receive the same models link, research API key access and at-cost Deep Research in chat. **L1 monthly credit waits for observations**. At least 25 of the last 30 complete UTC days must be observed, with at least 95% mean daily participation. Observations began on October 28, 2026; earlier block heights cannot establish historical UTC coverage. Incomplete days and days without verifiable committed blocks do not count. Settings shows progress. Models and research are available immediately after connecting; $20 credit starts only when the observation threshold is met at a monthly payout check.
