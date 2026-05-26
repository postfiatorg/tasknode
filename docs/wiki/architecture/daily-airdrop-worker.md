# Daily Airdrop Worker

The Daily Airdrop worker scores recent rewarded work and issues PFT drops through
durable issuance rows. It also writes a Hive Mind Agent audit card after each
worker run so payout activity is visible on the board.

System Status row: `daily_airdrop_worker`

## Runtime Boundary

- Worker module: `server/profile-daily-airdrop-worker.js`.
- Prompt: `prompts/profile/daily_airdrop_v1.md`.
- Source tables: `profile_daily_airdrop_runs`,
  `profile_daily_airdrop_issuances`, and Board Manager audit rows with
  `selected_action = 'daily_airdrop'`.
- Surface docs: Daily Airdrop and Profile.

## Status Derivation

Green means the worker is enabled and either a score/issuance run or a zero
candidate worker audit run completed within the daily freshness window.

Amber means the latest successful run is lagging or recent failed run/issuance
records exist.

Red means the latest run failed recently or the worker is stale beyond the hard
threshold.

## Debug And Repair

Run the worker and issue script only after checking failed issuance state:

```bash
npm run profile-daily-airdrop-worker -- --json
npm run profile-daily-airdrop-issue -- --account-id=<account_id> --run-id=<run_id>
```

Failed issuance rows are money-path state. If `tx_hash` is empty and
`submitted_at` is null, the row can be retried after the root cause is fixed. If
submission may have happened, reconcile chain/cache state before retrying so
duplicate payouts are not signed.
