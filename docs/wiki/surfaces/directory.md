# Directory

Directory is the public operator leaderboard surface. It is reachable from the signed-in profile menu and renders at `#directory`.

The page is backed by `GET /api/directory/leaderboard`. It lists only operators whose Task Node profile is public and discoverable, then ranks the visible set from real task, reward, alignment, identity, and profile NFT data. Private or non-discoverable accounts are excluded from the response.

## Data Contract

The endpoint returns:

- totals for visible operators, rewarded tasks, and distributed PFT;
- one row per public/discoverable operator with account id, public handle, display name, wallet, rewarded Network task count, rewarded Personal task count, lifetime task reward PFT, latest alignment score, profile NFT image fields, profile-link availability, and viewer `isYou` state;
- the generated timestamp;
- the current default rank formula metadata.

Rows are keyed by `account_id`. Task counts and reward totals come from canonical rewarded task projections only: positive `reward_actual_pft`, nonzero `event_count`, and non-empty `last_event_tx_hash` plus `last_event_cid`. Local fixture rows such as `directory_polish_local_fixture`, `directoryPolishFixture`, `directory_polish_*`, and cancel-smoke projections are excluded from leaderboard, profile, reward-history, airdrop, identity-vector, and Task Accounting harvest reads. Alignment is the latest completed non-fixture `profile_daily_airdrop_runs.alignment_score_7d` converted to 0-100. Hero avatars prefer the selected usable non-fixture `profile_nfts` row and otherwise fall back to the newest usable row by `created_at`. The frontend uses the shared profile NFT image helper, so Directory row avatars request cached PFP thumbnails such as `/api/profile/nft/pfp/<cid>?size=96` instead of the full-resolution gallery image.

`GET /api/directory/rewarded-tasks` is the public audit packet for
discoverable operators' rewarded task history. Unlike leaderboard totals, a
rewarded task can have `0 PFT`; the packet includes these terminal zero outcomes
and carries a derived `statusPacket` so Orc tooling can distinguish
`paid_positive`, `closed_zero`, `duplicate_guarded`, and operational
`repairRequired` cases without changing canonical lifecycle state.

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
