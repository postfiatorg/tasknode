# Validator research

Settings → Validator connects a devnet or testnet validator to your Task Node account. The signature proves control of the validator master key and binds that key to your account. It signs a one-time challenge, not a ledger transaction: nothing is submitted to the ledger. A validator key can belong to one account; an account can bind several keys. Your private validator key stays on its host.

Create a challenge in Settings, then choose the command matching where the existing key file lives. Replace `<challenge>` with the complete challenge shown in Settings. It expires after 30 minutes and can be used once.

If the key is inside the running `postfiatd` container:

```sh
docker exec postfiatd validator-keys --keyfile /root/.ripple/validator-keys.json sign "<challenge>"
```

If the key file is on the validator host:

```sh
docker run --rm --network none -v /path/to/validator-keys.json:/keys/validator-keys.json:ro --entrypoint /usr/local/bin/validator-keys <postfiatd image> --keyfile /keys/validator-keys.json sign "<challenge>"
```

For the host command, replace `/path/to/validator-keys.json` with the existing key file's path and `<postfiatd image>` with the Post Fiat image already used on that host. The temporary container has no networking and mounts the key read-only. Run either command on the validator host; paste only the master public key (`nH…`) and returned signature into Settings. Never paste, copy or upload the key file or a validator token.

A bound validator unlocks Research in the app, GoodAlexander financial models, and the internal research catalog. Unbinding removes that access when no bound keys remain. The internal research collection may initially show a placeholder while material is prepared.

Research answers company and financial questions with supporting sources. Choose a maximum cost before submitting. The job is charged to your Task Node USD credit at the provider's reported cost rounded up to $0.000001 per job. The job preserves the exact provider total and shows both the provider total and ledger charge. You need at least $0.50 available. Pending research reserves its maximum cost; completion releases the unused portion. Provider costs incurred by a failed job are still charged. Fetching a result repeatedly never charges twice.

The Sources section below a completed report matches its citation IDs. Expand a source to inspect the underlying financial rows or management-call evidence, and open its source link when available.

Settings → API keys lets validator accounts create and revoke research keys. Copy each key when it is created; it is shown once. Use `Authorization: Bearer tnr_…` with `POST /api/research/v1/jobs`, then read `GET /api/research/v1/jobs/{job_id}` and `GET /api/research/v1/jobs/{job_id}/result`. The create body contains `question`, optional `max_cost_usd` (up to $5), and optional `request_id`. Reuse the same request ID and body when retrying a submission. A key only accesses its owner's jobs.

Eligible validators earn $20 of Task Node credit per key per payout month. Eligibility requires mean daily agreement of at least 95%, with at least 25 reported days in the preceding 30 complete UTC days. Rewards run on the first UTC day of the month using the registered network's VHS daily reports. The month label is the payout month: November 1 uses `2026-11`, and its 30-day window is October 2 through October 31. A prior month's payout does not block a later month's payout. Settings shows current agreement and the next reward date; eligibility is checked again at payout. Repeating a payout for the same key and payout month does not grant additional credit.
