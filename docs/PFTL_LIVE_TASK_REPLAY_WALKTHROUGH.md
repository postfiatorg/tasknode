# PFTL Live Task Replay Walkthrough

This document is the plain-English walkthrough of the successful live reference
run:

```text
reference_clients/python/runs/live_replay_20260516T182226Z/receipt_public.json
```

The private receipt for the same run contains generated test wallet seeds and
encryption private keys. It is intentionally gitignored and should not be
copied into docs, issues, screenshots, or chat.

## Network

This run used PFTL testnet. PFTL is its own Post Fiat L1. The reference client
uses `xrpl-py` only because PFTL is XRPL-compatible at the transaction/RPC
layer.

```text
Network: pftl-testnet
RPC: http://178.156.143.199:5005
Archive WSS: wss://ws-archive.testnet.postfiat.org
Run ID: live_replay_20260516T182226Z
Task ID: task_eb13467eded73c507027ab2d656b26a6
Final replay state: rewarded
```

## Actors

```text
User wallet:
rN6FwECi8cYpUc9JpHvSHGNsCmvRoWuGEW

Task Node authority wallet:
rK51qkgHhSiBANBSdZea64hLVyKm2zUajQ

Allocation / reward wallet:
rGtAH2vHQh8Bk3jmrgHbHCczabQiLMB47w
```

## Balance Movement

All three wallets were freshly funded for the run.

```text
Before:
User: 25.000000 PFT
Task Node authority: 25.000000 PFT
Allocation / reward: 25.000000 PFT

After:
User: 28.199958 PFT
Task Node authority: 24.999982 PFT
Allocation / reward: 21.799990 PFT
```

The user received a 3.20 PFT reward. The remaining differences are network
fees and the 1-drop pointer payments used to anchor lifecycle events.

## Payload CIDs

The lifecycle uses encrypted IPFS payloads. PFTL transactions point at those
payloads using `pf.ptr/v4` memo pointers.

```text
Context document:
Qmamvaz5Eak7DToXd6An2F2ew7wuBCdKbCEV4ZrK8AvhL2

Portable task request bundle:
QmXs6kBxZTUBJgyzdD5SeJSShjYVUGoHS9EQvbpGCb9EiP

Request event:
QmRz1PR4VVHjoVwZ6FF2sjJBWmAqaQnK2ukjPQoffVrS9i

Offer:
QmVAedwEHtJmfyYg2xa9T1J7mLu4D6iQaLuSattRNj4DhL

Accepted:
QmVYpZX3kEbMjR9FAuiezSTpQoYp1Uu4bqVkNaFWPZZK9f

Initial evidence:
QmdLXSFEjqwfWjYxbqMEZxvvU9LuR19TFQVNQv2eRNnuya

Initial submission:
QmXR2wWCjg1mRLjisbfgvZ9cytBxxwtHZp4QbtbL3G6bia

Verification request:
QmZTjgmAKcBEjNTBT1RkNCgfR4xVcNZy74UWKtUdfJCsZL

Verification evidence:
QmSn9ysjnbCDyfc3b2W5DFCra84eujoEuSuUJvx4E1S1to

Verification response:
QmfNVadxCN3vwbJBZDUgEhocuNt5fZ55zUf6yMZehHE2H9

Reward:
QmXJaVt3V9v2xtek7C2RQaNx2h2Shs7SQyys29NfxS6uLB
```

## Specific Task Content

This is the actual decrypted content from the live run, excluding private
wallet seeds and encryption keys.

Request context document:

```text
Build and validate a PFTL-native Task Node lifecycle. The canonical record
should be pf.ptr/v4 pointer events with encrypted IPFS payloads. The database
should be a cache only.
```

Request bundle summary:

```text
User wants a portable off-app Task Node lifecycle simulation for PFTL.
```

Recent chat packet:

```text
User:
Build an end-to-end PFTL-native task flow outside the app surface.

Assistant:
I will create a reference Python harness that writes pointer events and replays
task state.
```

Relevant history packet:

```text
Task state should be canonical from pf.ptr/v4 pointers and encrypted IPFS
payloads; databases are cache.
```

Task request text:

```text
Issue a task to validate the PFTL-native Task Node lifecycle with encrypted
evidence and replay.
```

Generated task offer:

```text
Title:
Replay the PFTL task lifecycle

Description:
Run the reference Task Node harness end to end, confirm every lifecycle pointer
is written to PFTL, and provide the replay projection showing the task reaches
rewarded state.

Task kind:
system

Reward offer:
3.20 PFT
```

Submission requirement:

```text
Type:
text

Criteria:
Submit a concise evidence packet with the run id, pointer transaction hashes,
IPFS CIDs, and final replay status.
```

Verification policy:

```text
Mode:
standard_followup

Verification type:
text

Follow-up required:
true
```

Verification ask:

```text
Confirm the run completed end to end. Include the request, offer, acceptance,
submission, verification response, and reward transaction hashes, plus the
replayed final status.
```

Initial user evidence:

```text
The PFTL-native lifecycle harness was run through request, offer, accept, and
initial submission.
```

