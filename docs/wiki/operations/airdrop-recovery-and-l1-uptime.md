# Historical airdrop recovery and L1 uptime rollout

Historical airdrop settlement must use the exact completed production run ID.
Never promote scoring failures or clear uncertain submission states to make a
retry succeed. The locked claim checks active account/wallet blacklists,
submission timestamps and hashes, and indexed run/CID pointers before clearing
retry metadata. The final submission transition repeats those checks and fences
stale workers with the claim's attempt count. The signed hash, CID and payload
digest are durable before the ledger submission. An ambiguous outcome stays held.

The default read-only recovery preview should enumerate each run, recipient
handle, masked destination, amount and blocking reason. The operator must retain
that exact set for sequential settlement and independently verify each validated
ledger receipt. A cache miss never proves non-payment after an attempted submit.

## New L1 policy

`TASKNODE_L1_UPTIME_REWARDS_ENABLED` defaults to false and is explicitly false in
the current production `fly.toml`. `config/new-l1-rewards.env.example` enables it
for the separate new-L1 rollout. The flag affects only L1 bindings; legacy VHS
rewards retain their existing policy. No live validator is switched by this release.

The new policy uses per-validator uptime, including idle days, while retaining
the existing 30 complete UTC day window, 25 observed day minimum, 95% unweighted
daily mean, and $20 monthly credit. Its 900-second observation cadence derives
from PR #180's maximum observer gap, yielding 96 scheduled probes per day.
Missing/incomplete days never imply uptime. A complete day must account for all
96 probes; failed probes count offline. Policy and exact evidence are saved in
the existing atomic monthly grant receipt.

The existing PR #180 registry currently publishes **block participation only**.
It does not prove per-validator uptime during idle periods. The flag deliberately
holds rewards until the trusted registry exports this explicit additional record
on each validator, bound to its current ID and public key:

```json
{
  "schema": "postfiat-validator-uptime-v1",
  "validator_id": "validator-1",
  "ml_dsa_public_key": "current registry public key",
  "time_basis": "validator_probes",
  "cadence_seconds": 900,
  "window_start": "2026-11-01T00:00:00Z",
  "window_end": "2026-12-01T00:00:00Z",
  "daily": [{"date":"2026-11-01","complete":true,"expected_samples":96,"observed_samples":96,"online_samples":96}]
}
```

The exporter must independently observe each validator; two healthy source RPCs
or an unchanged chain head cannot be copied as uptime for the entire committee.
Exporter deployment is separate from this Task Node consumer. This release does
not modify any validator, exporter service or chain configuration.
