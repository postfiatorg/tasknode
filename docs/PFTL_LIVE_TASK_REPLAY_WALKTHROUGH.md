# PFTL Live Task Replay Walkthrough

This document is the plain-English walkthrough of the successful OpenAI-backed
live reference run:

```text
reference_clients/python/runs/live_openai_20260516T184718Z/receipt_public.json
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
Run ID: live_openai_20260516T184718Z
Task ID: task_e7f4ee392de6ad6d5c5587864ddd6738
Final replay state: rewarded
```

## OpenAI Task Generation

This run used the working OpenAI project key from `env_dump.txt`, ending
`NSgA`, without printing or committing the key.

```text
Model: chat-latest
OpenAI response ID: chatcmpl-DgEKwnG6o1k3x5r5F17vBdpOQfeZ8
Parse status: ok
Taskgen latency: 6091 ms
Prompt version: taskgen-minimal-v1
```

The harness now fails closed if OpenAI task generation is missing or invalid.
The deterministic fallback is available only when the operator explicitly
passes `--allow-taskgen-fallback`.

## Actors

```text
User wallet:
rKeq2crCjxToxChtNX9L8gVUYdRDhjn5Ca

Task Node authority wallet:
rhxCXgJiS5A61Yz1uEvZLRN3HY1zZpAc6v

Allocation / reward wallet:
rL8AVz8ZrUyuh9VKhjdJN9MaxFnZrk1FcS
```

## Balance Movement

All three wallets were freshly funded for the run.

```text
Before:
User: 25.000000 PFT
Task Node authority: 25.000000 PFT
Allocation / reward: 25.000000 PFT

After:
User: 29.499958 PFT
Task Node authority: 24.999982 PFT
Allocation / reward: 20.499990 PFT
```

The user received a 4.50 PFT reward. The remaining differences are network
fees and the 1-drop pointer payments used to anchor lifecycle events.

## Payload CIDs

The lifecycle uses encrypted IPFS payloads. PFTL transactions point at those
payloads using `pf.ptr/v4` memo pointers.

```text
Context document:
QmRxK7sG53vuuZ6ZUfKJa3hdpwPp3SzMQnxmShad1XDze9

Portable task request bundle:
QmYUx1ck1twEzzWURqvpeN6TrKHQQaKStYpfySVJrQLPow

Request event:
QmV8sbB4DiQFSYfeR6x4E4zu4p4ix1RioTfvunryswovL6

Offer:
QmVfx53KWRwG9fuwNMTMNZNSprcJ6q4emjgmsLzd7b57Mn

Accepted:
QmVH9wuYxbEVY1QjgYK7RiLR8vQ8FeGzDYJasdUuDpWfvt

Initial evidence:
Qmd2cUgcyBGtzuH4T1rvaXFwSyKWNGpoKfAquc3XPHDG2A

Initial submission:
QmYBh4R1CKwdmUCv8pgsmuwEtHvb99KGhNwZtPLuPoj7WB

Verification request:
QmWWNvYHFdbr8YbGbE6W1eKwyM13DChAC5SG54NfRRhMco

Verification evidence:
QmTh2CD9SccJriuxVFSzuHVYMq2UQ37T4kuUsRgkAtiyER

Verification response:
QmSPmxjpAwQA8ZxkM14vPaK2b3uKPYvqoxrcWhxDftcsmC

Reward:
QmVYtGNKTzcJvrrbBtCANgBkTUCnXsK1ByB8LxHF2nS1Bx
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

OpenAI-generated task offer:

```text
Title:
Validate replayable PFTL Task Node lifecycle with encrypted evidence

Description:
Create and run a minimal Python harness that simulates a full PFTL Task Node
lifecycle using pf.ptr/v4 pointer events and encrypted IPFS payload references
as canonical state. Demonstrate replayability by reconstructing task state from
the event stream without using a database. Submit the harness source and a
short execution log showing lifecycle replay and evidence validation.

Task kind:
system

