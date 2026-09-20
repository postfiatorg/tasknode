# Task Hive allocation repair — 2026-09-19

Task: `task_5784f3d5514054aa898635058deca548`
Request: `req_12ccca3119c52cc3c6af2534baf7e5bb03d305df86f7eccf7b89bda184be6993`
Repository: `/home/pfrpc/repos/tasknode`

## Outcome and scope

Implemented and deployed the audited allocation repairs. The original nine-day
stalled supervisor round completed with six durable duty results. Three later rounds
completed with 19, 14 and 7 results. Production candidate discovery surfaced all 28
eligible idle contributors instead of 12; board-specific restrictions remain.
The worker reconciled the three exhausted queued requests without resetting their
attempt history. Both historical allocation/canonical-state mismatches were repaired.

At 00:03:22 UTC on September 20, the scoped retry committed for the original
failed intent. At 00:03:48 the same job was generated at lifetime attempt 4
(retry base 3), with request `req_net_fa9868363644ed853dd3535c9d876ed9`.
The downstream task writer was still generating; no new visible offer was claimed
at this cutoff. Completed supervisor rounds include deferred/blocked judgments
and are distinct from allocations.

Code commits, in order:
- `d50a20c45fa185e43acf3a9b9516979df2b46b42` — recovery, complete candidate discovery, typed failures, exhausted queue and mirrors.
- `09a3bd73910c4e56a77947e3c972063e9ea3ad0e` — queue health and guarded explicit retry of failed network intents.
- `624f8733933ddb8095e955005cb60f32b11bc2c3` — preserve the explicit retry flag through scoped command normalization, tested through the real command API.
- `8b973d51766fbecfdbfbe8d6236fcb40dc9e1cbb` — serialize command reads before the PostgreSQL client queue so waiting time cannot exhaust each statement timeout.
- `098892b0cce11531552bcc761e0712b838f90b46` — make Hive job/allocation joins use existing partial indexes; identical results verified on production data.
- `cb6c770d2bce84f80366c66ef16ec00213c7792c` — indexed account-history lookup and migration 143, retaining the original matching predicates.
- `514c787245cfbca8f46873b6de85c309a9935b40` — explicit retry guard conflicts return HTTP 409.
- `d2fa8de1e3000d691ff37c2519552dfa12bf0731` — scoped board commands use a bounded 15-second SQL statement budget; other callers keep their configured defaults.

These are local reviewable commits; no Git push was performed. Unrelated dirty
work was preserved. Per-process overlay images retained the existing deployed
base and replaced only the affected files. Existing Kimi manager, GLM writer,
account scope, wallets, board scopes and task-selection authority were preserved.

## Baseline reproduced and rechecked

The audit at commit `1983d2ea787a874f1f6994f96a9b62f665c4d57d` contains
`audit-reproductions.log`: deterministic supervisor exhaustion at 1/9/30 days,
stable 12-of-13 starvation including a restricted-board member, and the exhausted
queued request that neither claiming, reclaiming nor owner retry repaired.
Its source and production forensics establish the fourth defect: transport/schema
failure was converted into semantic `uncertain`.

Immediately before deployment, `production-before.json` (22:53:49 UTC) and
`host-before.json` reconfirmed:
- Pending round `round_86fafc0f-722c-405f-9b62-1a2eddf70f94`, created September 10, three deliveries and zero results.
- Three queued ordinary requests with three lifetime attempts and no generated offer.
- 868 historical network jobs: 756 published, 112 failed, zero queued/running.
- Five active canonical allocations (three proposed, two accepted); two mirrors incorrectly said proposed.
- Job `nettaskjob_21badcf30df1246fd8ff0ab371491975` failed with `network_task_intent_needs_review`, relationship `uncertain`, but actual cause `inference_response_truncated`.

All eight initially affected live API and worker source hashes matched the
preserved baseline. The original audit remains immutable; its smoke entrypoint
now runs the repaired regression suite rather than asserting broken behavior.

## Implementation and invariants

The supervisor keeps the same pending round and duty-result history. A fresh,
ready terminal receives a bounded recovery delivery after exhausted normal
retries, with cooldowns of 15, 30, 60, 120, 240 and then 360 minutes. Busy or stale
terminals and existing inbox items block delivery. Partial durable progress resets
the retry budget while the delivery sequence stays monotonic. Scoped runtime
status exposes cooldown, attempt count and next retry time.

Candidate discovery scans the complete eligible account universe, with stable
ordering and no first-100/first-12 cutoff. Each round includes all eligible idle
members before board restrictions. Assignment still checks board/work fit,
current wallet, badge, capacity and budget under the existing concurrency guards.

