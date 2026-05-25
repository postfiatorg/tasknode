# PR-05 Review: Network Task Lifecycle And Recovery

Date: 2026-05-25
Branch: `review/05-network-task-lifecycle`
Base: `origin/main` @ `d01d391`

## Summary

Reviewed network task restart recovery, Hive projection mirroring, reward follow-up
scheduling, and the Python lifecycle replay fixture. Recovery is deterministic for
active states: it repairs stale Hive mirrors from canonical `task_projections`,
never signs user transitions, and gates worker resume on `metadata_json.workers.*.published`.
Reward follow-up is idempotent and skips when a Board Manager run already completed
after the reward timestamp. Smoke tests and the lifecycle replay fixture pass against
local Docker Postgres.

## Findings

### P0

None.

### P1

1. **`syncNetworkTaskProjections()` is documented but not wired into Hive reads**
   - **File/line:** `server/repositories/network-tasks.js:975-998`, `server/repositories/hive-projects.js:412-479`, `docs/wiki/plans/making-functional-network-tasks.md:205`
   - **Severity:** P1
   - **Impact:** Hive project cards can stay stale until a per-task event triggers `syncNetworkTaskProjection` or an operator runs `npm run network-task-recovery`. The wiki claims batch reconciliation runs before Hive reads; it does not today.
   - **Verification:** Grep shows `syncNetworkTaskProjections(` is exported but never called from server routes; `getHiveProjectsDocument()` reads `network_project_task_refs` directly.
   - **Fix:** Call `syncNetworkTaskProjections({ limit })` at the start of `getHiveProjectsDocument()` (or a narrow Hive route wrapper) with a bounded limit.

2. **Duplicate-published worker guard is documented but not smoke-tested**
   - **File/line:** `server/network-task-recovery.js:85-131`, `scripts/network-task-recovery-smoke.mjs:66-74`
   - **Severity:** P1 (test gap against stated done criteria)
   - **Impact:** Recovery smoke seeds `published: "false"` for worker resume cases only. A regression that ignores `metadata_json.workers.*.published` would not fail CI.
   - **Verification:** Smoke asserts `willPublish=true` for submitted/review-pending fixtures; no fixture with `published: "true"` expecting `willPublish=false` and `await_*_projection` next actions.
   - **Fix:** Extend recovery smoke with two tasks where worker metadata is already published and assert no resume/publish intent.

3. **`npm run network-task-lifecycle-fixture` fails on a clean checkout without Python deps**
   - **File/line:** `package.json:30`, `reference_clients/python/pyproject.toml:6-15`
   - **Severity:** P1 (review/CI friction)
   - **Impact:** Fixture exits with `ModuleNotFoundError: mnemonic` (and `xrpl` after mnemonic) when Python reference deps are not installed. Reviewers must discover and install deps manually.
   - **Verification:** Bare `npm run network-task-lifecycle-fixture` failed until a local venv installed `mnemonic`, `xrpl-py`, etc.; fixture then passed.
   - **Fix:** Document a one-liner in the npm script or README (e.g. `pip install -e reference_clients/python`) or add a small wrapper that checks/installs reference deps.

### P2

1. **Recovery row query can duplicate tasks when multiple generation jobs match**
   - **File/line:** `server/network-task-recovery.js:201-208`
   - **Severity:** P2
   - **Impact:** The `LEFT JOIN` on `network_task_generation_jobs` uses OR on `task_id` and `request_id`. Multiple historical jobs for the same task could inflate `checked` counts and repeat mirror sync work.
   - **Verification:** Code review; normal happy path has one published job per task.
   - **Fix:** Prefer `DISTINCT ON (refs.task_id)` or join only the latest published job.

2. **Zero-reward and terminal-state recovery paths lack automated coverage**
   - **File/line:** `shared/task-lifecycle.js:185-187`, `server/network-task-recovery.js:5-12`
   - **Severity:** P2
   - **Impact:** Zero-PFT decisions map directly to `rewarded` (no `pf.reward.v1`), which correctly excludes tasks from active recovery. Refused/failed allocation states are also outside the active set. Behavior is sound but unproven in smoke.
   - **Verification:** Python reducer test covers zero reward; JS recovery smoke does not include refused or zero-reward fixtures.
   - **Fix:** Optional fixture rows for refused and zero-reward rewarded tasks asserting `ignore_non_active_state` or no worker resume.

3. **Manual UX forensics evidence not captured in this pass**
   - **File/line:** spec `recent_work_pr_review_spec_2026-05-24.md#pr-05` manual evidence
   - **Severity:** P2
   - **Impact:** DB smokes prove mirror sync and follow-up scheduling, not rendered task detail or Hive card parity.
   - **Verification:** No browser screenshots or live task IDs recorded.
   - **Fix:** Deferred to integration verification; not a code defect.

