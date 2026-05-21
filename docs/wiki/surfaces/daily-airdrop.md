# Daily Airdrop

Daily Airdrop is an account-level private scoring job. It reviews the member's recent rewarded task work and produces a proposed daily PFT drop plus a short explanation of what raised the score, what lowered it, and what to improve tomorrow.

Current status: scoring and operator-triggered live issuance are implemented. A scoring run writes `profile_daily_airdrop_runs`; issuance writes exactly one `profile_daily_airdrop_issuances` row and submits a PFTL payment pointer.

### Private Profile Read Path

The private profile top section reads the latest completed run through `GET /api/profile/daily-airdrop`.

Displayed airdrop values come from:

- `daily_airdrop_pft`;
- `run_mode`;
- `completed_at`;
- `retention_value_score`;
- `actual_airdrop_pft_7d`;
- `max_possible_airdrop_pft_7d`;
- `alignment_score_7d`;
- `what_raised_today`;
- `what_kept_it_lower`;
- `to_improve_tomorrow`;
- `reasoning_text`;
- `input_snapshot.airdrop_recipient`;
- `input_snapshot.reward_totals`.

The adjacent reward chart uses `GET /api/profile/reward-history?range=7d|28d|90d`. It is based on actual positive `reward_actual_pft` task projections, submitted daily airdrop issuances, and reward event timestamps. It intentionally renders one earned-PFT series until task reward categories are real data.

### Evidence Packet

The scorer builds one compact task reward packet from Postgres task projections and task reward events.

Included work:

- only tasks tied to the account's identity wallet cloud;
- only tasks with `reward_paid_pft > 0`;
- only tasks inside the trailing lookback window, currently 7 days;
- task title, kind, status, reward offer, reward paid, reward decision, reward reason, completion score, evidence quality, event CIDs, and transaction hashes.

Excluded work:

- zero-reward tasks;
- tasks from wallets not in the account wallet cloud;
- raw evidence blobs unless a later version explicitly needs them.

### Identity Cloud

The airdrop is one score per identity cloud, not one score per wallet. An account can link, delink, and relink multiple PFT wallets over time, but daily scoring remains keyed by `account_id` and `run_date`.

The identity wallet cloud is built from:

- the active linked wallet;
- wallet link, relink, and delink auth events for the account;
- reclaim events that remove wallets now claimed by another active account.

This prevents a user from farming airdrops by rotating wallets and prevents Task Node authority/funding wallets from being selected just because they appear in chain replay rows.

### Recipient Wallet

Recipient selection is deterministic metadata, not model reasoning.

The selected recipient wallet is chosen from eligible identity-cloud wallets by:

1. highest all-time task count in `task_projections`;
2. rewarded task count;
3. total rewarded PFT;
4. most recent task update;
5. active linked wallet;
6. wallet address as final stable ordering.

The scoring snapshot stores deterministic selector facts:

```json
{
  "wallet_address": "r...",
  "selection_status": "selected",
  "selection_basis": "identity_cloud_all_time_task_count",
  "selected_active_wallet": true,
  "task_count": 20,
  "rewarded_task_count": 12,
  "reward_paid_pft": 20.45,
  "last_task_at": "2026-05-20T17:40:48.585Z",
  "candidate_wallet_count": 2
}
```

There is no `selection_reason` prose field. The fields above are enough to audit why the wallet was selected.

### Model Score

The prompt is `prompts/profile/daily_airdrop_v1.md`.

Runtime call sites:

- `server/profile-daily-airdrop.js::runDailyAirdropScore`
- `scripts/profile-daily-airdrop-score.mjs`

Provider policy:

- model: `deepseek/deepseek-v4-pro`;
- provider: OpenRouter private route;
- ZDR required;
- `data_collection: "deny"`;
- temperature `0`;
- structured JSON output;
- no user billing in v1.

The model returns:

- `daily_airdrop_pft`;
- `retention_value_score`;
- `what_raised_today`;
- `what_kept_it_lower`;
- `to_improve_tomorrow`;
- `eligibility_status`;
- `eligibility_reason`;
- `reasoning_text`.

`reasoning_text` is contributor reasoning. It explains why the member's task packet merits the proposed drop. Recipient wallet selection is deterministic and separate from contributor reasoning.

### Alignment Score

Alignment score is deterministic. It is not an LLM output.

```text
alignment_score_7d =
  actual_airdrop_pft_7d
  /
  max_possible_airdrop_pft_7d
```

The denominator is the sum of each counted airdrop run's max possible amount. It is not blindly `max_daily_pft * 7`.

Examples:

- one dry run proposes `600 PFT` with a `10000 PFT` max: `600 / 10000 = 0.06`;
- seven completed production runs each with a `10000 PFT` max: denominator is `70000 PFT`.

During the scoring-only phase, `actual_airdrop_pft_7d` means completed dry-run or production scoring rows that are explicitly counted by the run. Once live issuance exists, it should mean actually issued production PFT.

### Database

`profile_daily_airdrop_runs` stores scoring runs.

Important fields:

- `account_id`;
- `run_date`;
- `run_mode`: `dry_run` or `production`;
- `scenario_id`;
- `status`;
- `daily_airdrop_pft`;
- `retention_value_score`;
- `what_raised_today`;
- `what_kept_it_lower`;
- `to_improve_tomorrow`;
- `reasoning_text`;
- `actual_airdrop_pft_7d`;
- `max_possible_airdrop_pft_7d`;
- `alignment_score_7d`;
- `input_snapshot`;
- `output_json`;
- provider/model/prompt metadata.

The production uniqueness boundary is one production scoring row per account per UTC day. Dry runs can be repeated for prompt and packet testing.

`profile_daily_airdrop_issuances` stores live payment submissions. It is keyed by `run_id` and prevents more than one submitted issuance per account/day.

### Current Goodalexander Dry Run

The latest verified local dry run used account `acct_oauth_3c70e69ab7b8ef1fad3df508`.

Observed packet:

- eligible identity-cloud wallets: `rhwiJxkiTkxTC65MrmLG7WiUkbiCyw2TaE`, `rPo8GkCA9YMKzuJGTHbj11kdVfPqSJHxNx`;
- selected recipient: `rhwiJxkiTkxTC65MrmLG7WiUkbiCyw2TaE`;
- rewarded tasks counted: `12`;
- rewarded task PFT counted: `20.45`;
- paid production airdrop: `600 PFT`;
- alignment score: `0.06`;
- transaction: `B16678C024C0780D12227E9CC9FA4CCB1FA2BA3EC65341BFFAE40FC978FC6AB2`;
- pointer CID: `QmPyxEi3Sk9AXc6QCPJK2M11fb5okTmTuR21VXkxbTuaLo`.

### Live Issuance Boundary

Live issuance currently runs through `scripts/profile-daily-airdrop-issue.mjs`. It converts a completed scoring row into exactly one account/day issuance row, then pays from the configured reward/faucet wallet to the deterministic identity-cloud recipient wallet.