Intent assessment throws typed provider/schema failures with cause, retryability,
provider attempts and timing. Genuine duplicate, uncertain or unactionable
judgments are semantic holds; they are not infrastructure retries. Transient
failures get three attempts per cycle with stale-attempt fencing. The structured
GLM assessment now uses a concise prompt, 8,192 output tokens and 60-second
provider / 120-second total budgets. It does not fall back to synthetic tasks.

The ordinary-request reclaimer marks exhausted queued/published requests failed
only if neither a generated task nor canonical offer exists. It retains lifetime
attempts and diagnostics. Explicit owner retry starts a new bounded cycle and
preserves the original request ID. Owners control whether to retry private work.

Board packets now distinguish current queued/running/awaiting-link counts from
historical failed allocations. A replay of a failed job says explicit recovery
is required instead of falsely claiming successful enqueue. The scoped
`task create --retry-failed` command supports only still-needed pre-request
provider failures: it revalidates routing and capacity under the account lock,
locks the failed job/allocation, checks deterministic request IDs, projections
and Hive references, and preserves job/allocation/intent IDs and lifetime attempts.
Existing requests/offers and genuine semantic holds cannot use this path.
Six concurrent retries produce one requeue; lost-response replay reuses the
immutable scoped command receipt. Dry run makes no mutation.

Canonical lifecycle transitions now synchronize allocation mirrors, including
accepted and submitted transitions. The historical repair locked each canonical
row inside the existing transaction helper and called the same projection sync.
It did not emit lifecycle, reward, acceptance or submission events.

## Production recovery evidence

### Routing, requests and mirrors

`routing-after.json` at 23:00 UTC ran the actual patched discovery and duty
functions: all 28 eligible idle contributors surfaced. Five unrestricted boards
saw the full pool; Task Node Fixes retained its sole permitted contributor.
The local >100-account fixture separately proves 103/103 coverage, including a
restricted member at the end of the list and exclusion after badge revocation.

The following request IDs were reconciled from queued/attempts=3 to
failed/`task_generation_queued_attempts_exhausted`/Retry available, preserving
IDs and attempts:
- `req_7ad873f5e2a06960d8bb01e69b46e0ecb44e19fccc0a4338ab6f165273e018b5`
- `req_ecb611ad-d41a-47cd-b5dc-05e9984eb7bf`
- `req_33dcd976-16c8-4663-b21f-bce376fde608`

At 23:25 the first two remained failed with Retry available. The third had
subsequently become cancelled, still with three lifetime attempts and no generated
task; this repair did not cancel or resubmit that request. This later state must
not be described as a current Retry action for all three. No ordinary requests
remained queued/generating/published in that snapshot.

`mirror-recovery.json` records two repairs, zero remaining divergences:
- `netalloc_1035a4020ba3e3015c3ae481136e6d91` → `task_0378d312d18c5e7d67cf7c2423ec062f`: proposed → accepted.
- `netalloc_2db5317ad15ab45730dea81a11176973` → `task_7e27a8f164b5a71e335e4c0f4713112e`: proposed → accepted.

The existing manager subsequently used its guarded stale-work commands to clear
four eligible inactive offers, leaving one accepted network allocation. It
preserved the accepted task that had not yet reached cancellation eligibility.
These manager decisions are distinct from the mirror-only repair.

### Supervisor and durable progress

The service was restarted with the new source while retaining its terminal,
thread, pending JSON, command receipts and Kimi provider.
- Original round `round_86fafc0f-722c-405f-9b62-1a2eddf70f94`: recovery delivery `_4` at 22:59:35.474; completed 23:06:08.828 with 6/6 results (4 deferred, 2 blocked).
- `round_9d907f60-fe64-4259-ab58-653da6d777ad`: completed 23:11:55.545 with 19/19 results.
- `round_80ec5504-ade9-4bed-ac58-8e4338e86d57`: completed 23:22:19.223 with 14/14 results, including seven Hive escalation replies.
- `round_f4b62e18-95c9-4312-8402-ce1853e28dfc`: seven duties pending at 23:25 while the terminal processed the accepted recovery handoff.

`host-final.json` records the active service, fresh terminal status, unchanged
thread ID, recovery/processed log events and handoff acceptance. The manager
operates under its existing board-manager skill. A resolved escalation reply
is not evidence that the underlying product issue was fixed.

### Provider and worker observations

`live-intent-qualification.json` uses the actual failed job input and 40 prior
board tasks against the repaired assessment code. Vercel/GLM 5.3 returned
independent/actionable/scope-clear in 4,207 ms, with no database mutation.
This establishes one successful current provider call, not publication of a task.

