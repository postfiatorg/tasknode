# Daily Profile NFT Generation: Eligibility and Queue Specification

Status: Active
Owner: Profile / Rewards
Related code: `server/profile-nft-daily-worker.js`, `server/repositories/profile-nft-daily-awards.js`, `server/profile-nft-generation.js`
Related docs: `docs/wiki/surfaces/profile.md` (Daily Profile NFT Awards)

## Purpose

Automatically queue a Profile NFT generation for accounts that demonstrate verified Task Node work on a given UTC day, so members receive a claimable achievement NFT without manually triggering generation. The server generates an image row; minting still requires the linked wallet to sign. This document is the single source of truth for who is eligible, when the queue fires, what fields drive the award, and how edge cases are handled.

## Eligibility Rules

Eligibility is account-level and computed from `task_projections` rows with `status IN ('completed', 'rewarded')` that are not fixtures. An account is eligible for a given UTC day if **either** threshold is met:

- **Personal-task threshold:** more than 3 completed personal tasks (i.e., `personal_completed_count > 3`, so 4 or more). Personal means the resolved task kind is not `network`.
- **Network-task threshold:** at least 1 completed Network Task (i.e., `network_completed_count >= 1`).

Task kind resolution: `CASE WHEN lower(COALESCE(NULLIF(task_kind, ''), metadata_json->'generatedTask'->>'task_kind', 'personal')) = 'network' THEN 'network' ELSE 'personal' END`. A task counts toward the daily eligibility totals once it reaches `completed` or `rewarded` status; the count is lifetime-style across the projection, and eligibility is re-evaluated each run.

Eligibility reason is recorded on the award row as one of:

- `network_task_completed` — the Network Task threshold was met (preferred when both thresholds are met).
- `personal_task_threshold` — only the personal-task threshold was met.
- `ineligible` — neither threshold met (awards are not created for ineligible accounts).

### Required: active user wallet

A candidate account must have at least one active `pftl_sync_wallets` row with `status='active'` and `role='user'`. The wallet selected is `DISTINCT ON (account_id)` ordered by `priority ASC, updated_at DESC, wallet_address ASC` — i.e., the highest-priority active user wallet. Accounts with no active user wallet are skipped (the generated NFT is wallet-scoped, so there is nowhere to bind it).

## Queue Trigger

- **Worker:** `server/profile-nft-daily-worker.js`, running inside the airdrop/background worker process.
- **Enabled by:** `TASKNODE_PROFILE_NFT_DAILY_WORKER_ENABLED=true` (plus `databaseEnabled()`).
- **Tick interval:** `TASKNODE_PROFILE_NFT_DAILY_INTERVAL_MS` (default 3600000 ms = 1 hour; production is run more frequently via the background worker schedule). First tick after `TASKNODE_PROFILE_NFT_DAILY_INITIAL_DELAY_MS` (default 45000 ms).
- **Batch size per tick:** `TASKNODE_PROFILE_NFT_DAILY_BATCH_LIMIT` (default 5, clamped 1–50).
- **Run date:** UTC calendar day (`dateOnly(now)` = `YYYY-MM-DD` in UTC).
- **Lease:** each tick claims a `board_manager` lease scoped `profile_nft_daily` so only one worker generates at a time; the lease is released on completion or failure.

### Idempotency

One `profile_nft_daily_awards` row per account per UTC day. The candidate query excludes accounts that already have an award for the run date in a terminal or in-progress state:

- `generated`, `running`, or `skipped`; or
- `failed` with `attempt_count >= max_attempts`.

A same-day `pending` or `failed` (below max attempts) award is eligible for retry and is prioritized ahead of new candidates.

### Retry and recovery

- **Max attempts:** `TASKNODE_PROFILE_NFT_DAILY_MAX_ATTEMPTS` (default 3, clamped 1–20).
- **Stale running recovery:** awards stuck in `running` longer than `TASKNODE_PROFILE_NFT_DAILY_STALE_RUNNING_MS` (default 1200000 ms = 20 min; production uses 10 min) are failed by `failStaleRunningDailyProfileNftAwards` so they can retry.
- **Candidate ordering:** retry candidates first, then by `last_completed_at DESC`, then `network_completed_count DESC`, then `personal_completed_count DESC`, then `account_id ASC`.

## Required Input Fields

Each candidate row drives the award and the generation payload:

- `account_id` — the eligible account (also stored on the award).
- `wallet_address` — the selected active user wallet; bound to the generated `profile_nfts` row scope.
- `personal_completed_count` — count of completed personal tasks used for eligibility.
- `network_completed_count` — count of completed Network Tasks used for eligibility.
- `last_completed_at` — most recent completion timestamp; used for ordering and the payload context.

