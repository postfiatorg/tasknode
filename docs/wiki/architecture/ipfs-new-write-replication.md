# IPFS New Write Replication

Task Node currently has two different IPFS states:

- Historical profile NFT CIDs and sampled replay-window CIDs have been migrated
  into the clean first-party gateway.
- New task, reward, context, airdrop, and profile NFT writes still enter through
  Pinata and are not automatically copied into the clean first-party IPFS
  cluster.

That second point is the live product gap. A newly published reward CID can be
available through Pinata or `ipfs.io` while timing out on
`https://pft-ipfs-testnet-clean.fly.dev/ipfs/<cid>`. When that happens, a
sequential reader can stall task projection, Deathmarch, or any other
PFTL-pointer replay path.

## Target State

Every new Task Node CID must be:

1. written through the current pinning ingress;
2. enqueued for first-party replication;
3. pinned into the clean first-party IPFS cluster;
4. verified through the clean gateway;
5. marked healthy only after the clean gateway serves the exact CID.

Pinata may remain the write ingress and backup provider. It must not be the only
thing standing between users and a visible task, reward, context document, or
profile NFT.

## Non-Negotiables

- Preserve exact CIDs. Never repair a minted or pointed artifact by silently
  substituting a different CID.
- Keep private task, context, evidence, reward, and airdrop payloads encrypted
  before IPFS upload.
- Do not use the old `pft-ipfs-testnet-node-1` gateway as a normal read path.
  It is recovery-only.
- Gateway reads should not block behind one slow gateway. Readers should race or
  otherwise bound gateway attempts.
- A CID is not first-party healthy just because Pinata or a public gateway can
  serve it.

## Required Implementation

### 1. Keep Concurrent Gateway Reads

`fetchContextIpfsJson` should return the first valid JSON payload from the
configured gateway set and abort slower attempts after success. This prevents a
clean-gateway miss from adding a full timeout before Pinata or public fallbacks
can serve a fresh CID.

This is a read-path resilience fix. It does not replace first-party
replication.

### 2. Add A Durable CID Replication Queue

Create a durable queue table, for example `ipfs_replication_jobs`.

Required fields:

- `id`
- `cid`
- `payload_class`
- `source`
- `source_ref`
- `exact_cid_required`
- `status`
- `attempts`
- `last_error`
- `first_seen_at`
- `last_attempt_at`
- `verified_gateway`
- `verified_at`

Suggested statuses:

- `queued`
- `pinning`
- `first_party_pinned`
- `verified`
- `retry_wait`
- `failed`
- `exception_required`

### 3. Enqueue Every New CID At The Write Boundary

Every successful pin should enqueue its CID for first-party replication.

The enqueue point is after these helpers return a CID:

- `pinContextIpfsJson`
- `pinIpfsFile`
- `pinIpfsCidByHash`

Payload classes to tag:

- `task_request`
- `task_offer`
- `task_submission`
- `task_verification_response`
- `task_reward`
- `context`
- `daily_airdrop`
- `profile_nft_image`
- `profile_nft_metadata`
- `profile_nft_thumbnail`

If queue insertion fails after the CID has already been pinned, the app should
log the failure loudly and retry through an operator repair command. Do not
pretend the CID is first-party healthy.

### 4. Build A First-Party Repin Worker

The worker should:

1. select queued or retryable CIDs;
2. ask the clean cluster to pin the exact CID;
3. verify replica count through cluster status;
4. verify HTTP read through the clean gateway;
5. mark the job `verified` only after the exact CID is served.

The worker needs bounded attempts and clear failure codes. Typical failures:

- clean gateway timeout;
- Kubo provider discovery failure;
- cluster replica gate failure;
- content-type mismatch;
- CID not found on any configured gateway;
- exact re-add mismatch.

### 5. Add A Stable Clean-Cluster Pin Interface

Do not rely on manual `fly ssh` as the normal product path.

Add one of:

- an internal authenticated HTTP endpoint on the clean IPFS service;
- a queue consumer that runs inside the clean IPFS app;
- a dedicated operator worker that can call `ipfs-cluster-ctl` and report back.

The app needs a stable command equivalent to:

```bash
migrate-cids \
  --source-json /tmp/new-cids.json \
  --statuses queued \
  --min-replicas 2 \
  --exact-readd-gateway https://gateway.pinata.cloud/ipfs/ \
  --exact-readd-gateway https://ipfs.io/ipfs/
```

The real implementation should not require copying JSON files by hand.

### 6. Support Exact Re-Add For HTTP-Only CIDs

Some CIDs can be served by an HTTP gateway but fail Kubo provider discovery.
For that case, the worker may download bytes from a trusted gateway and run
exact-safe re-add.

Rules:

- compute the CID from the downloaded bytes;
- accept the repair only if the computed CID exactly equals the original CID;
- reject and record `exact_readd_mismatch` otherwise.

This is valid for encrypted JSON and public NFT artifacts because the CID stays
the same. It is not valid to replace the app row with a new CID.

### 7. Add Fresh-CID Verification

Add an operator command that answers:

> Are all CIDs created in the last N hours verified on the clean first-party
> gateway?

Example command shape:

```bash
npm run ipfs-new-write-replication-check -- \
  --lookback-hours 24 \
  --require-clean-gateway \
  --fail-on-unverified
```

The command should report:

- total CIDs created;
- verified on clean gateway;
- pending queue jobs;
- failed jobs;
- CIDs served only by Pinata/public gateways;
- oldest unverified CID age.

### 8. Add Monitoring

Alerts should fire when:

- a new CID remains unverified on the clean gateway for more than 60 seconds;
- the replication queue backlog grows above a small threshold;
- the clean gateway canary fails;
- the clean cluster has fewer than the required replicas;
- a task/reward/context replay path uses public fallback because clean gateway
  missed the CID.

## Acceptance Criteria

This work is done only when all of these are true:

- New task request CIDs are verified on the clean gateway.
- New task offer CIDs are verified on the clean gateway.
- New submission CIDs are verified on the clean gateway.
- New reward CIDs are verified on the clean gateway.
- New context CIDs are verified on the clean gateway.
- New daily airdrop CIDs are verified on the clean gateway.
- New profile NFT image and metadata CIDs are verified on the clean gateway.
- Verification is automatic, not a manual `fly ssh` migration.
- A clean-gateway miss does not block readers behind a full gateway timeout.
- The old Fly gateway is absent from default app reads.
- Operators have a command that shows fresh-CID replication health in one pass.

## Current Known Gap

The historical migration proved that the clean cluster can serve known public
profile NFT CIDs and sampled active replay CIDs. It did not create an automatic
pipeline for new CIDs.

The missing production capability is:

```text
new Pinata write -> durable replication job -> clean cluster pin -> clean gateway verification
```

Until that exists, fresh task and reward payloads can still depend on Pinata or
public gateways even though historical IPFS migration has passed.
