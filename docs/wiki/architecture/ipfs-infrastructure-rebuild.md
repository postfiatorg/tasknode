# IPFS Infrastructure Rebuild

This page describes the implemented IPFS operating state for Task Node and the migration path from the old mixed Pinata/Fly/legacy-gateway setup to reliable first-party infrastructure.

The goal is simple: every PFTL pointer and profile NFT that Task Node renders must resolve quickly, repeatably, and from infrastructure we can reason about. Users should not see random missing images, stalled task indexing, or gateway timeouts because an old node happens to be down.

Current status: done for the current Task Node dev deployment and current live CID set as of June 6, 2026 at 20:40 UTC. The clean first-party gateway is live, app reads prefer it, the active replay window passes, and all 79 current profile NFT CIDs resolve through the clean gateway. The remaining items are production operating decisions, not blockers for this rebuild.

## Review Brief

Task Node needs first-party IPFS infrastructure because profile NFTs and PFTL task payloads are part of the trust surface. If a user minted an NFT and the app cannot render it, the product looks like it lost a public asset. If a task pointer exists on-chain but the reducer cannot fetch the encrypted payload, the task list looks stale or wrong. Both failures damage user trust.

The target state is not "use Pinata" or "use Fly" as a slogan. The target state is a verified content system:

1. New writes pin through a current backend.
2. Reads prefer a current first-party gateway.
3. Public fallbacks exist only as resilience, not as the main product dependency.
4. Old PFTasks/Fly gateways remain explicit operator recovery inputs until every required historical CID is accounted for.
5. Minted NFT metadata and image CIDs are preserved exactly.
6. Private task, context, reward, and evidence payloads remain encrypted before upload.
7. Gateway health checks prove real content can be served, not merely that nginx or Kubo is alive.

The clean Fly cluster is live and has passed the two-replica canary gate. Current live inventory found `79` public profile NFT metadata, thumbnail, and image CIDs in the Task Node database. All `79` now resolve through the clean first-party gateway. An earlier June 6, 2026 scan found `70` resolvable CIDs and `9` missing old image CIDs; a later verification recovered those same 9 through current public gateways, exact-readded them, and pinned them into the clean two-replica cluster without changing their CIDs.

The active replay window for private task, submission, reward, and context JSON has also passed current-gateway verification. On June 6, 2026 at 20:23 UTC, `npm run ipfs-active-replay-window -- --lookback-days 14 --per-class 8 --max-cids 40` selected `32` recent CIDs from `1345` source rows and resolved all `32` through current gateways with `0` failures.

The safest review conclusion is:

- Keep the clean first-party gateway running.
- Keep Pinata available for writes and recovery help.
- Keep the clean gateway first in Task Node read order.
- Keep old PFTasks/Fly gateways only as explicit legacy recovery inputs.
- Keep the profile NFT unavailable-image fallback for future unresolved CIDs, but there are no known current profile NFT CID exceptions as of June 6, 2026 at 20:40 UTC.
- Use `ipfs-active-replay-window` as the repeatable replay-window gate for private JSON payloads.

## Operating Requirements

### 1. A Current First-Party Gateway

Task Node needs a gateway we control for normal product reads. Public gateways are useful fallbacks, but they should not be the only thing standing between the app and a missing profile gallery or stalled reducer.

The first-party gateway must have:

- at least two healthy replicas for production-required content;
- a public gateway URL that can be put behind a PostFiat-controlled domain later;
- Kubo and cluster versions pinned in code;
- fresh volumes that are not carrying the old Badger datastore corruption risk;
- operator commands for peers, pins, disk, cluster status, and logs;
- a health endpoint that reads a real canary CID through the gateway.

### 2. A Complete CID Ledger

We need one durable inventory of every CID the product may need to render or replay. Terminal samples are not enough.

The ledger must include:

- task request, offer, submission, verification, and reward payload CIDs;
- context history CIDs;
- profile NFT metadata CIDs;
- profile NFT image CIDs;
- imported thumbnail CIDs;
- wallet/account refs where known;
- whether the CID is public or encrypted;
- whether exact-CID preservation is required;
- which gateway first resolves it;
- content type and byte size when available;
- migration status.

This ledger is the migration source of truth. It tells operators what is safe, what is legacy-only, what needs repinning, and what is missing.

### 3. Exact-CID NFT Recovery

Profile NFTs cannot be repaired by uploading the same-looking image and displaying a new CID. The old token points at an immutable metadata URI and image URI. If Task Node shows a different CID, it is no longer showing the minted artifact.

Valid recovery paths are:

- pin-by-hash when the current provider can find the original CID;
- cluster pinning when Kubo can fetch the original blocks;
- CAR export/import from an old node;
- block transfer from an old node or another provider;
- byte re-add only when the computed CID exactly matches the original CID before pinning.

Invalid recovery path:

- re-upload bytes, get a different CID, and silently substitute it in the app.

### 4. App Read Policy

Task Node has two different read profiles.

Task JSON and context JSON are fetched by reducers. Gateway order matters because slow early gateways delay projection and task visibility. The reducer path should try current fast gateways before stale legacy gateways.

Profile NFT images should render through `/api/profile/nft/image/:cid`. The browser should not fan out directly to many gateways. The server proxy validates the CID, checks content type, enforces size limits, and caches successful image bytes.

### 5. Operator Verification

The app needs commands that answer operational questions without guesswork:

- Is the clean gateway alive?
- Can it serve the canary CID?
- Does the cluster have two peers?
- Is the canary pinned on enough peers?
- Which public NFT CIDs resolve today?
- Which CIDs are current-resolvable, legacy-only, or missing?
- Which current-resolvable CIDs have actually been pinned into the clean cluster?

The wiki command appendix below is intentionally long because this needs to be repeatable by another operator.

### 6. Cutover Gate

Do not cut over solely because the clean Fly app health endpoint is green.