At 23:25, `progress-after.json` showed 756 published historical network jobs,
112 failed historical jobs, no queued/running jobs, no new/recovered jobs and no
new network offers since 22:59. It showed zero new duplicate request-offer groups
in that observation window and zero allocation/canonical mismatches. Historic
duplicate records identified by the audit were retained, not rewritten or claimed
to be eliminated.

The manager initially repeated its obsolete “worker flush” blocker because
historical failed allocation counts were mistaken for pending work. Queue health,
typed/legacy failure details, guarded explicit retry and a factual recovery
handoff address this operational gap. Acceptance receipt:
`operator_hive_allocation_repair_20260919`, 23:22:51.434 UTC.

### Committed recovery — September 20, 00:03–00:05 UTC

The final scoped command `hive_repair_original_intent_21badcf3_20260919`
committed as `boardrun_23309ac3-5545-4a99-b243-00c27d9f969d` in 52,909 ms.
It reused `netintent_21badcf30df1246fd8ff0ab371491975`,
`netalloc_21badcf30df1246fd8ff0ab371491975` and
`nettaskjob_21badcf30df1246fd8ff0ab371491975`.
The worker completed live intent assessment as independent/actionable in 3,192 ms,
advanced lifetime attempts 3 → 4 with retry base 3, and created the deterministic
request `req_net_fa9868363644ed853dd3535c9d876ed9`.
Replaying the same immutable command returned the same board-run and job receipt
in 1,000 ms. No second job or new duplicate offer group appeared.
Network totals became 756 published, 111 failed and 1 generated, with zero
mirror divergences. The generated request was in downstream provider generation
at 00:04:49. Receipt and snapshot files: `original-intent-final-receipt.json`,
`original-intent-replay-receipt.json`, `progress-final.json`.

### Deployment identity

Final API image:
`registry.fly.io/tasknodeofficial-dev:hive-allocation-api-20260919-v7@sha256:17f4f5d7b7cbe044058ba4c8c1eb3142ae5730df80e38c5b86d3ef5dd1d0a723`

Final generation image:
`registry.fly.io/tasknodeofficial-dev:hive-allocation-worker-20260919-v7@sha256:f3f6863a363d32f28ae5a11e8600df041e89b44a3cc73217e540375f1364dec5`

Review image:
`registry.fly.io/tasknodeofficial-dev:hive-allocation-review-20260919@sha256:2211ee5a39c7bc8281255134e2960fad5a386bcd06b38342387b5ecffc2f60b2`

API `8d4930ae156638`, generation `7813e21f1295d8`, review
`6835d0ea464158` are started. Generation standby `e827021fd67708` and review
standby `e826571a546458` carry the matching images and remain stopped.
All 16 affected API and generation source hashes match the tested repair;
review-worker lifecycle source matches as well. See source manifests and
`deployed-machines.json`.

## Exact focused test output

Tests used disposable local PostgreSQL fixture databases
`tasknode_hive_audit_20260919` and `tasknode_routing_repair_20260919`,
database mode enabled and process role web. Production was never used for
mutation fixtures. Each command below exited 0.

### `node scripts/task-hive-allocation-repair-smoke.mjs`

```text
{
  "ok": true,
  "regressions": [
    {
      "case": "supervisor_recovery",
      "pass": true,
      "horizonsDays": [
        1,
        9,
        30
      ],
      "cooldownMinutes": [
        15,
        30,
        60,
        120,
        240,
        360
      ],
      "busyAndStaleTerminalBlocked": true,
      "monotonicDeliveryIds": true
    },
    {
      "case": "typed_intent_failures",
      "pass": true,
      "transportCausesPreserved": true,
      "invalidSchemaRetries": true,
      "authenticationStops": true,
      "semanticJudgmentsPreserved": true
    },
    {
      "case": "complete_candidate_coverage",
      "pass": true,
      "eligible": 103,
      "surfacedOnEveryRound": 103,
      "restrictedLastMemberSurfaced": true,
      "revokedBadgeExcluded": true
    },
    {
      "case": "exhausted_queue_recovery",
      "pass": true,
      "reconciled": "failed",
      "ownerRetry": "queued",
      "lifetimeAttempts": 4,
      "retryCycleAttempts": 1,
      "existingOfferProtected": true
    },
    {
      "case": "durable_retry_policy",
      "pass": true,
      "providerAttemptsBoundedAt": 3,
      "semanticHoldAttempts": 1,
      "staleAttemptsFenced": true,
      "typedCausePersisted": true
    }
  ],
  "productionMutations": 0
}
```

