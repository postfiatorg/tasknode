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

Green means the worker is enabled, a score/issuance run or zero-candidate worker
audit run completed within the daily freshness window, and no unresolved
airdrop debt is present.

Amber means the latest successful run is lagging or recent failed run/issuance
records exist.

Red means the latest run failed recently, the worker is stale beyond the hard
threshold, or unresolved submit-unknown/stale debt requires reconciliation.

Fresh in-flight rows are not debt. A `running` production scoring row younger
than `TASKNODE_DAILY_AIRDROP_SCORE_STALE_MINUTES` (default `45`) and a
`processing_pre_submit` issuance row younger than
`TASKNODE_DAILY_AIRDROP_PRE_SUBMIT_STALE_MINUTES` (default `30`) are normal
payout-tick state and do not flip the status row. Only rows older than those
worker stale thresholds count as debt/blocked.

## Debug And Repair

Candidate selection requires a recent positive task reward, no same-day
running/completed production scoring run, no same-day issuance stop row, and an
active `pftl_sync_wallets` row with `role = 'user'`. The scoring packet then
rebuilds the account wallet cloud from `pftl_sync_wallets`, including active
user wallets and inactive historical user wallets. It must not read app-local
runtime-store wallet state, because Fly `app` and `worker` processes do not
share that file or memory.

The wallet cloud is an attribution set, not a payout fanout. The worker creates
one scoring run per `account_id` and one issuance recipient for that run.

If candidate selection reports positive rewarded work but the scoring packet has
zero eligible wallets, zero rewarded tasks, or zero rewarded PFT, the worker must
fail before writing a completed production run. The expected error is
`daily_airdrop_packet_candidate_mismatch`. A completed zero run in that scenario
is a data-boundary bug, not a legitimate ineligible score.

The model's proposed amount is clamped before money moves. The always-on rail is
`TASKNODE_DAILY_AIRDROP_MAX_PFT` (default `10000`). Operators may opt into an
additional proportionality cap by setting
`TASKNODE_DAILY_AIRDROP_MAX_REWARD_FRACTION`; when unset, the proportional cap
is disabled so the hardening path does not slash normal airdrops. The run's
`output_json.normalized.deterministic_cap` records the cap inputs and a
`cap_bound` flag so operators can see when a configured cap clamped the model
output.

Failed production scoring rows are retryable. The debt command and the
system-status airdrop row report them as kind `scoring` with the raw run status
`failed` and `nextAction=retry_scoring`; issuance-status normalization (which
maps a money-path `failed` row with no `tx_hash` to `failed_before_submit` /
`retry_issuance`) never applies to scoring rows. The next worker tick reclaims
the same `profile_daily_airdrop_runs` row, clears the error, and resets it to
`running` with the new packet and prompt metadata. Stale `running` rows older
than `TASKNODE_DAILY_AIRDROP_SCORE_STALE_MINUTES`, default `45`, are marked
failed with `daily_airdrop_stale_running_reclaimed` so the same account/day can
retry. Completed or fresh running production scoring rows still block duplicate
same-day scoring.

The recipient payout refresh must not demote that same wallet to
`daily_airdrop_recipient`; `registerPftlSyncWallet` preserves `user` as the
canonical role when a wallet also appears in payout sync.

The worker checks today plus the previous
`TASKNODE_DAILY_AIRDROP_CATCHUP_DAYS`, default `2`, so a failure just before UTC
midnight can still be completed on the next tick. It retries
`failed_before_submit` issuance rows up to
`TASKNODE_DAILY_AIRDROP_MAX_ISSUANCE_ATTEMPTS`, default `5`.

The worker also recovers missing-issuance debt inside the same checked dates: a
completed production run with positive `daily_airdrop_pft` and no issuance row
at all (for example, a worker crash between scoring completion and the issuance
claim) is re-issued through the normal fail-closed claim path. The debt command
reports these rows as kind `issuance_missing` with status `missing_issuance` and
`nextAction=retry_issuance`; runs whose snapshot has no recipient wallet are
reported as `inspect` instead and are skipped by automatic recovery.

Run the worker and issue script only after checking failed issuance state:

```bash
npm run profile-daily-airdrop-worker -- --json
npm run profile-daily-airdrop-debt -- --json
npm run profile-daily-airdrop-issue -- --account-id=<account_id> --run-id=<run_id>
npm run profile-daily-airdrop-packet-smoke
```

The issue script requires both `--account-id` and `--run-id`: issuing pays the
exact scoring run, never an implicit "latest completed" run. Claiming an
issuance also refuses to promote a non-production scoring run; a `dry_run` run
throws `daily_airdrop_dry_run_promotion_blocked` unless the operator explicitly
passes `--allow-dry-run-promotion` after confirming the run should be paid.

Failed issuance rows are money-path state. If `tx_hash` is empty and
`submitted_at` is null, the row is normalized as `failed_before_submit` and can
be retried after the root cause is fixed. If submission may have happened, the
row is `submit_unknown`; reconcile chain/cache state before retrying so duplicate
payouts are not signed:

```bash
npm run profile-daily-airdrop-reconcile -- --run-id=<run_id> --json
```

Reconciliation never trusts a stale cache. Before searching `pftl_transactions`
it hot-syncs both the source and recipient wallets and runs the cache reducer,
then records both `pftl_sync_wallets.last_hot_sync_at` watermarks in
`reconciliation_json` and the script output. Only use `--allow-demote` after the
cached PFTL transaction search proves no matching source wallet, recipient
wallet, amount, run id, pointer CID, or signed transaction hash exists; the
demote is additionally refused (`daily_airdrop_demote_blocked_stale_sync`) when
either wallet's hot-sync watermark predates the issuance's
`submission_attempted_at`, because the missing payment may simply not be cached
yet and a demoted row auto-retries with a second signed payment. Override only
with `--force-demote-stale-sync` after manually inspecting chain state.