Cutover requires:

- full public NFT metadata/image verification against current infrastructure or explicit visible exception;
- active task/context replay-window verification against current infrastructure;
- proof that profile galleries render through the proxy;
- a migration result file showing exact-CID cluster pin or documented exception for every required public NFT CID;
- app config with current gateways first and old gateways absent from default app reads.

## Current State

As of June 6, 2026, Task Node has two different IPFS realities.

New Task Node writes use Pinata credentials in `server/context-ipfs.js`. JSON pins use `pinContextIpfsJson`, profile NFT image bytes use `pinIpfsFile`, and legacy exact-CID repair uses `pinIpfsCidByHash`. The deployed app has Pinata configured and can publish new task, context, reward, daily-airdrop, and profile NFT payloads through that path.

The old first-party Fly IPFS app still exists:

- app: `pft-ipfs-testnet-node-1`
- repo: `/home/pfrpc/repos/ipfs-infra`
- public gateway: `https://pft-ipfs-testnet-node-1.fly.dev/ipfs/<cid>`
- machines: `iad`, `nrt`, and `ams`
- attached volumes: one `ipfs_data` volume per machine

The Fly app is not currently trustworthy as a production dependency. `iad` and `nrt` can report Kubo healthy, but sampled task evidence and profile NFT CIDs timed out or were not pinned locally. `ams` has Kubo API/gateway ports down and logs Badger datastore checksum corruption. A simple `/health` response is therefore not enough to prove the gateway can serve product content.

The cluster config is also weaker than the docs implied:

- `replication_factor_min` and `replication_factor_max` are both `1`.
- the cluster listens on `9096`, while the Fly service exposes `9094`.
- the running image does not include `ipfs-cluster-ctl`, so normal cluster inspection is awkward from inside the machine.
- Kubo is pinned to `v0.24.0`.

There is now a clean first-party testnet gateway built from fresh volumes:

- app: `pft-ipfs-testnet-clean`
- repo: `/home/pfrpc/repos/ipfs-infra`
- public gateway: `https://pft-ipfs-testnet-clean.fly.dev/ipfs/<cid>`
- public health: `https://pft-ipfs-testnet-clean.fly.dev/health`
- machines: `2879095b4dd968` in `iad` and `0807d41f944d48` in `nrt`
- volumes: `vol_4586lq71dpky8p14` in `iad` and `vol_4m3w8z5o5okyxk1v` in `nrt`
- cluster peer IDs: `12D3KooWHN4rLjNXwDcMstorPj5r6nMXa8N1REkazwVwGC5kRQyc` and `12D3KooWLNWJJdpwi3wmbcTYXj5jzSpZEVKm8yZmZ7FmxSbK8HTg`
- public IPs: dedicated IPv6 `2a09:8280:1::121:9f9e:0` and shared IPv4 `66.241.124.99`

As of June 6, 2026 at 18:43 UTC, both clean machines pass the production two-replica health gate. The public `/health` endpoint reports `ok: true`, `cluster_peers.peerCount: 2`, `cluster_canary.allocationCount: 2`, and `cluster_canary.pinnedPeerCount: 2`. The generated canary CID `bafkreih37zbprs76fv4rj65qsdutdkp3737bx335nuu43bmlpo6suvs7pi` is served publicly and returns `postfiat-ipfs-health-v1`.

Task Node now prefers the clean first-party gateway for app reads. Pinata remains the current write backend, public gateways remain resilience fallbacks, and the old Fly/PFTasks gateways are not default read dependencies. Keep old gateways available only as explicit legacy recovery inputs. Profile galleries keep an explicit unavailable-image state for future CID failures instead of replacing unresolved minted artifacts with unrelated generated art.

## Non-Negotiable Requirements

### Preserve Exact CIDs

Profile NFTs are content-addressed public artifacts. If a minted token points at `ipfs://<metadataCid>` and that metadata points at `ipfs://<imageCid>`, Task Node must preserve those exact CIDs.

Do not "fix" an already minted NFT by re-uploading the image and rendering a different CID. That would make the app display content that is not the on-chain artifact.

### Keep Private Payloads Encrypted

Task requests, task submissions, rewards, context history, private evidence, and private prompt assets must remain encrypted before IPFS upload. Public gateways may serve encrypted bytes. They must not receive plaintext private user content.

### Treat Postgres As A Cache

Postgres stores fast projections and cached NFT rows. It is not the canonical source of truth for PFTL task history or minted NFT ownership. Task state must remain replayable from PFTL pointer memos plus IPFS payloads. NFT ownership must be recoverable from wallet NFT inventory plus IPFS metadata.

### Avoid Browser Gateway Fanout

The browser should not load many gateway URLs directly for profile galleries. It should prefer the same-origin profile image proxy at `/api/profile/nft/image/:cid`, which validates CIDs, checks content type, enforces size limits, and caches successful image bytes.

### No Silent Gateway Rot

A gateway that answers `/health` but cannot serve a known pinned CID is unhealthy for Task Node. Health checks must include real canary CIDs and gateway read latency, not only process liveness.

## Target Architecture

Task Node should have one current IPFS operating model:

1. A current pinning backend for writes.
2. A current first-party gateway for reads.
3. Public gateway fallbacks for resilience.
4. A bounded same-origin proxy for profile NFT images.
5. A verified legacy CID migration path before old gateways are retired as recovery inputs.

Pinata may remain as a pinning backend or backup provider, but Task Node should not depend on the free/shared Pinata public gateway as the only high-volume read path. Public gateway rate limits and cache misses can make the product feel randomly broken.

The first-party IPFS deployment should provide:

- at least two healthy replicas for pinned production content;
- a documented replication factor greater than `1` for important public assets;
- a clear region and volume strategy;
- a current, pinned Kubo version;
- operator tooling to inspect pins, peers, disk, and canary CID status;
- gateway response checks for representative JSON and image CIDs;
- logs and alerts for gateway timeout, datastore corruption, disk pressure, and pin failures;
- an explicit backup/export story for irreplaceable legacy blocks.

