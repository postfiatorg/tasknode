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

## Signed three-observer feed (Pillar 3)

The contract is `postfiatl1v2` `docs/specs/validator-uptime-feed-v1.md`. Three
independent observers sign what they saw; Task Node acts only on what two of
them agree on. It is a different thing from the probe record above, although
both carry the schema name `postfiat-validator-uptime-v1`: the probe record
sits inside the registry row of one validator, the feed is its own document.
When the feed is enforced it decides access and the monthly credit, and the
probe record is not consulted.

| Variable | Meaning |
| --- | --- |
| `TASKNODE_L1_UPTIME_FEED_URL` | HTTPS URL of the bundled feed. |
| `TASKNODE_L1_UPTIME_FEED_KEYSET_JSON` | The pinned `postfiat.observer_keyset.v1`: chain and the three observer keys. Installed by the operator, never taken from the feed. |
| `TASKNODE_L1_UPTIME_FEED_ENFORCED` | `true` to act on the feed. Unset or anything else: the feed is read and stored, and nothing is enforced. |

With the URL and the keyset set, the `validator_research` worker reads the feed
every five minutes (`server/l1-validator-access.js`), verifies the three
ML-DSA-65 signatures against the pinned keyset, rebuilds every row from the
signed claims (`server/l1-uptime-feed.js`), and stores the rows in
`l1_validator_access`. `GET /api/validators` shows the stored state, the reason
and the end of grace for each L1 binding.

With enforcement on:

- a validator the feed calls `revoked` has its binding suspended
  (`validator_bindings.access_suspended_at`). A suspended binding opens neither
  the Finance Hub nor the research API, and the account's research API keys are
  revoked unless it holds another binding with access;
- a suspended binding is restored when the feed gives access again; the
  operator creates new research API keys;
- `lapsed` (the 14 days of grace) keeps access and pauses the credit;
- the monthly credit is granted only when the stored row is from a feed read
  within the last hour and says `reward_eligible`.

Nothing changes when the feed cannot be fetched, is refused, has fewer than
two attestations that count, or has no agreed row for a validator. Turning
enforcement off again stops further changes; it does not restore a suspended
binding. To restore one by hand:
`UPDATE validator_bindings SET access_suspended_at=NULL WHERE id=...`.

With enforcement on, a new L1 validator is bound only while the feed is
determinate: two pinned observers with an attestation accepted in the last
hour. Otherwise the bind answers 503 `l1_uptime_feed_indeterminate` and the
operator tries again later.

Not in this release: one credit per operator across both chains, and the
directory of validators.