Award row (`profile_nft_daily_awards`) stores: `run_date`, `account_id`, `wallet_address`, `profile_nft_id` (set on success), `status`, `eligibility_reason`, eligibility counts (via `eligibility_json`), `attempt_count`, `error`, and timestamps.

Generation payload (`pf.profile.daily_nft_award.v1`) is built by `buildDailyProfileNftGenerationPayload` and contains: `runDate`, account id, wallet status/address, and an `eligibility` object (`reason`, `personalCompletedCount`, `networkCompletedCount`, `lastCompletedAt`). The prompt context document instructs the image model to celebrate verified Task Node work **without** exposing private task text, wallet secrets, or raw evidence.

## Award Lifecycle and Minting Boundary

Status transitions: `pending` → `running` → `generated` (success) or `failed` (retryable until max attempts; otherwise terminal). `skipped` is a terminal non-retry state.

**Minting is not automatic.** The worker generates a claimable Profile NFT image row only. Daily awards do **not** set `profile_nfts.status='minted'` and do not silently mint. The server cannot complete a user-owned PFTL NFT mint without a wallet signature; the user must still go through `POST /api/profile/nft/mint`, which prepares the transaction and requires the linked wallet to sign before the NFT is chain-minted.

## Assumptions

- Task counts come from `task_projections`, which is the authoritative completed-task view. Projections must be fresh for eligibility to be correct.
- "UTC day" is the run boundary; an account that completes qualifying tasks late in a UTC day but after the last tick of that day is awarded the following UTC day (or on the next retry tick, same run date, if still within retry limits).
- The personal-task threshold is strictly **greater than** 3 (`> 3`), matching "more than three personal tasks." `>= 3` is not eligible on the personal path alone.
- An account may meet both thresholds; the recorded reason is `network_task_completed`.

## Edge Cases

- **No active user wallet:** account skipped entirely; no award created even if task thresholds are met.
- **Multiple active wallets:** highest-priority active user wallet is selected deterministically.
- **Fixture tasks:** excluded from counts via `nonFixtureTaskProjectionSql`.
- **Task reclassified personal↔network after completion:** counts recompute from projections on the next eligible tick; an account can become eligible or ineligible as projections update.
- **Worker crash mid-generation:** `running` award is recovered after the stale window and retried up to max attempts; the underlying `profile_nfts` generation is also recoverable from its own row state (see Profile NFT Generation Recovery).
- **Same account, same day, repeated ticks:** idempotent — no duplicate award; existing same-day terminal/in-progress award blocks a new one.
- **Generation succeeds but mint is never signed:** award is `generated` (terminal for the daily flow); the NFT remains a claimable image row and does not become chain-minted until the user signs.
- **Batch limit lower than candidate count:** remaining candidates are processed on subsequent ticks the same day, subject to idempotency and retry ordering.

## Configuration Reference

| Env var | Default | Clamp | Purpose |
|---|---|---|---|
| `TASKNODE_PROFILE_NFT_DAILY_WORKER_ENABLED` | `false` | — | Enables the worker (requires DB). |
| `TASKNODE_PROFILE_NFT_DAILY_PERSONAL_TASK_THRESHOLD` | `3` | 0–1000 | Personal tasks must exceed this. |
| `TASKNODE_PROFILE_NFT_DAILY_NETWORK_TASK_THRESHOLD` | `1` | 1–1000 | Network tasks must be at least this. |
| `TASKNODE_PROFILE_NFT_DAILY_BATCH_LIMIT` | `5` | 1–50 | Awards per tick. |
| `TASKNODE_PROFILE_NFT_DAILY_MAX_ATTEMPTS` | `3` | 1–20 | Retry cap per award. |
| `TASKNODE_PROFILE_NFT_DAILY_INTERVAL_MS` | `3600000` | 5s–24h | Tick interval. |
| `TASKNODE_PROFILE_NFT_DAILY_INITIAL_DELAY_MS` | `45000` | 5s–24h | Delay before first tick. |
| `TASKNODE_PROFILE_NFT_DAILY_STALE_RUNNING_MS` | `1200000` | 1m–24h | Running award staleness window. |

## Open Items

None blocking. Implementation note: as of this spec the worker and daily-awards repository exist as in-progress code; this document is the reviewable design artifact for that code and any follow-on changes must keep eligibility, idempotency, and the no-auto-mint boundary consistent with the rules above.