## Gateway Policy

Task indexing and context history fetch JSON sequentially through configured gateways. Slow or broken gateways early in that list directly delay reducer projection and task visibility.

Profile NFT image proxy fetches configured gateways concurrently with `Promise.any`, so a slow gateway is less damaging there, but it still creates load and noisy failures.

Current policy should be:

1. Put known-current, fast gateways first.
2. Keep retired PFTasks/Fly gateways only as explicit recovery inputs.
3. Retire old gateways from recovery tooling only after a full verify pass proves every required CID resolves from current infrastructure or has an approved exception.
4. Never put a known-stale gateway before the current gateway list for reducer JSON reads.

## CID Inventory

Before rebuilding or retiring anything, build a complete CID inventory.

Required sources:

- `pftl_pointer_memos` for historical pointer CIDs.
- `task_events` for hydrated task payload CIDs.
- `profile_nfts.image_cid`.
- `profile_nfts.metadata_cid`.
- `profile_nfts.thumbnail_cid` if present in imported old data.
- old PFTasks NFT mint/cache tables or exported JSON.
- any profile NFT metadata CIDs discoverable from wallet `account_nfts`.

Each inventory row should include:

- CID.
- class: task JSON, context JSON, reward JSON, profile NFT image, profile NFT metadata, thumbnail, or other.
- source table or export.
- account id or wallet when available.
- whether it is public or encrypted.
- whether exact-CID preservation is required.
- first gateway that resolves it.
- content type and byte size when known.
- current pin provider status.
- migration status.

## Migration Status Values

Use these statuses consistently:

- `current_resolvable`: resolves from current configured gateways.
- `current_pinned`: confirmed pinned by the current pinning backend.
- `legacy_only`: resolves only from old PFTasks/Fly gateways.
- `needs_repin`: legacy gateway can serve it, but current infrastructure cannot.
- `repin_requested`: current provider accepted a pin-by-hash request.
- `repinned_and_verified`: current gateways resolve the exact CID after repin.
- `requires_block_transfer`: exact CID exists only on an old node or volume and must be moved by CAR/block transfer.
- `missing_from_all_gateways`: no known gateway can serve the CID.
- `exception_required`: operator decision needed because the CID cannot currently be recovered.

## Implemented Rebuild Plan

### Phase 1: Stop Depending On Broken Gateways

Keep the Task Node fallback patch that places `https://pft-ipfs-testnet-clean.fly.dev/ipfs/` first, then public fallbacks. Do not use the old Fly/PFTasks gateways as default app reads. They remain historical recovery inputs only.

Add or keep smoke tests that prove gateway order and one known CID read path.

### Phase 2: Build The CID Inventory

Export all known CIDs from Task Node and PFTasks. Deduplicate them. Classify them by payload type and exact-CID requirement.

For each CID, run bounded gateway checks against:

- current first-choice gateway;
- Pinata public or dedicated gateway;
- `dweb.link`;
- `ipfs.io`;
- old Fly/PFTasks gateway.

The output should be a durable JSON or table-backed report, not terminal-only output.

Task Node implements the durable JSON report path with `npm run ipfs-cid-inventory`. The script reads current Task Node tables, optional PFTasks/export JSON, or stdin. It dedupes by CID, records sample refs, labels public/encrypted payloads, labels exact-CID requirements, can run bounded current-vs-legacy gateway checks, and can optionally check Pinata pin-list status with `--check-pinata`.

### Phase 3: Stand Up Clean First-Party Infra

Do not repair the corrupt `ams` volume in place as the main plan. Preserve it until migration is complete, but build clean current infrastructure.

The new deployment should include:

- fresh volumes;
- current Kubo;
- aligned swarm, cluster, and REST/API ports;
- `ipfs-cluster-ctl` or equivalent operator commands in the image;
- replication policy documented and tested;
- canary CIDs pinned on every intended replica;
- an HTTP health endpoint that checks Kubo API, gateway canary read, disk, cluster peer count, and cluster-pinned canary replicas;
- a public gateway URL that can later sit behind a stable PostFiat domain.

The `ipfs-infra` repo now implements the clean-image target for this phase:

- `docker/Dockerfile` pins Kubo to `v0.41.0`.
- the image installs both `ipfs-cluster-service` and `ipfs-cluster-ctl`.
- fresh nodes initialize with `flatfs` instead of deprecated Badger v1.
- startup deletes stale Kubo `Reprovider` config before daemon launch.
- cluster replication defaults are `IPFS_CLUSTER_REPLICATION_MIN=2` and `IPFS_CLUSTER_REPLICATION_MAX=2`.
- the cluster swarm listens on `9096`, and the Fly configs expose `9096` instead of accidentally exposing the localhost REST API port.
- nginx `/health` proxies to a real health server instead of returning a static string.
- the health server checks Kubo API, disk free space, cluster peer inspection through `ipfs-cluster-ctl`, a generated or configured gateway canary CID through the local gateway, and whether that canary is allocated and pinned on enough cluster replicas.

The clean deployment is live on `pft-ipfs-testnet-clean` and has passed the two-replica health gate. The existing `pft-ipfs-testnet-node-1` volumes are historical state, and at least one volume is corrupt. The clean gateway is now the first-choice Task Node read gateway. There are no known unresolved profile NFT CIDs in the current Task Node database as of June 6, 2026 at 20:40 UTC.

### Phase 4: Repin What Public Gateways Can Still Serve

For every `needs_repin` CID, use exact-CID pinning, not normal re-upload.

The existing Task Node operator path is `profile-nft-cid-repin`, which uses Pinata `pinByHash`. That remains useful for provider-based repinning.

