# Directory

Directory is the public operator leaderboard surface. It is reachable from the signed-in profile menu and renders at `#directory`.

The page is backed by `GET /api/directory/leaderboard`. It lists only operators whose Task Node profile is public and discoverable, then ranks the visible set from real task, reward, alignment, identity, and profile NFT data. Private or non-discoverable accounts are excluded from the response.

## Data Contract

The endpoint returns:

- totals for visible operators, rewarded tasks, and distributed PFT;
- one row per public/discoverable operator with account id, public handle, display name, wallet, rewarded Network task count, rewarded Personal task count, lifetime task reward PFT, 30-day alignment score with its scored-day count, profile NFT image fields, profile-link availability, and viewer `isYou` state;
- the generated timestamp;
- the current default rank formula metadata.

Rows are keyed by `account_id`. Task counts and reward totals come from canonical rewarded task projections only: positive `reward_actual_pft`, nonzero `event_count`, and non-empty `last_event_tx_hash` plus `last_event_cid`. Local fixture rows such as `directory_polish_local_fixture`, `directoryPolishFixture`, `directory_polish_*`, and cancel-smoke projections are excluded from leaderboard, profile, reward-history, airdrop, identity-vector, and Task Accounting harvest reads. Alignment is the average `retention_value_score` (the daily airdrop model's 0-100 work-quality score) over eligible, completed, non-fixture production `profile_daily_airdrop_runs` in the trailing 30 days (`TASKNODE_ALIGNMENT_WINDOW_DAYS`); accounts with no scored day in the window show no alignment. It replaced the latest `alignment_score_7d`, which divided airdrop PFT by an unreachable 10,000 PFT/day cap, ignored dry runs and window age, and so showed stale, near-zero values. Hero avatars prefer the selected usable non-fixture `profile_nfts` row and otherwise fall back to the newest usable row by `created_at`. The frontend uses the shared profile NFT image helper, so Directory row avatars request cached PFP thumbnails such as `/api/profile/nft/pfp/<cid>?size=192` instead of the full-resolution gallery image.

`GET /api/directory/rewarded-tasks` is the public audit packet for
discoverable operators' rewarded task history. Unlike leaderboard totals, a
rewarded task can have `0 PFT`; the packet includes these terminal zero outcomes
and carries a derived `statusPacket` so Orc tooling can distinguish
`paid_positive`, `closed_zero`, `duplicate_guarded`, and operational
`repairRequired` cases without changing canonical lifecycle state.

Portraits are 64px, with creature and hyperstition traits below the identity for Techno Mordor artwork. Every profile has a deterministic illustrated starter PFP while waiting for earned artwork or when image gateways fail. Public/discoverable visibility and selected-NFT priority still apply.

## Ranking

The default formula is implemented in one backend function:

```text
score = 3 * networkTasks + personalTasks + rewards / 25000 + alignment
```

This weighting is configurable through the Directory leaderboard environment settings.

## Public Profile Links

Rows link to `#/profile?account=<accountId>` only when the existing member-profile route would allow that account. The route fetches `/api/profile/member?accountId=<accountId>` and renders the public profile view. Operators without an allowed public member profile render as inert rows, not dead links.

The link and avatar rules are intentionally the same as Hive's public identity
surface: profile links require `hasPublicProfile`, while NFT avatar data is
returned only for operators already admitted by the public+discoverable
Directory visibility gate. The Directory does not expose private or
non-discoverable accounts.

## Current Policy

- Directory exposure is limited to public, discoverable operators.
- The rank weighting is the configurable formula documented above.

## Blacklist

`GET /api/directory/blacklist` lists accounts blacklisted under the value
accountability policy: accounts paid for commentary on published writing or
audit/review write-ups that refused, missed the deadline for, or failed the
mandatory value check (Discord handle plus any checkable proof of a
contribution to Post Fiat, from any work). Ordinary network assignments and task rewards pause while the entry is active.

Signed-in contributors can open Tasks to see the reason and the time their unpaid reinstatement task becomes available. The task is issued 24 hours after the original entry, including to accounts without a wallet. An approved submission restores access. A reviewer can request another evidence revision. The Directory → Blacklist page also lets enrolled operators propose, approve, withdraw or cancel a manual override. Three distinct eligible approvals restore access. Opening a request contributes zero approvals.

### Operating reinstatement

Migration 164 backfills active entries using their original timestamps. The existing task-review process dispatches due offers at startup and every 15 seconds. Delivery retries preserve the case ID. Set TASKNODE_REINSTATEMENT_ISSUANCE_ENABLED=false on the task-review worker to pause dispatch during rollback. Re-enabling it drains the original due cases. Monitor `reinstatement_delivery_overdue` for offers delayed five minutes and `reinstatement_review_overdue` for submissions delayed 24 hours. The existing board supervisor and backup process consume the new review duty. Deploy the matching board runtime checkout, refresh the installed skills with `ops/bm-runtime/bm-install-skills.sh`, and check that the supervisor and backup use the updated registry. The migration adds the new board to valid managed pfterminal credentials already scoped to value accountability.

The operator administrator enrolls one verified account per person in `reinstatement_operators(account_id)`. Verify the account ID in `app_accounts` and confirm it belongs to the intended person before enrollment. Removing its roster row revokes its outstanding votes. Re-enrollment starts with zero votes. The contributor’s account cannot count toward its own quorum. The operator queue shows whether three eligible people are available.

For release verification, exercise the database smoke through the repository’s disposable database runner, then check the signed-in Tasks card, the board verdict receipt and the public directory after a test-account lift. The earlier single-operator CLI lift is retired. Preserve the migration and audit records if rolling back the application. An older worker cannot process new reinstatement submissions.

Network tasks are paid only for a GitHub pull request merged into the
repository's default branch, authored by the contributor's linked GitHub
account, merged after the task was created and not used to pay another task.
