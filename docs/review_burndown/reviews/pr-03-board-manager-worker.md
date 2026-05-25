# PR-03 Review: Board Manager Worker, Leases, Actions, And Audit

Date: 2026-05-25
Branch: `review/03-board-manager-worker`
Base: `origin/main` @ `d01d391`

## Summary

Reviewed the Board Manager scheduler, dedicated worker process, scope lease, action
hooks, run audit trail, decision provider integration, and Hive feed projection.
The design correctly serializes mutations on `global_hive` via a scope lease inside
`board-manager-model-exec.mjs`, enforces rolling action budgets, idempotent job
enqueue, and records decision reason, confidence, digest, action results, and
micro-summaries. Action hooks are validated and covered by database smokes.
Provider failures are persisted as failed runs rather than disappearing.

No P0 defects found. Two P1 gaps are operational/doc drift (lease heartbeat,
undelivered legacy messages). Merge is recommended after integration owner
re-runs DB-backed smokes.

## Review Questions

### Is only one manager allowed to mutate the same board scope at a time?

**Yes, at execution time.** `claimBoardManagerLease` (`server/repositories/board-manager.js:835-886`) uses a unique `scope` row with conditional `ON CONFLICT` — a second manager cannot take an active, unexpired lease unless it holds the same `manager_id`. `scripts/board-manager-model-exec.mjs` claims the lease before starting a run and releases it in `finally`.

The worker (`scripts/board-manager-worker.mjs`) claims **jobs**, not the lease directly. If two Fly `board-manager` machines claim different jobs, the second model exec fails with `board_manager_lease_unavailable` and the job is deferred — mutations remain serialized, but with extra retry churn.

The daily airdrop worker also uses the `global_hive` lease (`server/profile-daily-airdrop-worker.js:207-218`), coordinating internal audit runs with the Board Manager.

### Do job claims, leases, and action budgets prevent duplicate project/task/user messages?

**Mostly yes.**

- Job claims: `FOR UPDATE SKIP LOCKED` on `board_manager_jobs` (`board-manager-scheduler.js:342-371`).
- Periodic ticks: idempotency key `periodic_tick:{scope}:{dueAt}` prevents duplicate tick jobs.
- Post-action follow-up: idempotency key `post_action_followup:{scope}:{runId}` (`board-manager-worker.mjs:148`).
- Network tasks: digest-based idempotency in `enqueueNetworkTaskGenerationFromBoardDecision` (`network-tasks.js:365-399`); smoke verifies second call returns `idempotent: true`.
- Action budget: `max_actions_per_hour` enforced before claim; excludes `do_nothing`, `daily_airdrop`, and empty action (`board-manager-scheduler.js:325-340`).

**Residual:** No per-user message dedup within the hourly budget — repeated `message_user` to the same account is possible up to the cap (P2). `create_project` uses `ON CONFLICT DO UPDATE`, which can refresh an existing project id instead of failing (P2).

### Does every run produce an auditable reason, confidence, input digest, action result, and micro-summary?

**Yes for recorded model runs.** `startBoardManagerRun` stores `source_packet_digest` and full packet JSON. `completeBoardManagerRun` writes `decision_json` (reason, confidence, payload). `recordBoardManagerActionResult` + `refreshBoardManagerRunMicroSummary` populate `board_manager_action_results` and `micro_summary_json` / `micro_summary_text`. `formatBoardManagerAgentRun` exposes these to `/api/hive` feed.

Skipped scheduler jobs (recent-run dedup) complete with result JSON but no run row — intentional and visible in job status.

### Does a no-action run explain why no action was chosen?

**Yes.** Prompt (`prompts/hive/board_manager_v1.md`) constrains when `do_nothing` is valid using `boardActionPressure`. Feed formatting uses `payload.summary`, `decision.reason`, and micro-summary text (`board-manager-run-summary.js:42-44`). Postgres evidence: recent `global_hive` `do_nothing` runs include full reason text (e.g. `boardrun_9bedc5f9-28e2-445f-9670-735e3aa17805`).

### Action hook validation and provider failures in feed?

**Validation:** `normalizeBoardManagerDecision` rejects unknown actions (422). Each hook throws on missing required fields; failures are recorded in `board_manager_action_results` before rethrow (`board-manager-actions.js:540-547`).

**Provider failures:** `board-manager-model-exec.mjs:235-242` completes the run as `failed` with error text. Feed items surface `run.error` and `state: failed` via `formatBoardManagerAgentRun`.

## Findings

### P0

None.

### P1

1. **Lease heartbeat documented but not implemented during runs**
   - **File/line:** `docs/wiki/plans/board-manager.md:122`, `server/repositories/board-manager.js:835-904`
   - **Severity:** P1 (failover / doc accuracy)
   - **Impact:** Plan says workers "release or heartbeat the lease." Code only sets `heartbeat_at` on claim and release. A run longer than `TASKNODE_BOARD_MANAGER_LEASE_SECONDS` (default 900s) could allow a second manager to claim after expiry while the first is still executing.
   - **Verification:** Grep shows no lease renewal between claim and release; TTL default 900s in model exec.
   - **Fix:** Deferred — add periodic heartbeat during model exec or align docs with claim/release-only behavior.

2. **Worker does not pre-check lease before claiming jobs**
   - **File/line:** `scripts/board-manager-worker.mjs:159-220`, `docs/wiki/plans/board-manager.md:115`
   - **Severity:** P1 (operational noise)
   - **Impact:** Plan says "claim the scope lease or defer the job." Worker claims jobs first; lease contention surfaces only after spawning model exec, causing defer/retry cycles on multi-machine deploys.
   - **Verification:** Read worker loop — no `claimBoardManagerLease` call; model exec enforces lease.
   - **Fix:** Deferred — optional pre-flight lease check before `claimBoardManagerJob`.