The first-party cluster path lives in the `ipfs-infra` image as `migrate-cids`. It reads the Task Node CID inventory or repin report JSON, selects the requested CIDs, calls `ipfs-cluster-ctl pin add <cid> --wait`, verifies that the cluster status has enough allocations and pinned peers, and then verifies that the local gateway serves the same CID.

By default, `migrate-cids` does not download bytes from a public gateway and re-add them. The opt-in exact re-add path is enabled only when the operator passes `--exact-readd-gateway`. In that mode, a failed cluster pin can download `gateway/<cid>`, run exact-safe `ipfs add` candidates, and retry only if the computed CID exactly equals the original CID. If the retry leaves a stale Cluster `pin_error`, the script calls `ipfs-cluster-ctl recover <cid>` and polls until the replica gate is met or the timeout expires. Any CID mismatch is a hard failure, not a repair.

Live smoke proof on `pft-ipfs-testnet-clean` passed on June 6, 2026 at 18:43 UTC. The smoke fixture selected the canary CID `bafkreih37zbprs76fv4rj65qsdutdkp3737bx335nuu43bmlpo6suvs7pi`, ran `migrate-cids --statuses needs_repin --min-replicas 2 --limit 1`, and produced one `cluster_pinned_and_verified` result with `allocationCount: 2`, `pinnedPeerCount: 2`, and `minReplicas: 2`.

Public profile NFT verification on June 6, 2026 ran in two passes. The 19:01 UTC pass found 79 public CIDs in the live Task Node database: 70 resolved through current public gateways and 9 old profile NFT image CIDs appeared missing across the configured current and legacy gateway set. A later 20:30 UTC pass found all 79 current-resolvable. The 9 previously missing image CIDs were:

- `QmbMN5rEm6bcy9d63gf8G1c1bxeHUy4d9No8ZuBa1UsdZp`
- `QmbZ8x3krRcSzPDEUJuev9tRJPJfmZ7zJn2tqGfnybxV5w`
- `Qmd4v3uQnag5KGxTVjZUwox4kB1Y1U5WGY4TwqTCABfjc5`
- `Qme86sgKzeNEaZvHWyeLWApinsDJXcgXMuf7Si8N8FLqWj`
- `QmQJHwtX1ZT4STN3FuYL7kV17AuKYrdDHPxMu5oc5cButr`
- `QmU3wbHjpL1b31BWKJX6JeHNpjw8SuN1Tb2qNQfPjRrAgh`
- `QmU4ghfgJ6NF7zgDinfjqkVeAkHwEZUfv8Z4Mq8jKrNRz5`
- `QmVJiES4mPb3KWPX42UeRz4GQjhh7tnR62krcjDk3owW7Z`
- `QmYsuBwRuS63tPJyFxs7fSBfY6UVcdoKWH6jsmRcz3CB5z`

Recovery investigation on June 6, 2026 found no recoverable blocks for those 9 CIDs in the currently reachable old first-party sources:

- old Fly `pft-ipfs-testnet-node-1` `iad` machine `2863652a75dee8`: every CID returned `block=missing`, `pin=not_pinned`, and gateway timeout;
- old Fly `pft-ipfs-testnet-node-1` `nrt` machine `48ed666a93d0e8`: every CID returned `block=missing`, `pin=not_pinned`, and gateway timeout;
- old Fly `pft-ipfs-testnet-node-1` `ams` machine `683d921fe91938`: Kubo returned Badger `CHECKSUM_MISMAT...` errors and the local gateway port was down;
- local `/home/pfrpc/ipfs_data` blockstore: every CID returned `block was not found locally`;
- PFTasks/historical repo search: no exact-CID hit beyond inventory or cached packet references.

That old-source result was not the final state. The later inventory proved the 9 CIDs were recoverable from current public gateways. They were exact-readded into the clean cluster by 20:39 UTC. Eight succeeded in the first image-CID migration batch. The remaining CID, `QmQJHwtX1ZT4STN3FuYL7kV17AuKYrdDHPxMu5oc5cButr`, succeeded on targeted rerun with `allocationCount: 2`, `pinnedPeerCount: 2`, and `minReplicas: 2`. Do not substitute newly generated images under old CIDs; recover the exact CID or show the unavailable state.

The clean cluster migration of the full public profile NFT set is now proven. On June 6, 2026 at 19:43 UTC, the initial batch result file on `pft-ipfs-testnet-clean` showed 69 CIDs verified in the main run and one replica-gate failure for `QmRyije3PFLkzhU9Vgfv9bW4WuvcVhhkYQpdmYTER7A1Dh`. A targeted rerun of that CID succeeded with `allocationCount: 2`, `pinnedPeerCount: 2`, and `minReplicas: 2`. The later 9 recovered image CIDs were also pinned and verified at two replicas. A final independent clean-gateway pass over the full 79-CID profile NFT set returned HTTP `200` for all 79 CIDs.

The batch proved both direct cluster pinning and the exact re-add fallback. Five successful rows used `exact_readd_matched...` detail, meaning the HTTP bytes were accepted only after `ipfs add` recomputed the original CID. Direct Kubo diagnosis for `QmQZm4n4Ad7rJkGnaXMHuqwDSRRVbnqeM44JFJH6WALm6c` had previously returned `context canceled` on `ipfs pin add`, while public gateways could still serve the bytes. The exact re-add path exists for that failure class.

That distinction matters. HTTP gateway resolvability is not the same thing as first-party cluster pinnability. CIDs that resolve only through an HTTP gateway but cannot be fetched by Kubo through IPFS provider discovery need CAR/block transfer or a carefully verified byte re-add that proves the resulting CID is identical before it can count as exact-CID recovery.

Active replay-window verification initially found three recent context CIDs that public gateways could serve but the clean cluster could not. On June 6, 2026 at 20:22 UTC, these CIDs were migrated through the same exact re-add path:

