# Validator research

Settings → Validator connects a devnet or testnet validator to your Task Node account. Create a challenge, run the displayed signing command on the host that already holds the validator key, then paste the master public key and signature. The challenge expires after 30 minutes and works once. A validator key can belong to one account; an account can bind several keys. Your private validator key stays on its host.

A bound validator unlocks Research in the app, GoodAlexander financial models, and the internal research catalog. Unbinding removes that access when no bound keys remain. The internal research collection may initially show a placeholder while material is prepared.

Research answers company and financial questions with supporting sources. Choose a maximum cost before submitting. The job is charged to your Task Node USD credit at the provider's reported cost rounded up to $0.000001 per job. The job preserves the exact provider total and shows both the provider total and ledger charge. You need at least $0.50 available. Pending research reserves its maximum cost; completion releases the unused portion. Provider costs incurred by a failed job are still charged. Fetching a result repeatedly never charges twice.

The Sources section below a completed report matches its citation IDs. Expand a source to inspect the underlying financial rows or management-call evidence, and open its source link when available.

Settings → API keys lets validator accounts create and revoke research keys. Copy each key when it is created; it is shown once. Use `Authorization: Bearer tnr_…` with `POST /api/research/v1/jobs`, then read `GET /api/research/v1/jobs/{job_id}` and `GET /api/research/v1/jobs/{job_id}/result`. The create body contains `question`, optional `max_cost_usd` (up to $5), and optional `request_id`. Reuse the same request ID and body when retrying a submission. A key only accesses its owner's jobs.

Eligible validators earn $20 of Task Node credit per key per calendar month. Eligibility requires mean daily agreement of at least 95%, with at least 25 reported days in the preceding 30 complete UTC days. Rewards run on the first UTC day of the month using the registered network's VHS daily reports. Settings shows current agreement and the next reward date; eligibility is checked again at payout. Each key receives at most one grant per payout month.
