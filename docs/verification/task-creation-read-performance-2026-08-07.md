# Task creation database read performance — 2026-08-07

## Scope

This packet covers the three reads exercised by `scripts/task-creation-read-timing.mjs`:

- `getHiveProjectsDocument({ includeEmptyActive: true })`
- `getNetworkTaskContentSnapshot({ completedLimit: 4, outstandingLimit: 8, stoppedLimit: 4, pendingLimit: 4 })`
- `recentBoardManagerRuns({ limit: 20 })`

Both timing runs used the live Task Node database from the `worker-taskgen` Fly machine with `DATABASE_STATEMENT_TIMEOUT_MS=10000`, the role-default six-connection pool, five measured rounds, two simultaneous packet builds per round, and one warmup round. Each table therefore contains 10 samples per read.

## Before and after

Baseline commit: `46895c3cc63f7a0c9f63063fed286d5b3871ceaa` (timing harness only, before the read fixes).

Post-fix code commit: `5a73dd1`.

Command used for both archives:

```bash
node scripts/task-creation-read-timing.mjs \
  --iterations 5 \
  --concurrency 2 \
  --warmup 1 \
  --commit <commit> \
  --json
```

| Read | Baseline median | Baseline p95/max | Baseline timeouts | Post-fix median | Post-fix p95/max | Post-fix timeouts |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `getHiveProjectsDocument` | 4832.15 ms | 7449.87 ms | 0 | 3118.16 ms | 5188.38 ms | 0 |
| `getNetworkTaskContentSnapshot` | 5359.07 ms | 8799.73 ms | 0 | 2714.72 ms | 5177.20 ms | 0 |
| `recentBoardManagerRuns` | 3119.34 ms | 4725.52 ms | 0 | 2493.42 ms | 3347.52 ms | 0 |

Every measured post-fix read stayed below the configured 10,000 ms query timeout.

The live database is noisy: one earlier exact post-fix run overlapped broader database contention and recorded three network-content statement timeouts even though the rewritten query's isolated execution plan was 15.335 ms. The table above is the subsequent identical run from the same immutable archive. The change removes the query-specific costs described below; it does not claim to eliminate unrelated database-wide saturation.

## Data equivalence

The timing harness hashes stable packet shapes rather than timestamp fields. Every read produced exactly one digest in both runs, and the baseline/post-fix digests match:

| Read | Baseline and post-fix digest |
| --- | --- |
| `getHiveProjectsDocument` | `c09538332990cfdf06606fa20fefd246e1fae4867ade7282da4fd554cd7153e3` |
| `getNetworkTaskContentSnapshot` | `39f77566b019c6ba46006f45d115752a9c2d0954ccb3ffdb8b9180dd0a51abaf` |
| `recentBoardManagerRuns` | `342cccaed9e9cbcaff899933a4da00bcfba322b63fbbdeb56c2a434b27b13c3c` |

A production cardinality check found 662 Network Task refs, 660 matched job rows, zero refs with more than one matched job, and a maximum match count of one. The rewritten `UNION` CTE also preserves the old `OR` join's de-duplication if a job matches both identifiers.

## EXPLAIN findings

### Hive project document

Before:

- planning: 59.098 ms
- execution: 239.440 ms
- 23,048 shared-buffer hits
- the ranked lateral job/allocation lookups repeatedly scanned the same small tables for each of 46 refs (`network_task_generation_jobs`: 46 loops; `network_task_allocations`: 46 loops)

After:

- planning: 6.641 ms
- execution: 8.211 ms
- 1,910 shared-buffer hits
- materialized candidate CTEs perform set-based joins once, then retain the original task/request/metadata rank and newest-row tie breakers

`getHiveProjectsDocument` also now checks out one pool client and reuses it for its component reads. This removes repeated pool acquisition and prevents one logical Hive read from consuming all six worker connections at once. It is intentionally not a transaction, so optional-read fallback behavior is unchanged if one optional query fails.

### Network Task content

Before:

- planning: 1.745 ms
- execution: 891.908 ms
- the `OR` join materialized 682 generation-job rows for each of 662 refs, producing the dominant nested-loop cost

After:

- planning: 29.766 ms
- execution: 15.335 ms
- a materialized ref set and two equality joins build the matched `(ref_id, job_id)` set once; `UNION` preserves the former `OR` join's row semantics

### Recent Board Manager runs

A separate EXPLAIN found a 1,283.834 ms execution: PostgreSQL sequentially scanned 15,490 `board_manager_runs` rows and sorted them because the existing recent index begins with `scope`, while this read is global. Migration `105_board_manager_runs_global_recent.sql` adds `(started_at DESC, id DESC)` for that access pattern. The production timing above predates deployment of that migration.

## Validation

Passed locally:

```text
npm run board-manager-smoke
npm run hive-project-planning-smoke
npm run hive-context-smoke
npm run hive-public-identity-smoke
npm run board-manager-capability-profile-smoke
npm run migration-registration-smoke
npm run format-check
git diff --check
```

`npm run board-manager-source-packet-smoke` exited successfully but reported its expected `database not configured` skip locally. The live timing harness is the database-backed packet-read validation.