- `QmQs3oLTYQ1vTkxjPe3Qw2u26htufbmNYYug9eJVbR7crW`
- `QmVsaw5egxFLebJc7FGWuxekMb5HZdATAdhokiT3ass6yk`
- `QmetorR8tdDn7Lb6PHT7nmouCEZKMwY9BHVKYPijqvre9J`

Each row returned `cluster_pinned_and_verified` with `allocationCount: 2`, `pinnedPeerCount: 2`, and `minReplicas: 2`. A rerun of `ipfs-active-replay-window` immediately afterward selected 32 recent active replay CIDs and returned `ok: true`, `okCount: 32`, and `failureCount: 0`.

Run it inside a fresh first-party IPFS machine after copying the inventory file onto that machine:

```bash
migrate-cids \
  --source-json /data/tasknode-ipfs-cid-inventory-verify.json \
  --statuses needs_repin,legacy_only \
  --only-exact-required \
  --limit 250 \
  --results-file /data/tasknode-ipfs-migration-results.jsonl
```

For CIDs that are HTTP-resolvable but fail Kubo provider discovery, use the exact re-add fallback:

```bash
migrate-cids \
  --source-json /data/tasknode-ipfs-public-current-resolvable-migrate.json \
  --results-file /data/tasknode-public-current-resolvable-migrate-results.jsonl \
  --statuses current_resolvable \
  --min-replicas 2 \
  --batch-size 10 \
  --pin-timeout-seconds 25 \
  --verify-timeout-seconds 20 \
  --readd-timeout-seconds 180 \
  --readd-add-timeout-seconds 180 \
  --max-readd-bytes 33554432 \
  --exact-readd-gateway https://ipfs.io/ipfs/ \
  --exact-readd-gateway https://dweb.link/ipfs/
```

Use `--dry-run` first. Use `--min-replicas 1` only for disposable single-node image tests. Fresh Fly infrastructure must use the production default, which is currently the two-replica gate from `IPFS_CLUSTER_REPLICATION_MIN=2`.

### Phase 5: Recover Legacy-Only Blocks

For CIDs that only the old Fly/PFTasks node can serve, use block-level migration.

Acceptable repair paths:

- CAR export/import preserving the same root CID.
- IPFS block transfer from old node to new node.
- Cluster pin from a node that can actually provide the blocks.

Unacceptable repair path:

- download bytes, upload normally, get a different CID, and silently render that new CID for an old minted NFT.

### Phase 6: Verify The Full Set

Run a full verify pass after migration:

- every required profile NFT metadata CID resolves;
- every required profile NFT image CID resolves;
- every imported thumbnail CID either resolves or has a documented non-rendering exception;
- task/context/reward CIDs in the active replay window resolve through current JSON gateways;
- profile image proxy returns valid image content for sampled accounts;
- old gateway is not needed for successful verification.

The profile NFT public set is green: all 79 public profile NFT metadata, thumbnail, and image CIDs resolve through the clean first-party gateway. The active task/context/reward replay window passed current-gateway verification after the three context CIDs above were migrated into the clean cluster.

### Phase 7: Switch App Config

Task Node config should remain:

- current first-party gateway is ahead of public fallback gateways;
- old Fly/PFTasks gateway is absent from default app reads;
- profile image proxy uses current gateway, then public fallbacks;
- reducer JSON fetch order does not include stale gateways ahead of current infrastructure;
- docs and operator runbooks name the active gateway and pinning backend.

The old gateways should only be passed explicitly to inventory or recovery tools when an operator is trying to prove or recover legacy blocks.

## Operational Commands

Current clean first-party IPFS app status:

```bash
fly status -a pft-ipfs-testnet-clean
fly checks list -a pft-ipfs-testnet-clean
fly machines list -a pft-ipfs-testnet-clean
fly ips list -a pft-ipfs-testnet-clean
fly volumes list -a pft-ipfs-testnet-clean
fly logs -a pft-ipfs-testnet-clean --no-tail
```

Public health check for the clean app:

```bash
curl -fsS https://pft-ipfs-testnet-clean.fly.dev/health | jq \
  '{ok, checks: [.checks[] | {name, ok, peerCount, allocationCount, pinnedPeerCount}]}'
```

Expected output is `ok: true`, with `cluster_peers.peerCount` equal to `2`, `cluster_canary.allocationCount` equal to `2`, and `cluster_canary.pinnedPeerCount` equal to `2`.

Public canary gateway check:

```bash
curl -fsS \
  https://pft-ipfs-testnet-clean.fly.dev/ipfs/bafkreih37zbprs76fv4rj65qsdutdkp3737bx335nuu43bmlpo6suvs7pi
```

Expected output:

```text
postfiat-ipfs-health-v1
```

Inside-machine clean cluster check:

```bash
fly ssh console -a pft-ipfs-testnet-clean --machine 2879095b4dd968 \
  -C "sh -lc 'curl -fsS http://127.0.0.1/health | jq . && ipfs-cluster-ctl --host /ip4/127.0.0.1/tcp/9094 peers ls'"
```

Live clean exact-CID migration smoke:

```bash
fly ssh console -a pft-ipfs-testnet-clean --machine 2879095b4dd968 \
  -C "sh -lc 'printf %s eyJyZXN1bHRzIjpbeyJjaWQiOiJiYWZrcmVpaDM3emJwcnM3NmZ2NHJqNjVxc2R1dGRrcDM3MzdieDMzNW51dTQzYm1scG82c3V2czdwaSIsInN0YXR1cyI6Im5lZWRzX3JlcGluIiwicGF5bG9hZENsYXNzZXMiOlsiaGVhbHRoX2NhbmFyeSJdLCJleGFjdENpZFJlcXVpcmVkIjp0cnVlfV19Cg== | base64 -d > /tmp/migration-smoke.json; rm -f /tmp/migration-smoke.jsonl; migrate-cids --source-json /tmp/migration-smoke.json --results-file /tmp/migration-smoke.jsonl --statuses needs_repin --min-replicas 2 --limit 1; cat /tmp/migration-smoke.jsonl'"
```

