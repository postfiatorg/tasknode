# Phase 1a Agent Capability Client Report

Date: 2026-06-15
Branch: `feat/agent-capability-client`

## Client surface

Implemented `reference_clients/python/tasknode_pftl/agent_client.py`.

- Wallet login: `TaskNodeAgentClient.login()` calls `POST /api/auth/wallet/start`, signs the returned challenge with the agent wallet, calls `POST /api/auth/wallet/verify`, stores `account_id`, and auto re-logins once on a 401 read (`agent_client.py:302`, `agent_client.py:339`).
- Seed loading: `load_agent_wallet()` reads `/home/pfrpc/repos/tasknode_agent_wallets.json` only after enforcing non-group/non-world-readable permissions (`agent_client.py:217`, `agent_client.py:262`). Seeds are never printed by the client.
- Reads: `tasks()`, `task_detail()`, `hive_projects()`, `hive_context()`, `profile()`/`profile_identity()`, `public_profile()`, `memory()`, and `network_task_profile()` (`agent_client.py:377`).
- Eligibility: `ensure_eligible()` force-refreshes `/api/memory/network-task-profile` and returns the network-task status/gates from `/api/tasks` (`agent_client.py:408`, `agent_client.py:412`).
- Hive: `hive_say(message)` posts to `/api/hive/context` (`agent_client.py:392`).
- Context doc: `context_document()`, `save_context()`, and signed `publish_context()` (`agent_client.py:424`, `agent_client.py:433`).
- Signed task flows: `accept_task()`, `submit_evidence()`, `respond_verification()`, and optional `request_task()` implement the existing config -> prepare -> sign -> optional submit shape (`agent_client.py:476`, `agent_client.py:548`, `agent_client.py:565`, `agent_client.py:631`).
- Signing/encryption primitives reuse the Python reference client: Task Node X25519/XChaCha envelope with `version: 1` and `content_hash`, XRPL/PFTL transaction signing, local signature verification, and pointer memo decoding (`agent_client.py:97`, `agent_client.py:121`, `agent_client.py:150`, `agent_client.py:171`).

## Production eligibility drive

Wallet used: `raUWC44pUJdFgrQYvP8aVUTMJ9TJWSTbsW`
Account resolved: `acct_wallet_1a528118923ae8830d46f56e`

Actions performed against `https://tasknode.postfiat.org`:

1. Wallet login succeeded via `/api/auth/wallet/start` -> `/api/auth/wallet/verify`.
2. Forced one routing-profile refresh with `POST /api/memory/network-task-profile`.
3. Read `/api/tasks`.
4. Polled `GET /api/memory/network-task-profile` and `/api/tasks` until the routing profile completed.

Initial post-refresh state:

- Network Diagnostic Report: `pending`
- Final status at that instant: `profile_pending`

Final state:

- Final eligibility status: `available_for_routing`
- Label: `Eligible for Board Manager routing`
- Linked PFT wallet: `complete`
- Wallet synced: `complete`
- Network Diagnostic Report: `complete`
- Network Task capacity: `complete`
- Hive Board Manager routing: `waiting`
- Capacity metrics: `accountOutstandingCount=0`, `walletOutstandingCount=0`, `accountOnlyPendingCount=0`, `accountPendingGenerationCount=0`, `walletPendingGenerationCount=0`

No funding, on-ledger submit, admin grant, or chat-credit spending was performed. I did not call `hive_say()` on production because the task's current guardrail says "NO chat-credit spend"; the client method exists and is covered by the route surface.

## Signing proof

Using the same agent wallet, locally generated synthetic PFTL Payment transactions with Task Node pointer memos and verified signatures locally. No transaction was submitted.

- `acceptTask`: kind `TASK_UPDATE`, verified `true`, tx hash `601A6A09A2B0B92C1C7F9B9BAEBD5CB5350DB040521062A1DFD247C9AF9EA8F0`
- `submitEvidence`: kind `TASK_SUBMISSION`, verified `true`, tx hash `328E94A3C71FECD9E8C0519D795AE8251D6CB81DC86A24AD1D197A321542914E`
- `respondVerification`: kind `TASK_SUBMISSION`, verified `true`, tx hash `4168A4BE57E4D855C906986164391A0AC2ABADA01314E9C63385E57AC6DA9E51`

## Funding boundary

The first step that requires the wallet to be funded/on-ledger is any signed flow's `prepare` phase that reaches `preparePftPointerTransaction()`:

- It builds a Payment with pointer memo and default `amountDrops = "1"` (`server/pftl-submit.js:273`, `server/pftl-submit.js:294`).
- It calls PFTL `autofill()`, which fails for an unactivated source wallet with `source_wallet_unfunded` (`server/pftl-submit.js:325`, `server/pftl-submit.js:329`).
- It then reads `account_info` and `server_info` and requires `balanceDrops - reserveDrops - feeDrops` to be positive and enough for the 1-drop pointer amount (`server/pftl-submit.js:338`, `server/pftl-submit.js:344`, `server/pftl-submit.js:347`, `server/pftl-submit.js:349`).

Current PFTL read-only RPC checks:

- `server_info` from `https://rpc.testnet.postfiat.org`: `reserve_base_xrp=10`, `reserve_inc_xrp=2`, validated ledger present.
- `fee`: `open_ledger_fee=10` drops, `minimum_fee=10` drops.

Therefore the current first funding amount for a 1-drop pointer transaction is:

- `10 PFT` base account reserve
- `+ 10 drops` current open-ledger fee
- `+ 1 drop` pointer amount
- Total current minimum: `10,000,011 drops` = `10.000011 PFT`

The app still uses the live prepared `Fee` returned by `autofill()`, so the exact production requirement at prepare time is `reserveDrops + prepared.Fee + 1`.

Funding paths found in code:

- Wallet initiation grant starts at `/api/wallet/create/start` (`server/product-contracts.js:1035`).
- Default initiation grant amount is `12 PFT` unless `TASKNODE_WALLET_INITIATION_PFT` changes it (`server/wallet-initiation-eligibility.js:7`).
- Faucet funding reads `TASKNODE_PFT_FAUCET_SEED` or `FAUCET_SEED` (`server/pftl-faucet.js:90`) and reports whether the configured faucet can pay initiation grants (`server/pftl-faucet.js:93`).
- Manual funding remains the direct external path.

For this wallet-login-only agent account, the account already has the linked wallet and sync gates complete; I did not attempt any grant, faucet payment, admin action, or manual funding.

## Verification commands

- `uv run python -m unittest tests.test_agent_client`
  - Result: `Ran 9 tests in 0.140s OK`
- Production eligibility drive script through `TaskNodeAgentClient`
  - Result: login OK, routing profile completed, final `available_for_routing`
- Local signing proof script through `build_synthetic_signed_pointer()`
  - Result: all three proof transactions verified locally
- Read-only PFTL RPC checks
  - `server_info`: reserve base `10`
  - `fee`: open ledger fee `10` drops

## Not verified

- I did not call any signed-flow `prepare` endpoint on production because the current agent wallet is intentionally unfunded and the task forbids funding/on-ledger submission. The signed-flow API shape is covered by mocked tests and local transaction signing proof.
- I did not call `hive_say()` on production to avoid possible chat-credit spend under the stricter guardrail.
