# Network Task Lifecycle Replay Fixture

This is a minimal deterministic fixture for validating the Network Task
lifecycle without a live wallet, IPFS, Postgres, or model provider.

It proves one canonical path:

1. task offered
2. task accepted
3. initial evidence submitted
4. authority review decision recorded
5. reward paid

The fixture lives in:

```text
reference_clients/python/tasknode_pftl/fixtures/network_task_lifecycle_replay/
```

Each event is a JSON artifact with:

- a `payload`, shaped like the app's PFTL/IPFS task payload;
- a `pointer`, shaped like the reduced PFTL pointer fact used during replay;
- deterministic event IDs, timestamps, ledger indexes, CIDs, and transaction
  hashes.

## Run

From the repository root:

```bash
PYTHONPATH=reference_clients/python \
python3 -m tasknode_pftl.scenarios.network_task_replay_fixture
```

Expected output:

```text
Network Task lifecycle fixture replay ok
  fixture: network_task_lifecycle_replay_v1
  task_id: task_net_replay_000000000000000000000001
  offered: none -> proposed (ledger 5100001, event evt_net_replay_offer_0001)
  accepted: proposed -> accepted (ledger 5100002, event evt_net_replay_accept_0001)
  submitted: accepted -> submitted (ledger 5100003, event evt_net_replay_submission_0001)
  reviewed: submitted -> reward_decided (ledger 5100004, event evt_net_replay_review_0001)
  rewarded: reward_decided -> rewarded (ledger 5100005, event evt_net_replay_reward_0001)
  final_status: rewarded
  reward_actual_pft: 12000
```

For machine-readable output:

```bash
PYTHONPATH=reference_clients/python \
python3 -m tasknode_pftl.scenarios.network_task_replay_fixture --json
```

## Pass Conditions

The verifier passes only if:

- every event moves through an allowed state transition;
- all events reduce to the same task ID;
- the final projection matches `expected_projection.json`;
- the final status is `rewarded`;
- the reward amount is `12000` PFT;
- the event count is exactly five.

The verifier fails if an event is reordered into an invalid lifecycle path,
uses an unsupported schema, mutates a projected field unexpectedly, or ends in
the wrong final state.
