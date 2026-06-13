# Directory

Directory is the public operator leaderboard surface. It is reachable from the signed-in profile menu and renders at `#directory`.

The page is backed by `GET /api/directory/leaderboard`. It lists only operators whose Task Node profile is public and discoverable, then ranks the visible set from real task, reward, alignment, identity, and profile NFT data. Private or non-discoverable accounts are excluded from the response.

## Data Contract

The endpoint returns:

- totals for visible operators, rewarded tasks, and distributed PFT;
- one row per public/discoverable operator with account id, public handle, display name, wallet, rewarded Network task count, rewarded Personal task count, lifetime task reward PFT, latest alignment score, profile NFT image fields, profile-link availability, and viewer `isYou` state;
- the generated timestamp;
- the current default rank formula metadata.

Rows are keyed by `account_id`. Task counts and reward totals come from `task_projections.reward_actual_pft > 0`. Alignment is the latest completed `profile_daily_airdrop_runs.alignment_score_7d` converted to 0-100. Hero avatars use the selected/latest usable `profile_nfts` image fields and render through the same CID proxy candidate order as Profile avatars.

## Ranking

The default formula is implemented in one backend function:

```text
score = 3 * networkTasks + personalTasks + rewards / 25000 + alignment
```

This weighting is intentionally marked open. It is a configurable default, not final product policy.

## Public Profile Links

Rows link to `#/profile?account=<accountId>` only when the existing member-profile route would allow that account. The route fetches `/api/profile/member?accountId=<accountId>` and renders the public profile view. Operators without an allowed public member profile render as inert rows, not dead links.

## Open Decisions

- OPEN - Alex's call: whether public exposure should remain public+discoverable only, expand to all operators, or anonymize private operators.
- OPEN - Alex's call: final rank weighting and whether alignment, PFT, Network tasks, and Personal tasks should carry different reputational weights.
