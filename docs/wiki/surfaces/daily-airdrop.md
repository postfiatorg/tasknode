# Daily Airdrop

Daily Airdrop is an account-level private scoring job. It reviews the member's recent rewarded task work and produces a proposed daily PFT drop plus a short explanation of what raised the score, what lowered it, and what to improve tomorrow.

Current status: recurring scoring and live issuance are implemented behind `TASKNODE_DAILY_AIRDROP_WORKER_ENABLED=true`. A scoring run writes `profile_daily_airdrop_runs`; issuance claims exactly one `profile_daily_airdrop_issuances` row, marks it `processing` before any PFT signing work, and then submits a PFTL payment pointer. The worker also writes a `Hive Mind Agent` audit card summarizing how much PFT was dispensed and to how many users.

### Private Profile Read Path

The private profile top section reads the latest completed run through `GET /api/profile/daily-airdrop`. The large headline is the daily airdrop amount only. It says `Today's airdrop` only when that airdrop was scored or paid on the current UTC date; otherwise it says `Latest airdrop`.

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

The adjacent reward chart uses `GET /api/profile/reward-history?range=7d|28d|90d`. It is based on actual positive `reward_actual_pft` task projections, submitted daily airdrop issuances, and reward event timestamps. It intentionally renders one earned-PFT series until task reward categories are real data. The chart total can be much larger than the daily airdrop headline because it includes task rewards; the UI must keep those labels separate.

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
- `server/profile-daily-airdrop-worker.js::runDailyAirdropWorkerOnce`
- `server/profile-daily-airdrop-worker.js::startDailyAirdropWorker`
- `scripts/profile-daily-airdrop-score.mjs`
- `scripts/profile-daily-airdrop-worker.mjs`

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

`profile_daily_airdrop_issuances` stores live payment submissions. It is keyed by `run_id` and prevents more than one submitted issuance per account/day. The recurring worker treats any pending, processing, submitted, or failed issuance for an account/day as a stop sign so retries do not blindly double-pay after a partial chain failure.

Issuance state is intentionally conservative:

- `processing`: a worker has claimed the run for publication. No other worker may publish it. If a PFT submission has been attempted and the process times out or cannot persist the tx result, the row stays `processing` with an error message until a reconciliation/operator path proves whether payment happened.
- `submitted`: the PFTL payment and pointer are persisted with transaction hash, pointer CID, payload digest, and ledger index.
- `failed`: no PFT submission was attempted. This can be reclaimed by a manual retry because no on-chain payment risk exists yet.

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

### Recurring Worker

The recurring worker is `server/profile-daily-airdrop-worker.js`. It is started by `server/background-workers.js` when `TASKNODE_DAILY_AIRDROP_WORKER_ENABLED=true`; local Docker enables it in `docker-compose.dev.yml`.

Each tick:

1. claims a Postgres-backed `daily_airdrop` lease using the same lease table as Board Manager so multiple app instances do not run the payout loop at the same time;
2. selects accounts with positive rewarded task work inside the trailing seven-day task packet and no production/pending/submitted/failed airdrop for the current UTC day;
3. runs the existing DeepSeek/OpenRouter daily airdrop scorer in dry-run mode to create a completed scoring row;
4. issues the specific scoring run through `issueLatestDailyAirdrop` when the proposed amount is positive;
5. records a `board_manager_runs` row with internal action `daily_airdrop` and a `board_manager_action_results` row whose summary reads like: `Dispensed 600 PFT to 1 user as part of daily airdrop.` Zero-candidate ticks are recorded too, so the Help system status page has a durable last-run timestamp.

`issueLatestDailyAirdrop` is fail-closed for money. It claims a row as `processing` before signing. If failure occurs before a PFT submission is attempted, the row is marked `failed` and can be retried. If failure occurs after submission is attempted, the row remains `processing` so a retry cannot sign another payment until reconciliation has inspected the chain/cache.

The manual operator command remains available:

```bash
npm run profile-daily-airdrop-worker -- --json
```

The older direct commands remain useful for diagnosis:

```bash
npm run profile-daily-airdrop-score -- --account-id <account_id> --run-mode dry_run
npm run profile-daily-airdrop-issue -- --account-id=<account_id> --run-id=<run_id>
```

## Reviewer To Do List

Review implementation against this document (daily airdrop). Mark each item when verified.

### Memory Efficiency
- [ ] List and detail views read Postgres caches with documented caps or pagination.
- [ ] Async workers handle heavy model/IPFS work; primary UX path stays non-blocking.
- [ ] Scoring uses bounded 7-day task-reward packet, not full wallet history.
- [ ] Issuance idempotency keys prevent duplicate payouts on retry.

### Code Quality
- [ ] Code references in doc resolve to existing modules and routes.
- [ ] Failure modes documented here have matching user-visible error handling.
- [ ] Alignment score formula matches implementation in `profile-daily-airdrop.js`.
- [ ] Dry-run vs production modes clearly separated in scripts and API.

### Coherence
- [ ] Surface behavior matches Architecture docs for cache vs canonical state.
- [ ] Hidden/not-exposed features labeled honestly if mentioned.
- [ ] Identity cloud recipient selection deterministic and documented.
- [ ] Scoring prompt output shape matches parser expectations.

### Bloat
- [ ] Surface does not duplicate logic owned by shared modules or workers.
- [ ] UI state not duplicated in unrelated caches without invalidation rules.
- [ ] Run records stored in dedicated tables; not duplicated across profile and wallet caches.

### Security
- [ ] Account scoping enforced on all read/write API paths for this surface.
- [ ] Wallet-bound actions require linked unlocked wallet as documented.
- [ ] Reward pool wallets operator-controlled; no user-supplied payout addresses.
- [ ] No-double-pay invariants enforced before on-chain issuance.