3. **Legacy undelivered user messages without repair path**
   - **File/line:** `scripts/board-manager-message-delivery-repair.mjs:38-118`
   - **Severity:** P1 (user-visible delivery gap)
   - **Impact:** Local DB has 4 `board_manager_user_messages` rows with empty `chat_message_id`; repair script skips them with `source_conversation_not_found` (no resolvable Hive chat route).
   - **Verification:** `node scripts/board-manager-message-delivery-repair.mjs` → `candidateCount: 4`, all skipped.
   - **Fix:** Deferred to PR-04 (Hive chat routing) or manual archive of orphan rows.

### P2

1. **Board Manager is not started from `background-workers.js`**
   - **File/line:** `server/background-workers.js`, `fly.toml:10`, `package.json:start:board-manager`
   - **Severity:** P2
   - **Impact:** Local Docker `all` role does not run the Board Manager worker unless the separate container/process is started. Production uses dedicated Fly `board-manager` process — intentional split but easy to miss locally.
   - **Fix:** Documented; matches deployment plan.

2. **`process-role.js` does not recognize `board-manager` role**
   - **File/line:** `server/process-role.js:1-16`
   - **Severity:** P2
   - **Impact:** `TASKNODE_PROCESS_ROLE=board-manager` is set in worker spawn env but not classified in `tasknodeProcessRole` helpers. Harmless today because the worker is standalone.
   - **Fix:** Deferred.

3. **`create_project` upserts on conflict instead of failing**
   - **File/line:** `server/board-manager-actions.js:270-290`
   - **Severity:** P2
   - **Impact:** Reused project id silently updates title/summary rather than rejecting duplicate creation.
   - **Fix:** Deferred — idempotency may be intentional for retries.

4. **No per-target message throttle**
   - **Severity:** P2
   - **Impact:** Hourly action cap limits total mutations but not repeated `message_user` to one account within the window.
   - **Fix:** Deferred.

## What Looks Correct

- Scope lease serializes model execution on `global_hive`; daily airdrop shares the same scope safely.
- Scheduler: idempotent enqueue, stale job recovery, rate limiting with `daily_airdrop` exclusion, recent-run skip for reward follow-up.
- Action hooks: create/assign/message/archive/project-doc/network-task paths validated by `board-manager-action-hooks-smoke.mjs` (8 action results, feed audit cards).
- Decision provider: structured JSON schema, OpenRouter + OpenAI paths, failures recorded on run row.
- Secretary packet path compacts source with digest stability (`board-manager-secretary-packets.js`).
- Public feed filters smoke/internal runs (`internalRunFilterSql` in `board-manager.js:377-380`).
- Fly topology: dedicated `board-manager` process separate from API background workers.

## Checks Run

```bash
npm ci
DATABASE_URL=postgresql://tasknodeofficial:tasknodeofficial@127.0.0.1:5436/tasknodeofficial \
  TASKNODE_DATABASE_ENABLED=true npm run board-manager-scheduler-smoke   # pass
DATABASE_URL=... TASKNODE_DATABASE_ENABLED=true \
  node scripts/board-manager-action-hooks-smoke.mjs                     # pass
node scripts/board-manager-v0-smoke.mjs                                 # pass
DATABASE_URL=... node scripts/board-manager-message-delivery-repair.mjs # pass (4 legacy skips)
git diff --check origin/main...HEAD                                     # pass (after review commit)
```

Without `DATABASE_URL`, scheduler and action-hook smokes skip with `database not configured`; v0 smoke still passes offline.

Manual evidence:

- Postgres: `boardrun_9bedc5f9-28e2-445f-9670-735e3aa17805` — `global_hive`, `do_nothing`, reason + micro-summary + digest present.
- Action-hook smoke run `boardrun_97a08052-864e-4f06-bec9-1bb8fbacfd36` — 8 action results including network task idempotency.
- Message repair: 4 orphan delivery candidates documented (not applied).

## Residual Risks

- Multi-machine deploys may defer jobs on lease contention until backoff clears.
- Long-running model/codex sessions could outlive lease TTL without heartbeat.
- Orphan user messages remain undelivered until Hive chat routing is resolved (PR-04 boundary).
- Live OpenRouter/DeepSeek paths require API keys; not exercised in this review run.

## Merge Recommendation

**Merge** after integration owner re-runs DB-backed smokes (`board-manager-scheduler-smoke`, `board-manager-action-hooks-smoke`) with Postgres configured, plus `npm run quality` on this branch.

---

```text
Review PR: PR-03
Boundary: Board Manager worker, leases, actions, audit
Branch: review/03-board-manager-worker
Changed files:
  docs/review_burndown/reviews/pr-03-board-manager-worker.md
  docs/review_burndown/burndown.md
Findings:
- P0: none
- P1: lease heartbeat not implemented; worker lacks lease pre-check; 4 undeliverable legacy messages
- P2: separate Fly process vs background-workers; process-role gap; create_project upsert; no per-user message throttle
Fixes included: none (review-only)
Checks run: scheduler-smoke, action-hooks-smoke, v0-smoke, message-delivery-repair, git diff --check
Manual app evidence: Postgres run rows with reason/micro-summary; action-hook smoke 8 results
Residual risks: lease TTL on long runs; orphan messages; multi-machine defer churn
Merge recommendation: merge after integration owner re-runs DB smokes + quality
```