## Boundary Assessment

| Review question | Result |
| --- | --- |
| Active tasks recover without duplicate user/worker transitions? | **Yes** — recovery syncs mirrors and classifies next action; worker resume respects `published` metadata; review worker claims are stale-aware and idempotent. |
| Distinguishes allocation failure, refused, zero reward, paid reward? | **Partial** — canonical reducer and `task-reward-outcome.js` encode zero vs paid reward; recovery only operates on active statuses and does not conflate them, but automated tests do not cover terminal/refused paths. |
| Task list and detail share projection state? | **Yes** — both read `task_projections`; import/replay calls `syncNetworkTaskProjection`. |
| Reward triggers Board Manager follow-up without duplicate runs? | **Yes** — idempotency key on task + last reward tx/cid; 2-minute delay; skip if recent completed run after reward timestamp (smoke-proven). |
| Forensics show event IDs, CIDs, txs, ledgers, reward amounts? | **Yes** in task detail path via `task_events` and projection fields; recovery logs include latest evidence CID/tx. |
| Stale projections repaired from full event set? | **Per-task yes** via reducer replay into `task_projections`; Hive batch repair helper exists but is not invoked on Hive reads (P1 above). |
| Hive uses same projection as Tasks? | **Yes when synced** — `syncNetworkTaskProjection` copies `task_projections.status` into refs/allocations; drift possible until sync or recovery runs. |

## Checks Run

```bash
npm ci
npm run network-task-lifecycle-fixture   # after local venv: pip install mnemonic xrpl-py requests base58 Pillow pypdf
DATABASE_URL=postgres://tasknodeofficial:tasknodeofficial@localhost:5436/tasknodeofficial \
  TASKNODE_DATABASE_ENABLED=true \
  node scripts/network-task-recovery-smoke.mjs
DATABASE_URL=postgres://tasknodeofficial:tasknodeofficial@localhost:5436/tasknodeofficial \
  TASKNODE_DATABASE_ENABLED=true \
  node scripts/network-task-reward-followup-smoke.mjs
git diff --check
```

Lifecycle fixture evidence:

- Fixture `network_task_lifecycle_replay_v1` replayed offer → accept → submit → review → reward.
- Final status `rewarded`, `reward_actual_pft: 12000`.

Recovery smoke evidence:

- Three active tasks (accepted, submitted, verification_response_submitted) recovered.
- Mirrors repaired: `proposed->accepted`, `accepted->submitted`, `verification_requested->verification_response_submitted`.
- Submitted/review tasks classified for worker resume with evidence CID/tx preserved.

Reward follow-up smoke evidence:

- First sync enqueued `network_task_rewarded_followup` with 120s delay after reward event.
- Duplicate sync skipped with `reward_followup_already_recorded`.
- Recent Board Manager run after reward skipped new enqueue (`recent_board_manager_run_after_reward`).

## Residual Risks

- Hive reads may show stale task state until batch sync is wired or recovery is run.
- Duplicate-published worker guard relies on metadata discipline; lacks regression smoke.
- Python fixture deps are outside `npm ci`; clean environments need explicit setup.
- `npm run route-smoke` from the spec was not re-run in this pass.

## Merge Recommendation

**Merge** after integration owner confirms Hive batch sync follow-up (P1 #1) is tracked or fixed, and re-runs recovery/reward smokes on the integration branch. No application-code changes are required on this review branch unless the team chooses to land the P1 test/sync fixes here.

---

```text
Review PR: PR-05
Boundary: Network task lifecycle, recovery, reward follow-up, projections
Branch: review/05-network-task-lifecycle
Changed files:
  docs/review_burndown/reviews/pr-05-network-task-lifecycle.md
  docs/review_burndown/burndown.md
Findings:
- P0: none
- P1: syncNetworkTaskProjections not wired to Hive reads; duplicate-published guard untested; Python fixture deps not bootstrapped by npm
- P2: recovery JOIN may duplicate rows; zero-reward/refused paths untested in smoke; no manual UX forensics
Fixes included: none (review-only branch)
Checks run: network-task-lifecycle-fixture, network-task-recovery-smoke, network-task-reward-followup-smoke, git diff --check
Manual app evidence: DB/smoke only; no browser task detail or Hive card screenshots
Residual risks: Hive mirror drift; worker published metadata regression untested; Python dep setup
Merge recommendation: merge review PR; track Hive batch sync and duplicate-published smoke as follow-ups
```
