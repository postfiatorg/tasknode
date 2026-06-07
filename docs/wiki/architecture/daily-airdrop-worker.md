# Daily Airdrop Worker

The Daily Airdrop worker scores recent rewarded work and issues PFT drops through
durable issuance rows. It also writes a Hive Mind Agent audit card after each
worker run so payout activity is visible on the board.

System Status row: `daily_airdrop_worker`

## Runtime Boundary

- Worker module: `server/profile-daily-airdrop-worker.js`.
- Prompt: `prompts/profile/daily_airdrop_v1.md`.
- Source tables: `pftl_sync_wallets`, `task_projections`, `task_events`,
  `profile_daily_airdrop_runs`, `profile_daily_airdrop_issuances`, and Board
  Manager audit rows with `selected_action = 'daily_airdrop'`.
- Surface docs: Daily Airdrop and Profile.

## Status Derivation

Green means the worker is enabled and either a score/issuance run or a zero
candidate worker audit run completed within the daily freshness window.

Amber means the latest successful run is lagging or recent failed run/issuance
records exist.

Red means the latest run failed recently or the worker is stale beyond the hard
threshold.

## Debug And Repair

Candidate selection requires a recent positive task reward, no same-day
production run or issuance stop row, and an active `pftl_sync_wallets` row with
`role = 'user'`. The scoring packet then rebuilds the account wallet cloud from
`pftl_sync_wallets`, including active user wallets and inactive historical user
wallets. It must not read app-local runtime-store wallet state, because Fly
`app` and `worker` processes do not share that file or memory.

The wallet cloud is an attribution set, not a payout fanout. The worker creates
one scoring run per `account_id` and one issuance recipient for that run.

If candidate selection reports positive rewarded work but the scoring packet has
zero eligible wallets, zero rewarded tasks, or zero rewarded PFT, the worker must
fail before writing a completed production run. The expected error is
`daily_airdrop_packet_candidate_mismatch`. A completed zero run in that scenario
is a data-boundary bug, not a legitimate ineligible score.

The recipient payout refresh must not demote that same wallet to
`daily_airdrop_recipient`; `registerPftlSyncWallet` preserves `user` as the
canonical role when a wallet also appears in payout sync.

Run the worker and issue script only after checking failed issuance state:

```bash
npm run profile-daily-airdrop-worker -- --json
npm run profile-daily-airdrop-issue -- --account-id=<account_id> --run-id=<run_id>
npm run profile-daily-airdrop-packet-smoke
```

Failed issuance rows are money-path state. If `tx_hash` is empty and
`submitted_at` is null, the row can be retried after the root cause is fixed. If
submission may have happened, reconcile chain/cache state before retrying so
duplicate payouts are not signed.
