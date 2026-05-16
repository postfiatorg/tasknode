# Task Node PFTL Reference Client

This directory is a protocol harness for Task Node. It intentionally lives
outside the React app so task issuance, submission, verification, reward, and
replay can be exercised without waiting on UX.

PFTL is its own L1. It is XRPL-compatible at the transaction/RPC layer, so this
reference client uses the Python `xrpl` package as a wire library. It must not
be pointed at XRP mainnet or XRP testnet.

## What The Full Lifecycle Scenario Does

`tasknode_pftl.scenarios.full_lifecycle` performs a live testnet run:

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
gitignored because it contains generated testnet wallet seeds and encryption
private keys.

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
```

Optional:

```text
OPENAI_API_KEY
OPENAI_BASE_URL
TASKNODE_ENCRYPTION_PUBKEY
```

If `OPENAI_API_KEY` is present, task generation uses `chat-latest` by default.
If it is missing or the model call fails, the harness uses a deterministic
minimal fallback and marks the generation metadata accordingly.

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

The scenario prints addresses, balances, CIDs, tx hashes, and the final replay
projection. It does not print seeds.