Expected output includes one `cluster_pinned_and_verified` row with `allocationCount: 2`, `pinnedPeerCount: 2`, and `minReplicas: 2`.

Current public-CID verification from the live Task Node database:

```bash
set -a; source .env.tasknodeofficial-fly-dev-data; set +a
npm run ipfs-cid-inventory -- \
  --source current-db \
  --output /tmp/tasknode-ipfs-cid-inventory-20260606.json

jq '{ok: true, generatedAt: now | todateiso8601, source: "current-db-public-cids", inventory: [.inventory[] | select(.public == true)]}' \
  /tmp/tasknode-ipfs-cid-inventory-20260606.json \
  > /tmp/tasknode-ipfs-public-cid-inventory-20260606.json

npm run ipfs-cid-inventory -- \
  --source-json /tmp/tasknode-ipfs-public-cid-inventory-20260606.json \
  --verify-gateways \
  --timeout-ms 8000 \
  --concurrency 8 \
  --output /tmp/tasknode-ipfs-public-cid-inventory-verify-20260606.json
```

Expected current result from June 6, 2026 at 20:30 UTC is `79 current_resolvable` and `0 missing_from_all_gateways` for the public profile NFT set.

Current-resolvable public-CID cluster migration evidence:

```bash
jq '{results: [.inventory[] | select(.migrationStatus == "current_resolvable") | {cid, status: .migrationStatus, payloadClasses, exactCidRequired}]}' \
  /tmp/tasknode-ipfs-public-cid-inventory-verify-20260606.json \
  > /tmp/tasknode-ipfs-public-current-resolvable-migrate-20260606.json

# Copy that JSON to a clean IPFS machine, then run:
migrate-cids \
  --source-json /tmp/tasknode-public-migrate.json \
  --results-file /tmp/tasknode-public-migrate-results.jsonl \
  --statuses current_resolvable \
  --min-replicas 2 \
  --batch-size 10 \
  --pin-timeout-seconds 25 \
  --verify-timeout-seconds 20 \
  --readd-timeout-seconds 180 \
  --readd-add-timeout-seconds 180 \
  --max-readd-bytes 33554432 \
  --exact-readd-gateway https://ipfs.io/ipfs/ \
  --exact-readd-gateway https://dweb.link/ipfs/
```

The June 6, 2026 run used `/data/tasknode-public-current-resolvable-migrate-results-20260606.jsonl` plus a targeted rerun file for `QmRyije3PFLkzhU9Vgfv9bW4WuvcVhhkYQpdmYTER7A1Dh`. The combined outcome of that first pass was 70 unique current-resolvable public CIDs pinned and verified at two replicas. The first batch file still contains one historical `replica_gate_failed` row for `QmRyije3...`; the rerun file is the resolving evidence for that same CID. A later profile-NFT-only pass recovered and migrated the remaining 9 image CIDs, bringing the final public profile NFT result to 79 clean-gateway-resolvable CIDs.

Independent clean-gateway verification:

```bash
jq -r '.results[].cid' /tmp/tasknode-ipfs-public-current-resolvable-migrate-20260606.json |
  xargs -I{} -P8 sh -c \
    'code=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 15 "https://pft-ipfs-testnet-clean.fly.dev/ipfs/{}"); printf "%s %s\n" "$code" "{}"' \
  > /tmp/tasknode-clean-gateway-70-verify-20260606.txt

awk '{counts[$1]++} END {for (code in counts) print code, counts[code]}' \
  /tmp/tasknode-clean-gateway-70-verify-20260606.txt
```

Final profile-NFT clean-gateway verification:

```bash
set -a; source .env.tasknodeofficial-fly-dev-data; set +a
npm run ipfs-cid-inventory -- \
  --source current-db \
  --include profile-nfts \
  --verify-gateways \
  --timeout-ms 8000 \
  --concurrency 8 \
  --output /tmp/tasknode-profile-nft-cids-final-20260606.json

jq -r '.inventory[].cid' /tmp/tasknode-profile-nft-cids-final-20260606.json |
  xargs -I{} -P8 sh -c \
    'code=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 15 "https://pft-ipfs-testnet-clean.fly.dev/ipfs/{}"); printf "%s %s\n" "$code" "{}"' \
  > /tmp/tasknode-clean-gateway-profile-nft-79-final-20260606.txt

awk '{counts[$1]++} END {for (code in counts) print code, counts[code]}' \
  /tmp/tasknode-clean-gateway-profile-nft-79-final-20260606.txt
```

Expected current result: `200 79`.

Historical missing-image source scan:

```bash
printf '%s\n' \
  QmbMN5rEm6bcy9d63gf8G1c1bxeHUy4d9No8ZuBa1UsdZp \
  QmbZ8x3krRcSzPDEUJuev9tRJPJfmZ7zJn2tqGfnybxV5w \
  Qmd4v3uQnag5KGxTVjZUwox4kB1Y1U5WGY4TwqTCABfjc5 \
  Qme86sgKzeNEaZvHWyeLWApinsDJXcgXMuf7Si8N8FLqWj \
  QmQJHwtX1ZT4STN3FuYL7kV17AuKYrdDHPxMu5oc5cButr \
  QmU3wbHjpL1b31BWKJX6JeHNpjw8SuN1Tb2qNQfPjRrAgh \
  QmU4ghfgJ6NF7zgDinfjqkVeAkHwEZUfv8Z4Mq8jKrNRz5 \
  QmVJiES4mPb3KWPX42UeRz4GQjhh7tnR62krcjDk3owW7Z \
  QmYsuBwRuS63tPJyFxs7fSBfY6UVcdoKWH6jsmRcz3CB5z \
  > /tmp/tasknode-missing-public-image-cids-20260606.txt

# Run on each old pft-ipfs-testnet-node-1 machine.
while read -r cid; do
  block=missing
  timeout 8 ipfs block stat "$cid" >/tmp/block.out 2>/tmp/block.err && block=present
  pin=not_pinned
  timeout 8 ipfs pin ls --type recursive "$cid" >/tmp/pin.out 2>/tmp/pin.err && pin=pinned
  gateway=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 8 "http://127.0.0.1:8080/ipfs/$cid" || true)
  printf "%s block=%s pin=%s gateway=%s\n" "$cid" "$block" "$pin" "$gateway"
done < /tmp/tasknode-missing-public-image-cids-20260606.txt

# Local blockstore check on the production RPC box.
while read -r cid; do
  IPFS_PATH=/home/pfrpc/ipfs_data timeout 8 ipfs block stat "$cid"
done < /tmp/tasknode-missing-public-image-cids-20260606.txt
```