Verification evidence:

```text
Confirmed. The run produced PFTL pointer transactions for request, offer,
acceptance, initial submission, verification request, verification response,
and reward.
```

Verification response text:

```text
Confirmed lifecycle run and pointer set.
```

Reward summary:

```text
Reference lifecycle simulation completed and replayed.
```

## Preflight: Wallet Funding

The harness created three fresh PFTL wallets and funded each to 25 PFT from the
configured faucet wallet.

```text
User funding tx:
EC3960C5170583231858BD996DB42E21A7C52A0AD984001719C3F14709433C5C

Task Node authority funding tx:
F8BC83CB684A08CF9ACA2D0D2894F46C404C6B805C5059221AB78096E602C66B

Allocation / reward funding tx:
518F45BE788A26277C3BD0A278907BEE7CAED5790DA912DFE0E81E8B02948034
```

## Step 1: Build The Request Inputs

The harness created a portable request bundle from simulated user material:

```text
Recent chat
Relevant chat history
Context document CID
Wallet and policy metadata
```

The context document and request bundle were encrypted and uploaded to IPFS.
The request bundle CID became the portable input packet for the task lifecycle.

```text
Context document CID:
Qmamvaz5Eak7DToXd6An2F2ew7wuBCdKbCEV4ZrK8AvhL2

Request bundle CID:
QmXs6kBxZTUBJgyzdD5SeJSShjYVUGoHS9EQvbpGCb9EiP
```

Task generation attempted the configured OpenAI path, but the API key was not
accepted in this environment. The harness therefore used its deterministic
fallback task generator. That is acceptable for the protocol replay because
the point of this run was the PFTL/IPFS lifecycle, not model quality.

```text
Task title:
Replay the PFTL task lifecycle

Task description:
Run the reference Task Node harness end to end, confirm every lifecycle pointer
is written to PFTL, and provide the replay projection showing the task reaches
rewarded state.

Offered reward:
3.20 PFT
```

## Step 2: User Requests A Task

The user wallet sent a 1-drop PFTL payment to the Task Node authority wallet.
The payment carried a `pf.ptr/v4` memo pointing at the encrypted task request
event.

```text
Schema:
pf.task.request.v1

Sender:
rN6FwECi8cYpUc9JpHvSHGNsCmvRoWuGEW

Destination:
rK51qkgHhSiBANBSdZea64hLVyKm2zUajQ

Pointer CID:
QmRz1PR4VVHjoVwZ6FF2sjJBWmAqaQnK2ukjPQoffVrS9i

Ledger index:
2844644

Transaction hash:
8071DABD1CDD76E437583792DB69F77831CEFCEDA80F94FDAFEF8725F7ED5BCF
```

Human interpretation: the user asked Task Node to generate or issue a task
against the encrypted request bundle.

## Step 3: Task Node Offers A Task

The Task Node authority wallet sent a 1-drop PFTL payment back to the user.
The pointer payload contained the proposed task, reward offer, and task ID.

```text
Schema:
pf.task.offer.v1

Task ID:
task_eb13467eded73c507027ab2d656b26a6

Sender:
rK51qkgHhSiBANBSdZea64hLVyKm2zUajQ

Destination:
rN6FwECi8cYpUc9JpHvSHGNsCmvRoWuGEW

Pointer CID:
QmVAedwEHtJmfyYg2xa9T1J7mLu4D6iQaLuSattRNj4DhL

Ledger index:
2844646

Transaction hash:
DB06819FB3A33E267601B953306C798A3BA0274BBB3F94F1DF6A06C5DF44B194
```

Human interpretation: Task Node proposed a task to the user. At this point the
task is not yet on the user's plate; it is only proposed.

## Step 4: User Accepts The Task

The user wallet sent a 1-drop PFTL payment to the Task Node authority wallet.
The pointer payload recorded an accepted state update.

```text
Schema:
pf.task.update.v1

State:
accepted

Sender:
rN6FwECi8cYpUc9JpHvSHGNsCmvRoWuGEW

Destination:
rK51qkgHhSiBANBSdZea64hLVyKm2zUajQ

Pointer CID:
QmVYpZX3kEbMjR9FAuiezSTpQoYp1Uu4bqVkNaFWPZZK9f

Ledger index:
2844648

Transaction hash:
81E4545BEEE53AD6A68982C40D28C3D99775D6E99ACC13BDB31C06D5D1A265C4
```

Human interpretation: the task moved from proposed to accepted. The task is
now on the user's plate.

## Step 5: User Submits Initial Work

The user wallet sent another 1-drop PFTL payment to the Task Node authority
wallet. The pointer payload referenced the encrypted submission and encrypted
evidence packet.

```text
Schema:
pf.task.submission.v1

Sender:
rN6FwECi8cYpUc9JpHvSHGNsCmvRoWuGEW

Destination:
rK51qkgHhSiBANBSdZea64hLVyKm2zUajQ

Submission CID:
QmXR2wWCjg1mRLjisbfgvZ9cytBxxwtHZp4QbtbL3G6bia

Evidence CID:
QmdLXSFEjqwfWjYxbqMEZxvvU9LuR19TFQVNQv2eRNnuya

Ledger index:
2844650

Transaction hash:
4974A0B8CE87978F5CCF89977FE888C6EE4A758B6375CADA8BA5E0008A66D615
```

