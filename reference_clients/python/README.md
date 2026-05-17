# Task Node PFTL Reference Client

This directory is a protocol harness for Task Node. It intentionally lives
outside the React app so task issuance, submission, verification, reward, and
replay can be exercised without waiting on UX.

PFTL is its own Post Fiat L1, not XRP. It is XRPL-compatible at the
transaction/RPC layer because PFTL is an XRPL fork, so this reference client
uses the Python `xrpl` package as a wire library. All network, balance, and
reward semantics in this harness are PFT/PFTL semantics. It must not be pointed
at XRP mainnet or XRP testnet.

## What The Full Lifecycle Scenario Does

`tasknode_pftl.scenarios.full_lifecycle` performs a live PFTL testnet run:

1. creates a user wallet, Task Node authority wallet, and allocation/reward
   wallet;
2. funds them from the configured PFTL faucet wallet;
3. builds a portable encrypted task request bundle from simulated chat,
   relevant history, and a context document;
4. uploads encrypted payloads to IPFS via Pinata;
5. writes `pf.ptr/v4` PFTL pointer transactions for request, offer, accept,
   submission, verification request, verification response, and reward;
6. replays wallet history from PFTL, fetches/decrypts IPFS payloads, and
   reduces the event stream into canonical task state.

Run artifacts are written under `reference_clients/python/runs/`, which is
gitignored because it contains generated PFTL testnet wallet seeds and
encryption private keys.

## Configuration

By default, the harness reads:

```text
/home/pfrpc/repos/pftasks/worker/.env
/home/pfrpc/repos/pftasks/api/.env
```

Required for a live run:

```text
PFTL_RPC_URL or PFTL_WSS_URL
FAUCET_SEED
PINATA_API_KEY
PINATA_API_SECRET
OPENAI_API_KEY
```

Optional:

```text
OPENAI_BASE_URL
TASKNODE_ENCRYPTION_PUBKEY
```

Task generation uses `chat-latest` by default and fails closed if OpenAI auth or
model execution fails. For local protocol-only smoke tests, pass
`--allow-taskgen-fallback` to use the deterministic fallback generator
explicitly.

## Commands

Run unit tests:

```bash
cd /home/pfrpc/repos/tasknodeofficial/reference_clients/python
python3 -m unittest discover -s tests
```

Run the live lifecycle:

```bash
cd /home/pfrpc/repos/tasknodeofficial/reference_clients/python
python3 -m tasknode_pftl.scenarios.full_lifecycle
```

Run with an explicit RPC endpoint:

```bash
PFTL_RPC_URL=http://178.156.143.199:5005 \
python3 -m tasknode_pftl.scenarios.full_lifecycle
```

Run with the high-reasoning benchmark path:

```bash
python3 -m tasknode_pftl.scenarios.full_lifecycle \
  --benchmark-high-reasoning
```

Run a protocol-only smoke test without OpenAI task generation:

```bash
python3 -m tasknode_pftl.scenarios.full_lifecycle \
  --allow-taskgen-fallback
```

The scenario prints addresses, balances, CIDs, tx hashes, and the final replay
projection. It does not print seeds.

## Encryption And MessageKey Reference

`tasknode_pftl.scenarios.encryption_pubkey_demo` is the canonical minimal
reference for wallet encryption key onboarding:

1. create fresh PFTL wallets;
2. derive each wallet's recoverable, domain-separated X25519 encryption key
   from its wallet seed;
3. fund the wallets from `FAUCET_SEED`;
4. publish each X25519 public key to PFTL with `AccountSet.MessageKey` as
   `ED<32-byte-x25519-public-key-hex>`;
5. fetch those `MessageKey` values back from `account_info`;
6. encrypt an IPFS task request payload only to the on-chain-resolved recipient
   keys;
7. write a `pf.ptr/v4` task pointer transaction to that encrypted CID;
8. prove the intended wallets can decrypt and an outsider cannot.

Run it:

```bash
cd /home/pfrpc/repos/tasknodeofficial/reference_clients/python
python3 -m tasknode_pftl.scenarios.encryption_pubkey_demo
```

This is the expected key-discovery model for new wallets. A PFTL address alone
is not enough to encrypt to a wallet; the wallet must publish an encryption
public key in `MessageKey` or the sender must have an explicit trusted key from
another source.

TaskNode itself also needs a discoverable service encryption key. The app can
derive the service key from `TASKNODE_SERVICE_SEED`,
`TASKNODE_ENCRYPTION_SEED`, `TASKNODE_PFT_FAUCET_SEED`, or `FAUCET_SEED`, but
external replay clients should resolve it from the service wallet's on-chain
`MessageKey`.

Inspect or publish the service wallet key without printing seed material:

```bash
npm run tasknode-service-message-key
npm run tasknode-service-message-key -- --publish
```

## Verification Evidence Readers

`tasknode_pftl.verification` is the canonical Python evidence adapter for
PFTL verification payloads. It mirrors the PFTasks production verification
surface without depending on the PFTasks database:

- screenshot evidence is read with OpenAI Responses vision image input;
- PDF evidence is extracted with `pypdf` when installed, with a conservative
  literal-string fallback for simple PDFs;
- DOCX evidence is extracted directly from the OOXML package with the Python
  standard library;
- public URL evidence is fetched as bounded text/HTML, with first-class GitHub
  gist aggregation through the GitHub gist API.

Run all four example readers:

```bash
cd /home/pfrpc/repos/tasknodeofficial/reference_clients/python
python3 -m tasknode_pftl.scenarios.verification_evidence_examples
```

The example writes sample inputs, `pf.task.evidence.v1` packets, a
`pf.task.verification_response.v1` packet, and a markdown receipt under
`reference_clients/python/runs/`. Screenshot reads require `OPENAI_API_KEY`;
the config loader reads the same PFTasks env files and workspace `env_dump.txt`
used by the lifecycle harness.