Current Fly IPFS app status:

```bash
fly status -a pft-ipfs-testnet-node-1
fly checks list -a pft-ipfs-testnet-node-1
fly machines list -a pft-ipfs-testnet-node-1
fly volumes list -a pft-ipfs-testnet-node-1
fly logs -a pft-ipfs-testnet-node-1 --no-tail
```

Direct gateway check:

```bash
curl -sS -I --max-time 10 \
  https://pft-ipfs-testnet-node-1.fly.dev/ipfs/<cid>
```

Inside-machine Kubo check:

```bash
fly ssh console -a pft-ipfs-testnet-node-1 --machine <machine-id> \
  -C "sh -lc 'curl -sS -m 5 -X POST http://127.0.0.1:5001/api/v0/version && df -h /data'"
```

Local pin status check from Task Node:

```bash
npm run context-ipfs-gateway-smoke
```

Current Task Node CID inventory, without network gateway checks:

```bash
set -a; source .env.tasknodeofficial-fly-dev-data; set +a
npm run ipfs-cid-inventory -- \
  --source current-db \
  --output /tmp/tasknode-ipfs-cid-inventory.json
```

Bounded gateway verification for the first 250 CIDs:

```bash
set -a; source .env.tasknodeofficial-fly-dev-data; set +a
npm run ipfs-cid-inventory -- \
  --source current-db \
  --verify-gateways \
  --timeout-ms 4000 \
  --concurrency 4 \
  --limit 250 \
  --output /tmp/tasknode-ipfs-cid-inventory-verify.json
```

Bounded gateway verification plus Pinata pin-provider status:

```bash
set -a; source .env.tasknodeofficial-fly-dev-data; set +a
npm run ipfs-cid-inventory -- \
  --source current-db \
  --verify-gateways \
  --check-pinata \
  --timeout-ms 4000 \
  --concurrency 2 \
  --limit 50 \
  --output /tmp/tasknode-ipfs-cid-inventory-pinata.json
```

Active replay-window verification for task, submission, reward, and context JSON:

```bash
set -a; source .env.tasknodeofficial-fly-dev-data; set +a
npm run ipfs-active-replay-window -- \
  --lookback-days 14 \
  --per-class 8 \
  --max-cids 40 \
  --timeout-ms 8000 \
  --concurrency 8 \
  --output /tmp/tasknode-active-replay-window.json
```

Expected current result from June 6, 2026 is `ok: true`, `selectedCids: 32`, `okCount: 32`, and `failureCount: 0`. This verifier uses current gateways only. A failure means the selected active replay CID is not proven independent of old Fly/PFTasks gateways.

Standalone PFTasks or wallet NFT export scan:

```bash
npm run ipfs-cid-inventory -- \
  --source-json /tmp/pftasks-nft-mints-all.json \
  --verify-gateways \
  --output /tmp/pftasks-ipfs-cid-inventory-verify.json
```

The report's `inventory[]` rows include CID, payload classes, source tables, public/encrypted flags, exact-CID requirement, sample refs, first resolving gateway, content type, byte size, current pin-provider status, and migration status. When `--output` is present, stdout defaults to a compact summary and the full row set is written to the output path. Use `--stdout full` only when full terminal output is intentional.

Gateway canary check for a specific gateway and known CID:

```bash
npm run ipfs-gateway-health -- \
  --gateway https://pft-ipfs-testnet-node-1.fly.dev/ipfs/ \
  --cid <known-current-cid> \
  --timeout-ms 5000 \
  --output /tmp/pft-ipfs-gateway-health.json
```

This command exits nonzero if any canary CID fails. It is the operator-side implementation of the "no silent gateway rot" boundary: a gateway is not healthy merely because nginx, Fly, or Kubo process checks pass.

Local clean-image verification in the `ipfs-infra` repo:

```bash
cd /home/pfrpc/repos/ipfs-infra
bash -n docker/entrypoint.sh
python3 -m py_compile docker/health_server.py
fly config validate -c fly/testnet/fly.toml
fly config validate -c fly/devnet/fly.toml
fly config validate -c fly/prod/fly.toml
docker build -f docker/Dockerfile -t postfiat-ipfs-infra:rebuild-check .
```

A single local container can prove the image, Kubo, nginx, health server, local gateway, and cluster pin path. It cannot prove the production two-replica policy, so run it with explicit one-replica health settings:

