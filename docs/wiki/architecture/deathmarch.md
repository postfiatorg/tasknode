# Deathmarch Local Harness

`deathmarch` is a local-only Discord posting harness for Task Node task events. It does not require Fly and does not start the Task Node app.

The harness watches or ingests Task Node PFTL task actions, asks DeepSeek API Direct to summarize what the user just did, and posts the resulting plain-English update to the Discord Death March channel.

Default watched wallet:

```text
rPo8GkCA9YMKzuJGTHbj11kdVfPqSJHxNx
```

## Configuration

Required:

```bash
export DEEPSEEK_API_KEY=...
export DEATHMARCH_DISCORD_WEBHOOK_URL=...
```

`DEATHMARCH_DISCORD_WEBHOOK_URL` should be a webhook created for the Discord Death March channel.

Bot-token mode is also supported:

```bash
export DISCORD_BOT_TOKEN=...
export DEATHMARCH_DISCORD_CHANNEL_ID=...
```

Optional:

```bash
export DEATHMARCH_WALLET=rPo8GkCA9YMKzuJGTHbj11kdVfPqSJHxNx
export DEATHMARCH_SEED_FILE=deathmarchseed.txt
export DEATHMARCH_DEEPSEEK_MODEL=deepseek-v4-pro
export DEATHMARCH_DEEPSEEK_BASE_URL=https://api.deepseek.com/chat/completions
export DEATHMARCH_DEEPSEEK_MAX_TOKENS=1000
export DEATHMARCH_ANONYMITY_LEVEL=3
export DEATHMARCH_STATE_PATH=.deathmarch-state.json
```

Wallet polling uses the existing PFTL history settings:

```bash
export PFTL_HISTORY_WSS_URL=wss://ws-archive.testnet.postfiat.org
export PFTL_HISTORY_RPC_URL=https://rpc.testnet.postfiat.org:5006/
```

If encrypted task payloads need to be decrypted, the local environment also needs the Task Node service/encryption seed already used by the repo:

```bash
export TASKNODE_SERVICE_SEED=...
```

As a local-only convenience, `deathmarch` also auto-loads `deathmarchseed.txt` from the current repo directory when no service seed env var is already configured. When using the npm script from `tasknodeofficial`, it also checks one directory above the repo, which covers `/home/pfrpc/repos/deathmarchseed.txt`. The file is gitignored. You can point at a different file with:

```bash
npm run deathmarch -- --poll --seed-file /path/to/deathmarchseed.txt
```

If the seed file is a 24-word Task Node wallet mnemonic, it is used as the local user decryption identity. If it is a service seed and no service seed env var is already configured, it is used as `TASKNODE_SERVICE_SEED`. The harness does not print the seed.

## Data Feed

Wallet mode does not read from Fly, SPRS, Postgres, or Discord. It reads the local PFTL feed for the configured wallet:

1. `fetchHistoricalAccountTransactions` polls PFTL account history for `DEATHMARCH_WALLET`, defaulting to `rPo8GkCA9YMKzuJGTHbj11kdVfPqSJHxNx`.
2. `extractPftPointerEvents` extracts `pf.ptr/v4` memo pointers from account transactions.
3. The harness filters pointer kinds to `TASK`, `TASK_UPDATE`, `TASK_SUBMISSION`, and `REWARD`.
4. Each pointer CID is fetched from IPFS through the existing context gateways.
5. Encrypted payloads are decrypted locally with `TASKNODE_SERVICE_SEED`, or with the user mnemonic in `deathmarchseed.txt` when the payload is addressed to that wallet's Task Node encryption key.

Default PFTL endpoints come from the repo's history RPC helper:

```bash
PFTL_HISTORY_WSS_URL=wss://ws-archive.testnet.postfiat.org
PFTL_HISTORY_RPC_URL=https://rpc.testnet.postfiat.org:5006/
```

IPFS gateway overrides use:

```bash
TASKNODE_IPFS_GATEWAY=...
TASKNODE_IPFS_GATEWAYS=...
IPFS_GATEWAY_URL=...
```