Human interpretation: the user submitted work for review. The canonical chain
event does not need the UI to exist; any wallet-capable agent can create this
same submission.

## Step 6: Task Node Requests Verification

The Task Node authority wallet sent a 1-drop PFTL payment back to the user.
The pointer payload requested follow-up verification.

```text
Schema:
pf.task.update.v1

State:
verification_requested

Sender:
rK51qkgHhSiBANBSdZea64hLVyKm2zUajQ

Destination:
rN6FwECi8cYpUc9JpHvSHGNsCmvRoWuGEW

Pointer CID:
QmZTjgmAKcBEjNTBT1RkNCgfR4xVcNZy74UWKtUdfJCsZL

Ledger index:
2844652

Transaction hash:
887821E2E22DFE21B05B7AF0884F694C1BF9A0A2AF70A387DC6035ECB45183E9
```

Human interpretation: Task Node processed the submission and asked for a
specific evidence packet before reward.

## Step 7: User Submits Verification Evidence

The user wallet sent a 1-drop PFTL payment to the Task Node authority wallet.
The pointer payload referenced the encrypted verification response and
verification evidence packet.

```text
Schema:
pf.task.verification_response.v1

Sender:
rN6FwECi8cYpUc9JpHvSHGNsCmvRoWuGEW

Destination:
rK51qkgHhSiBANBSdZea64hLVyKm2zUajQ

Verification response CID:
QmfNVadxCN3vwbJBZDUgEhocuNt5fZ55zUf6yMZehHE2H9

Verification evidence CID:
QmSn9ysjnbCDyfc3b2W5DFCra84eujoEuSuUJvx4E1S1to

Ledger index:
2844654

Transaction hash:
5B3EB98C5B992DD13CA5EB4784F9ED382E36C71309F21C660E47975AA558D8BE
```

Human interpretation: the user answered the verification request with the
required evidence packet.

## Step 8: Reward Wallet Pays The User

The allocation / reward wallet sent the actual reward payment to the user. The
payment carried a reward pointer payload so the reward can be replayed back
into canonical task state.

```text
Schema:
pf.reward.v1

Sender:
rGtAH2vHQh8Bk3jmrgHbHCczabQiLMB47w

Destination:
rN6FwECi8cYpUc9JpHvSHGNsCmvRoWuGEW

Reward amount:
3.20 PFT

Reward drops:
3200000

Pointer CID:
QmXJaVt3V9v2xtek7C2RQaNx2h2Shs7SQyys29NfxS6uLB

Ledger index:
2844656

Transaction hash:
50A324FF81F640DA609E1546A7BE23CC1E2FEB37D9B8E612107E3E96FFE92631
```

Human interpretation: the task is paid and should reduce to `rewarded`.

## Step 9: Replay And Reduce

The harness scanned wallet history for all three participating wallets,
extracted `pf.ptr/v4` memo pointers, fetched the encrypted IPFS payloads, and
decrypted them with the Task Node recipient identity.

The scan found 14 pointer events because each two-party transaction is visible
from more than one wallet history perspective. The reducer deduplicated by
event digest and reduced the lifecycle to a single task projection.

```text
Hydrated event schemas:
pf.task.request.v1
pf.task.offer.v1
pf.task.update.v1
pf.task.submission.v1
pf.task.update.v1
pf.task.verification_response.v1
pf.reward.v1

Reduced final task state:
rewarded

Actual reward:
3.20 PFT
```

Final reduced projection:

```text
Task:
Replay the PFTL task lifecycle

Task ID:
task_eb13467eded73c507027ab2d656b26a6

Kind:
system

Status:
rewarded

Request bundle:
QmXs6kBxZTUBJgyzdD5SeJSShjYVUGoHS9EQvbpGCb9EiP

Reward offer:
3.20 PFT

Reward paid:
3.20 PFT
```

## What This Proves

This live run proves the core portability claim:

```text
Encrypted IPFS payloads + PFTL pointer transactions are sufficient to replay a
task lifecycle from request through reward.
```

The app UI is not the canonical source. A Codex agent, CLI, service worker, or
other wallet-capable client can produce the same lifecycle as long as it can:

```text
1. build the portable request bundle;
2. encrypt payloads to the required recipients;
3. upload payloads to IPFS;
4. write PFTL pointer transactions in wallet nonce order;
5. scan wallet history;
6. hydrate and decrypt payloads;
7. reduce events into task state.
```

## How To Re-run

From the repo root:

```bash
PYTHONPATH=reference_clients/python \
python3 -m tasknode_pftl.scenarios.full_lifecycle
```

The run writes:

```text
reference_clients/python/runs/<run_id>/receipt_public.json
reference_clients/python/runs/<run_id>/receipt_private.json
```

Only the public receipt is appropriate to share. The private receipt contains
generated wallet seeds and encryption private keys for the local test run.