### `node scripts/network-task-explicit-retry-smoke.mjs`

```text
(node:856048) DeprecationWarning: Calling client.query() when the client is already executing a query is deprecated and will be removed in pg@9.0. Use async/await or an external async flow control mechanism instead.
(Use `node --trace-deprecation ...` to show where the warning was created)
{"ok":true,"historicalFailuresNotPending":true,"explicitRecoveryRequired":true,"concurrentRetries":6,"requeues":1,"durableIdsPreserved":true,"lifetimeAttempts":6,"retryBudget":3,"semanticHoldProtected":true,"existingRequestProtected":true,"capacityAndBadgeRechecked":true,"scopedCommandDryRun":true,"lostResponseReplayed":true}
```

### `node scripts/task-generation-reliability-smoke.mjs`

```text
task generation reliability smoke ok
```

### `node scripts/network-task-generation-recovery-smoke.mjs`

```text
network task generation recovery smoke ok
```

### `node scripts/network-task-capacity-smoke.mjs`

```text
network task capacity smoke ok: includes six concurrent last-slot requests
```

### `node scripts/network-task-direct-intake-smoke.mjs`

```text
Direct network intake passed: no encryption RPC, actual Kimi need, current linked wallet, full owned context, typed continuation, duplicate/uncertain hold, stale assessment rejection.
```

### `node scripts/board-agent-reliability-smoke.mjs`

```text
{"ok":true,"concurrentRetries":10,"scopedDenial":true,"nestedRollback":true,"boards":6,"structuredReadiness":true}
```

### `node scripts/task-intent-assessment-smoke.mjs`

```text
{"ok":true,"classifierCallsForParaphrases":2,"inventedReferencesRejected":true,"malformedResponseConservative":true,"note":"Contract fixture; live semantic accuracy is a separate evaluation."}
```

### `node scripts/bm-runtime-harness-smoke.mjs`

```text
{"ok":true,"boards":6,"readiness":"structured","busyPreserved":true,"pendingResume":true,"scopedEnvironment":true,"partialProgress":true}
```

### `node scripts/offchain-task-lifecycle-smoke.mjs`

```text
offchain-task-lifecycle-smoke ok
```

### `node scripts/network-task-recovery-smoke.mjs`

Complete output is in `network-task-recovery-smoke.log`; final line:

```text
network task recovery smoke ok
```

### `node scripts/board-routing-staleness-smoke.mjs`

```text
{"ok":true,"fullBoardRouting":true,"boardRestrictionsPreserved":true,"staleAcceptedAndVerificationDuties":true,"protectedStatesAndActivity":8,"concurrentActivityFenced":true,"scopedEvidenceRead":true,"missingEvidenceBlocksRejection":true}
```

The pg warning above records the earlier fixture run. Live command recovery exposed
its practical consequence: parallel reads queued on one transaction connection
consumed the client timeout before execution. The final pool repair serializes
reads before entering the client queue, retains per-statement timeout enforcement
and drains issued reads before commit/rollback. Final scoped command runs pass
without that warning.

### Additional live-command regressions

The first real manager-selected retry returned a non-commit response, including
when replayed with the same immutable request key. Rollback-only probes exposed
two production-scale read defects before any retry could mutate a job:
1. `Query read timeout` on ordinary account reads queued on the shared command
   connection. The new command-queue fixture fails before the repair and passes
   after it, while a single over-budget SQL statement still fails and rolls back.
2. After that fix, the Hive task-reference query itself exceeded the 5-second
   execution limit. Its lateral joins omitted predicates needed to select existing
   partial indexes. Adding explicit nonempty IDs changed no routing semantics.
   A repeatable-read, read-only production comparison returned all 143 identical
   rows: original 6,323 ms, repaired 1,676 ms including result transfer. Both row
   hashes were `a83014d1e896333ef9fa3f805002e8551854c96418f5a8e1552262cd31abb243`.
   The repaired EXPLAIN ANALYZE execution was 35.015 ms. No new index or schema
   migration was needed. See `hive-query-equivalence.json`,
   `hive-query-qualified.json` and rollback probe artifacts.

A further live rollback trace isolated the account-history query, which scanned
board-run JSON across an OR over the joined tables. Migration 143 added two GIN
indexes; an indexed candidate-run CTE keeps the original account/wallet filter as
final authority. Four read-only production comparisons (account+wallet, account,
wallet, no-match) returned identical hashes/rows: 8, 8, 8, 0. Before/after times
were 10,562/4,716 ms; 10,241/1,203 ms; 3,918/163 ms; 2,635/11 ms.
The subsequent EXPLAIN ANALYZE took 89.298 ms. These are observed samples, not
latency guarantees. Migration applied at 23:48:11.898 UTC; see
`history-index-migration.json`, `history-query-equivalence.json` and
`history-fix-retry-smoke.log`. No historical task data was rewritten.