## Commands

Dry-run the default wallet without posting:

```bash
npm run deathmarch -- --once --dry-run
```

Poll continuously:

```bash
npm run deathmarch -- --poll
```

Before running the poller for the first time, mark the current wallet history as already seen so the bot starts live instead of replaying old task events into Discord:

```bash
npm run deathmarch -- --once --mark-existing --seed-file ./deathmarchseed.txt
```

Poll continuously with an explicit local seed file:

```bash
npm run deathmarch -- --poll --seed-file ./deathmarchseed.txt
```

Ingest an exported event JSON file:

```bash
npm run deathmarch -- --file docs/verification/evidence/task_8f8ff4b94792842a9b54a63769710afd_double_reward_event_path.json --anonymity 3
```

Run local smoke coverage:

```bash
npm run deathmarch-smoke
```

## Event Scope

The harness handles Task Node task/action schemas:

- `pf.task.request.v1`
- `pf.task.offer.v1`
- `pf.task.update.v1`
- `pf.task.submission.v1`
- `pf.task.verification_response.v1`
- `pf.reward.v1`

It treats `TASK`, `TASK_UPDATE`, and `TASK_SUBMISSION` pointer kinds as in-scope. It reads `REWARD` pointers only when the decrypted payload is `pf.reward.v1`.

## Discord Message Format

Deathmarch posts compact action cards:

```text
**Task proposed**
**Launch Death March Discord Protocol**
A task was proposed to publish safe Discord task updates without exposing private payload details.
Task: `task_cdd241775a0a65ddae909bae3b771d29`
tx: 7005B006FDFF2C30F8914BC050A4B3B6C6FC72305F65A1ACD8CE8CB77BBF7C0C
```

DeepSeek writes only the plain-English explanation sentence. The harness adds the action heading, optional task title, task id, and exactly one `tx:` line. Generated summaries should not echo internal checklists, acceptance gates, verification rubrics, or color-coded visibility models from the task brief.

Submission updates must include the submitted artifact or response detail when it is safe to disclose:

```text
**Evidence submitted**
Submitted evidence: text: Published the Death March Discord protocol and posted the first compliant update.
Task: `task_cdd241775a0a65ddae909bae3b771d29`
tx: 4A22F4CA999E9582504EDB9E7134268784CDC0F9F051822D1E0CAAEB6D86EBCC
```

Reward outcome updates must come from `pf.reward.v1` and include amount and reason when present:

```text
**Reward outcome**
Recorded terminal reward outcome: 12,000 PFT. Evidence was accepted but before/after artifacts were incomplete.
Task: `task_cdd241775a0a65ddae909bae3b771d29`
tx: B3D7B19EA7E5D9CB7A5BE9E70696D3E6
```

The harness does not post legacy `pf.task.reward_decision.v1` events and does not infer a reward from a bare `REWARD` pointer when the decrypted payload is missing. The only terminal reward event is `pf.reward.v1`; zero-PFT outcomes use the one-drop carrier transaction described by the reward payload.

## DeepSeek Failure Behavior

There is no local summary fallback. If DeepSeek API Direct fails or returns an empty response, the harness reports the DeepSeek API error and does not post a Discord message for that event.

## Anonymity Levels

Level 1: trading IP and legal/team/client-confidential work.

- Heavily redacted.
- Directional category only.
- Does not pass task title, sector, instrument, ticker, client, investor, team member, evidence text, or named strategy to DeepSeek.
- Example acceptable output: `User requested a market or trading-related task. tx: ...`

Level 2: business interactions.

- Redacts client, investor, customer, and organization names.
- Can describe the broad action.

Level 3: network tasks and ordinary protocol work.

- Can disclose the task/action details present in the event packet.

## State

The harness writes `.deathmarch-state.json` by default so reruns do not repost the same transaction. The file is gitignored.

Use `--no-state` for tests or one-off replays where duplicate posting protection is not wanted.