Reward offer:
4.50 PFT
```

Submission requirement:

```text
Type:
mixed

Criteria:
Provide a GitHub repository URL or file archive containing the Python harness,
plus a text log or screenshot demonstrating successful lifecycle replay from
pointer events and encrypted evidence references.
```

Verification policy:

```text
Mode:
manual

Verification type:
artifact_review

Follow-up required:
false
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
802BCB94082186BBFA8BB7B7C515F4E1930D3E74509B567D38FAB9A2FE1CB95E

Task Node authority funding tx:
AA8FEA6EB4A7089855B2FB7125312A5BC029C2F48BAF8A19DB46D299A0C254C0

Allocation / reward funding tx:
646F15A58C7B9AD7A66E7E43EF05DA2C3DA01730726BE449D2F2F2D97502503D
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
QmRxK7sG53vuuZ6ZUfKJa3hdpwPp3SzMQnxmShad1XDze9

Request bundle CID:
QmYUx1ck1twEzzWURqvpeN6TrKHQQaKStYpfySVJrQLPow
```

## Step 2: User Requests A Task

The user wallet sent a 1-drop PFTL payment to the Task Node authority wallet.
The payment carried a `pf.ptr/v4` memo pointing at the encrypted task request
event.

```text
Schema: pf.task.request.v1
Sender: rKeq2crCjxToxChtNX9L8gVUYdRDhjn5Ca
Destination: rhxCXgJiS5A61Yz1uEvZLRN3HY1zZpAc6v
Pointer CID: QmV8sbB4DiQFSYfeR6x4E4zu4p4ix1RioTfvunryswovL6
Ledger index: 2845137
Transaction hash: 3BE603040BACDBF95C4B04E1E5D0B4F658A4AC6F4137ED36A378D0A1FADA3184
```

Human interpretation: the user asked Task Node to generate or issue a task
against the encrypted request bundle.

## Step 3: Task Node Offers A Task

The Task Node authority wallet sent a 1-drop PFTL payment back to the user.
The pointer payload contained the OpenAI-generated proposed task, reward offer,
and task ID.

```text
Schema: pf.task.offer.v1
Task ID: task_e7f4ee392de6ad6d5c5587864ddd6738
Sender: rhxCXgJiS5A61Yz1uEvZLRN3HY1zZpAc6v
Destination: rKeq2crCjxToxChtNX9L8gVUYdRDhjn5Ca
Pointer CID: QmVfx53KWRwG9fuwNMTMNZNSprcJ6q4emjgmsLzd7b57Mn
Ledger index: 2845140
Transaction hash: 1B6AFEF2B4339AB2E4FCBCCF43AE5DCFB015DB8CDDF4C862098776D8114E3C3B
```

Human interpretation: Task Node proposed a task to the user. At this point the
task is not yet on the user's plate; it is only proposed.

## Step 4: User Accepts The Task

The user wallet sent a 1-drop PFTL payment to the Task Node authority wallet.
The pointer payload recorded an accepted state update.

```text
Schema: pf.task.update.v1
State: accepted
Sender: rKeq2crCjxToxChtNX9L8gVUYdRDhjn5Ca
Destination: rhxCXgJiS5A61Yz1uEvZLRN3HY1zZpAc6v
Pointer CID: QmVH9wuYxbEVY1QjgYK7RiLR8vQ8FeGzDYJasdUuDpWfvt
Ledger index: 2845142
Transaction hash: 918408A1246E4ADAF0C4C4F460EB757BB616D1E92D1398D3952FD9A944B78454
```

Human interpretation: the task moved from proposed to accepted. The task is
now on the user's plate.

## Step 5: User Submits Initial Work

The user wallet sent another 1-drop PFTL payment to the Task Node authority
wallet. The pointer payload referenced the encrypted submission and encrypted
evidence packet.

```text
Schema: pf.task.submission.v1
Sender: rKeq2crCjxToxChtNX9L8gVUYdRDhjn5Ca
Destination: rhxCXgJiS5A61Yz1uEvZLRN3HY1zZpAc6v
Submission CID: QmYBh4R1CKwdmUCv8pgsmuwEtHvb99KGhNwZtPLuPoj7WB
Evidence CID: Qmd2cUgcyBGtzuH4T1rvaXFwSyKWNGpoKfAquc3XPHDG2A
Ledger index: 2845144
Transaction hash: 38B55812AA7BBDDB154A50C190998CC6ADC716987F8C5D236622B04496230CA9
```

Human interpretation: the user submitted work for review. The canonical chain
event does not need the UI to exist; any wallet-capable agent can create this
same submission.

## Step 6: Task Node Requests Verification

The Task Node authority wallet sent a 1-drop PFTL payment back to the user.
The pointer payload requested follow-up verification.

```text
Schema: pf.task.update.v1
State: verification_requested
Sender: rhxCXgJiS5A61Yz1uEvZLRN3HY1zZpAc6v
Destination: rKeq2crCjxToxChtNX9L8gVUYdRDhjn5Ca
Pointer CID: QmWWNvYHFdbr8YbGbE6W1eKwyM13DChAC5SG54NfRRhMco
Ledger index: 2845146
Transaction hash: 80D495EE5D62D6A3C22F21B56352CCD49E55FC53D488CE0318179F22E9B2E355
```

Human interpretation: Task Node processed the submission and asked for a
specific evidence packet before reward.

## Step 7: User Submits Verification Evidence

The user wallet sent a 1-drop PFTL payment to the Task Node authority wallet.
The pointer payload referenced the encrypted verification response and
verification evidence packet.

```text
Schema: pf.task.verification_response.v1
Sender: rKeq2crCjxToxChtNX9L8gVUYdRDhjn5Ca
Destination: rhxCXgJiS5A61Yz1uEvZLRN3HY1zZpAc6v
Verification response CID: QmSPmxjpAwQA8ZxkM14vPaK2b3uKPYvqoxrcWhxDftcsmC
Verification evidence CID: QmTh2CD9SccJriuxVFSzuHVYMq2UQ37T4kuUsRgkAtiyER
Ledger index: 2845148
Transaction hash: 85A31AA42038B75FD3DBAD67AC73645E9D2255399E349576498319AAA1B2D5CA
```

Human interpretation: the user answered the verification request with the
required evidence packet.

## Step 8: Reward Wallet Pays The User

The allocation / reward wallet sent the actual reward payment to the user. The
payment carried a reward pointer payload so the reward can be replayed back
into canonical task state.

```text
Schema: pf.reward.v1
Sender: rL8AVz8ZrUyuh9VKhjdJN9MaxFnZrk1FcS
Destination: rKeq2crCjxToxChtNX9L8gVUYdRDhjn5Ca
Reward amount: 4.50 PFT
Reward drops: 4500000
Pointer CID: QmVYtGNKTzcJvrrbBtCANgBkTUCnXsK1ByB8LxHF2nS1Bx
Ledger index: 2845149
Transaction hash: 5B7A164E1392204AC5D5B7AE6B4FE5D4F85E4E35EEF29FC3BCA11671A6EDB077
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
4.50 PFT
```

Final reduced projection:

```text
Task:
Validate replayable PFTL Task Node lifecycle with encrypted evidence

Task ID:
task_e7f4ee392de6ad6d5c5587864ddd6738

Kind:
system

Status:
rewarded

Request bundle:
QmYUx1ck1twEzzWURqvpeN6TrKHQQaKStYpfySVJrQLPow

Reward offer:
4.50 PFT

Reward paid:
4.50 PFT
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
2. call OpenAI task generation with strict structured output;
3. encrypt payloads to the required recipients;
4. upload payloads to IPFS;
5. write PFTL pointer transactions in wallet nonce order;
6. scan wallet history;
7. hydrate and decrypt payloads;
8. reduce events into task state.
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