A subsequent rollback-only reservation probe confirmed the original job could be
requeued with every durable ID preserved. The manager's shortened description
had a different intent hash, so it correctly failed the exact-match guard. The
operator restored the full stored need and used a new immutable command key.
That mismatch now returns HTTP 409 instead of a misleading generic 500.
Remaining cold snapshot variability is handled by a bounded 15-second per-SQL
budget for scoped board commands. The global/default API budget is unchanged;
the queue fixture proves explicit budgets are honored and still reject over-budget
statements. No reservation rule, semantic judgment or duplicate guard is bypassed.

Exact final checks (all exit 0):
```text
node scripts/command-transaction-queue-smoke.mjs
{"ok":true,"concurrentReads":24,"statementTimeoutMs":500,"commandExceedsSingleStatementTimeout":true,"slowStatementStillRejected":true,"connectionReusableAfterRollback":true,"scopedBudgetHonored":true,"scopedBudgetStillBounded":true}
node scripts/board-agent-reliability-smoke.mjs
{"ok":true,"concurrentRetries":10,"scopedDenial":true,"nestedRollback":true,"boards":6,"structuredReadiness":true}
node scripts/network-task-explicit-retry-smoke.mjs
{"ok":true,"historicalFailuresNotPending":true,"explicitRecoveryRequired":true,"concurrentRetries":6,"requeues":1,"durableIdsPreserved":true,"lifetimeAttempts":6,"retryBudget":3,"semanticHoldProtected":true,"existingRequestProtected":true,"capacityAndBadgeRechecked":true,"scopedCommandDryRun":true,"changedIntentConflict":true,"lostResponseReplayed":true}
node scripts/hive-secretary-project-views-smoke.mjs
hive secretary and project views smoke ok
```

The first three final checks also passed from the exact isolated committed tree
after the pool repair (`staged-final-*.log`). The main allocation regression
suite passed again after that change. Production images incorporate both fixes.

Seven focused suites were also run from an isolated checkout-index snapshot of
the first repair commit, and the scoped explicit-retry suite was rerun from the
exact final committed tree. Their `staged-*.log` files are retained.
`npm run lint`, `npm run format-check` and diff checks passed. The last scoped
command-normalizer change also passed targeted ESLint and the real API fixture.

## Recovery and rollback

Operator runbook: `docs/wiki/architecture/task-hive-allocation-recovery.md`.

For further recovery, inspect current queue status and fresh board packets;
revalidate the actual need before retrying a legacy provider failure. Use the
scoped command dry run before execution. Preserve task/round/job/request IDs,
receipts and lifetime attempt counts. Never turn semantic holds into automatic
provider retries. Private request owners initiate their own Retry action.

Rollback per process to the recorded prior base, preserving unrelated deployment
state:
- API: `registry.fly.io/tasknodeofficial-dev:decisions-context-memory-20260919@sha256:5008851b189a96bb033d28ff816bc454d9298b5d0ba0921b82c9aa196b780d0c`.
- Generation: `registry.fly.io/tasknodeofficial-dev:task-step-readiness-20260916@sha256:ee2d49c37ec2707e19a43eb8689a7490040939223614e80e1c433f722feb34a9`.
- Review: `registry.fly.io/tasknodeofficial-dev:deployment-01M29XS3HAAT42NSQBHV58YWRG`.

Use `flyctl machine update MACHINE -a tasknodeofficial-dev --image IMAGE --yes`;
add `--skip-start` for stopped standbys. Restore the supervisor file from
`1983d2ea` and restart only `tasknode-kimi-supervisor.service` if needed.
Keep pending rounds, inbox receipts, duty results, projections and attempt counts.
Do not reverse correct mirrors or reset exhausted failures to queued; that
recreates the incident. Migration 143 adds only two lookup indexes; retain them
and its migration marker during an application rollback. They do not change
canonical task state or attempt history.

## Limits

This repair proves deployed behavior, complete candidate visibility, recovered
manager progress, bounded retry contracts and one successful live intent call.
The final cutoff proves a committed retry and generated request, while downstream
offer publication remains pending.
Task selection, existing work, source availability, board restrictions and future
provider quotas can still prevent a proposal. The retained historic 429s do not
establish a present outage: fresh Kimi execution and GLM qualification succeeded.
Production observations are time-bounded, not a guarantee of future throughput.