```bash
docker rm -f ipfs-infra-rebuild-check >/dev/null 2>&1 || true
CLUSTER_SECRET=$(openssl rand -hex 32)
docker run -d --name ipfs-infra-rebuild-check -p 18080:80 \
  -e CLUSTER_SECRET="$CLUSTER_SECRET" \
  -e IPFS_API_USER=admin \
  -e IPFS_API_PASS=test \
  -e IPFS_HEALTH_MIN_FREE_BYTES=1 \
  -e IPFS_CLUSTER_REPLICATION_MIN=1 \
  -e IPFS_CLUSTER_REPLICATION_MAX=1 \
  -e IPFS_HEALTH_MIN_CLUSTER_PEERS=1 \
  -e IPFS_HEALTH_MIN_CANARY_REPLICAS=1 \
  postfiat-ipfs-infra:rebuild-check

curl -fsS http://127.0.0.1:18080/health
docker rm -f ipfs-infra-rebuild-check
```

Expected health output is JSON with `ok: true` and passing checks named `kubo_api`, `disk`, `cluster_peers`, `gateway_canary`, and `cluster_canary`. A static `healthy` string is no longer sufficient evidence.

A default one-container run with the production defaults should fail health because `IPFS_CLUSTER_REPLICATION_MIN=2` cannot be satisfied by one local peer:

```bash
docker rm -f ipfs-infra-rebuild-default-check >/dev/null 2>&1 || true
CLUSTER_SECRET=$(openssl rand -hex 32)
docker run -d --name ipfs-infra-rebuild-default-check -p 18081:80 \
  -e CLUSTER_SECRET="$CLUSTER_SECRET" \
  -e IPFS_API_USER=admin \
  -e IPFS_API_PASS=test \
  -e IPFS_HEALTH_MIN_FREE_BYTES=1 \
  postfiat-ipfs-infra:rebuild-check

curl -sS http://127.0.0.1:18081/health
docker rm -f ipfs-infra-rebuild-default-check
```

Expected output for the default one-container run is `ok: false`, with `cluster_peers` and/or `cluster_canary` failing the minimum count. Production/fresh-Fly verification must pass the default two-replica gate on fresh volumes before the gateway becomes a first-choice Task Node dependency.

First-party cluster exact-CID migration smoke in the `ipfs-infra` repo:

```bash
docker rm -f ipfs-infra-migrate-check >/dev/null 2>&1 || true
CLUSTER_SECRET=$(openssl rand -hex 32)
docker run -d --name ipfs-infra-migrate-check -p 18082:80 \
  -e CLUSTER_SECRET="$CLUSTER_SECRET" \
  -e IPFS_API_USER=admin \
  -e IPFS_API_PASS=test \
  -e IPFS_HEALTH_MIN_FREE_BYTES=1 \
  -e IPFS_CLUSTER_REPLICATION_MIN=1 \
  -e IPFS_CLUSTER_REPLICATION_MAX=1 \
  -e IPFS_HEALTH_MIN_CLUSTER_PEERS=1 \
  -e IPFS_HEALTH_MIN_CANARY_REPLICAS=1 \
  postfiat-ipfs-infra:rebuild-check

curl -fsS http://127.0.0.1:18082/health \
  > /tmp/ipfs-infra-migrate-health.json
CID=$(node -e "const r=require('/tmp/ipfs-infra-migrate-health.json'); console.log(r.canaryCids[0])")

docker exec ipfs-infra-migrate-check sh -lc \
  "printf '%s\n' '{\"inventory\":[{\"cid\":\"$CID\",\"migrationStatus\":\"needs_repin\",\"payloadClasses\":[\"profile_nft_image\"],\"exactCidRequired\":true}]}' > /tmp/migrate-fixture.json && \
   migrate-cids --source-json /tmp/migrate-fixture.json --statuses needs_repin --only-exact-required --limit 1 --min-replicas 1 --results-file /tmp/migrate-results.jsonl"

docker rm -f ipfs-infra-migrate-check
```

Expected result is one `cluster_pinned_and_verified` JSONL row with `allocationCount: 1` and `pinnedPeerCount: 1`. On fresh production-style Fly infrastructure, the same command should satisfy `minReplicas: 2`.

Legacy NFT CID repair:

```bash
npm run --silent profile-nft-cid-repin -- \
  --source-json /tmp/pftasks-nft-mints-all.json \
  --dry-run

npm run --silent profile-nft-cid-repin -- \
  --source-json /tmp/pftasks-nft-mints-all.json \
  --execute \
  --limit 250 \
  --offset 0 \
  --no-verify-after

npm run --silent profile-nft-cid-repin -- \
  --source-json /tmp/pftasks-nft-mints-all.json \
  --verify-only
```

## Verified Acceptance Criteria

The rebuild is done for the current Task Node dev deployment because all of these are true:

- New task evidence CIDs can be fetched through current gateways without relying on old Fly.
- Context history CIDs in the active support window can be fetched through current gateways.
- Every minted profile NFT metadata and image CID either resolves through current infrastructure or has a documented exception.
- The profile NFT gallery renders through `/api/profile/nft/image/:cid` without browser gateway fanout.
- A canary CID health check fails the gateway when content is unavailable, even if nginx and Kubo processes are up.
- The current IPFS deployment has replication greater than `1` for production-required content.
- Operators can inspect peers, pins, disk, and canary status without reverse-engineering the container.
- Old PFTasks/Fly gateways are absent from default app reads and remain available only to explicit recovery tooling until full verification or exceptions are complete.

## Open Decisions

These decisions should be made before the rebuild becomes production-critical:

- whether Pinata remains the primary pinning backend, backup backend, or only a migration helper;
- whether first-party IPFS lives on Fly only or includes a non-Fly node for provider diversity;
- whether to put the public gateway behind a PostFiat-controlled domain;
- which Kubo version and datastore backend to standardize on;
- what the retention policy is for encrypted historical task/context payloads;
- whether immutable NFT assets get stronger replication than encrypted task/event JSON.

## Related Pages

- [IPFS Standards](#docs/ipfs)
- [Profile](#docs/profile)
- [PFTasks Cutover](#docs/pftasks-cutover)
- [PFTL Usage](#docs/pftl)
- [Task Generation](#docs/task-generation)
- [Deployment](#docs/deployment)
