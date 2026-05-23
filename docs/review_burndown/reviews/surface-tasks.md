# Review Plan: Tasks (Evidence / Reward Pass)

Source doc: `docs/wiki/surfaces/tasks.md`
App doc group: Surfaces
App doc slug: `tasks`
Review status: complete
Code review complete: yes
Owner: agent
Last updated: 2026-05-23
Branch: `review/tasks-evidence-reward` (Phase 1 pass; findings-only on `origin/main`)

## Scope

- Tasks UX state vs `task_projections`
- Evidence submission and multiple-evidence behavior
- Verification request/response flow
- Reward decision vs reward payment
- Forensics readability and completeness
- Worker/reducer projection consistency

## Important App Surfaces

- `src/main.jsx` / TasksView polling
- `src/features/tasks/TaskDetailModal.jsx`, `TaskForensicsPanel.jsx`, `task-evidence-drafts.js`
- `server/repositories/tasks.js`, `server/task-routes.js`
- `server/task-submission.js`, `server/task-evidence-processing.js`
- `server/task-review-worker.js`, `server/task-reward-outcome.js`
- `server/pftl-cache-reducer.js`, `server/task-event-meaning.js`
- `shared/task-lifecycle.js`

## Completion Checklist

- [x] Source doc claims mapped to implementation.
- [x] User-visible workflow reviewed (static + API read paths).
- [x] Persistence and ownership boundaries reviewed.
- [x] Billing, provider, wallet, or chain effects reviewed where applicable.
- [x] Targeted smoke evidence recorded.
- [x] Findings written with realistic severity.

---

## Findings

### 1. P1 — Task list polling re-reads Postgres only; it does not trigger chain sync

**Files:** `src/main.jsx:2583-2588`, `server/app-state.js` (via `listTaskState`), `server/repositories/tasks.js:432-459`

**What happens:** While `taskSync.requiresRefresh` is true (review-loop tasks or active requests), TasksView calls `onRequestSettled()` → `refreshAppState()` every 2.5s. That path re-queries `task_projections` only. It does not call PFT wallet sync or the cache reducer.

**Impact:** After evidence submit, the user can poll aggressively and still see stale tabs until background PFT workers catch up. Server already computes `sync.status` values `indexing_lag` and `reducer_attention` (`tasks.js:444-458`), but the UI never reads them (grep: no `indexing_lag` / `reducer_attention` in `src/`).

**Fix:** Either (a) surface `tasks.sync.status` in Tasks UI with honest copy, and/or (b) on refresh while `indexing_lag`, trigger a bounded wallet sync + reducer tick before re-listing.

---

### 2. P1 — Reducer maps `pf.task.reward_decision.v1` directly to terminal `rewarded`, skipping `reward_decided`

**Files:** `server/pftl-cache-reducer.js:395-397`, `shared/task-lifecycle.js:88-95`, `server/task-review-worker.js` (publishes decision)

**What happens:** On reward decision events, reducer sets `projection.status = "rewarded"` immediately. The shared lifecycle defines a distinct `reward_decided` review-loop state with `requiresRefresh: true` and tab `rewarded`, but list grouping uses status key (`tasks.js:178-187`).

**Impact:** Zero-reward rejects appear in the **Rewarded** tab with label “Rewarded” instead of an intermediate “Reward decision indexed” / payment-pending state. `taskRewardOutcome` can still distinguish `decision_only` vs `paid` on detail (`server/task-reward-outcome.js:82-112`), but list/tab UX misleads.

**Fix:** Map decision-only to `reward_decided` in reducer; let `pf.reward.v1` advance to `rewarded`. Align tab grouping and smoke expectations.

---

### 3. P1 — Review worker marks `published: true` before projection confirms; no reclaim on reducer lag

**Files:** `server/task-review-worker.js:405-406`, `451-452`, `601-612`, `736-742`

**What happens:** Claims exclude rows where `metadata_json.workers.*.published = 'true'`. After a successful on-chain publish, worker marks published, then schedules async wallet sync. If sync/reducer fails, projection can remain `submitted` / `verification_response_submitted` while the worker never reclaims the row.

**Impact:** Task stuck in review loop with no automated recovery; operator must run `task-replay-repair` or manual intervention.

**Fix:** Mark published only after reducer projects expected terminal/review state, or reclaim when `published=true` but projection status unchanged beyond a stale window.

---

### 4. P1 — Forensics `reviewState` silent during `submitted` → authority review gap

**Files:** `server/task-event-meaning.js:73-115`, `server/repositories/tasks.js:641`

**What happens:** `taskEventExpectation` warns for `verification_response_submitted` awaiting review and for positive decision without payment. There is **no** warning when `status === "submitted"`, last event is `pf.task.submission.v1`, and no `verification_requested` update exists yet.

**Impact:** Most common post-submit wait shows no forensics banner; users assume the app is broken when authority worker is simply queued.

**Fix:** Add expectation for `submitted` + last schema `pf.task.submission.v1` without subsequent authority event.

---

### 5. P2 — `submit` phase skips lifecycle re-validation

**Files:** `server/task-submission.js:129-133`, `220-224`, `354-387`

**What happens:** `process_evidence`, `config`, and `prepare` call `validateSubmissionAllowed`. `submitTaskSubmission` does not — it only resolves session/task and submits the signed blob.

**Impact:** A stale prepared transaction can be submitted after status moved (cancelled, already submitted), creating on-chain pointers the reducer must reconcile.

**Fix:** Re-run `validateSubmissionAllowed` (and optionally match prepared schema to current mode) in `submit`.

---

### 6. P2 — Forensics mislabels verification evidence on legacy submission schema branch

**Files:** `server/task-event-meaning.js:42-45`, `src/features/tasks/task-submission-actions.js` (uses `pf.task.verification_response.v1`)

**What happens:** Submission meaning checks `payload.phase === "verification_response"` on `pf.task.submission.v1`. Live client publishes `pf.task.verification_response.v1` for verification responses. The branch is dead for the browser path; mixed replays could show “initial evidence” incorrectly.

**Fix:** Prefer schema-based branching (`pf.task.verification_response.v1`) over `phase` on submission schema.

---

### 7. P2 — Detail API exposes integrity signals; Tasks list UI ignores them

**Files:** `server/repositories/tasks.js:642-673`, `src/features/tasks/TaskForensicsPanel.jsx`, `src/main.jsx`

**What happens:** Detail returns `forensics.integrity.projectionBehindCachedPointer`, reducer failure counts, etc. List/sync summary exposes `indexingLagCount`, `failedReducerCount`. No Tasks surface renders these (Forensics panel shows `reviewState` only).

**Impact:** Operators and users cannot self-diagnose projection lag without API/DB inspection.

**Fix:** Small banner on Tasks page when `sync.status !== 'ready'`, and/or forensics integrity strip for `projectionBehindCachedPointer`.

---

### 8. P2 — `mixed` verification defaults evidence draft to `text` method

**Files:** `src/features/tasks/task-evidence-drafts.js:1-8`, `scripts/task-evidence-drafts-smoke.mjs:27`

**What happens:** `evidenceMethodFromContract` maps `submissionRequirement.type === "mixed"` → `"text"`. Authority can request mixed proof (text + screenshot); UI may not prompt for second artifact unless user adds it.

**Impact:** Users submit incomplete mixed evidence; review worker may score down or request verification.

**Fix:** Default mixed to screenshot or dual-slot draft; align with task doc “Add second evidence” UX.

---

## What looks correct (verified statically)

| Area | Assessment |
|------|------------|
| Lifecycle contract | Single source in `shared/task-lifecycle.js`; tab/actions/refresh metadata consistent with wiki doc |
| Evidence pipeline phases | `process_evidence` → `config` → `prepare` → `submit` with encryption + TaskNode recipient check |
| Reward read model | `taskRewardOutcome` separates `paid`, `decision_only`, `zero_reward` on detail API |
| Detail scoping | `/api/tasks/detail` filters by linked subject wallet + account |
| Review worker structure | Separate claims for `submitted` vs `verification_response_submitted`; stale reclaim on processing flag |
| Multiple evidence cap | `MAX_TASK_EVIDENCE_ITEMS` = 2; smoke covers draft add/cap |

---

## Actionable fix bundles (recommended order)

1. **`tasks-sync-on-poll`** — Surface `sync.status` in UI; optional bounded sync when `indexing_lag` (P1 #1).
2. **`tasks-reducer-reward-decided`** — Map decision → `reward_decided`, payment → `rewarded` (P1 #2).
3. **`tasks-worker-reclaim`** — Reclaim or defer `published` until projection catches up (P1 #3).
4. **`tasks-forensics-gaps`** — Submitted-awaiting-review expectation + schema fix (P1 #4, P2 #6).
5. **`tasks-submit-validate`** — Re-validate on submit phase (P2 #5).

No broad fixes implemented in this pass (findings-only per Phase 1 scope).

---

## Verification

**Base:** `origin/main` (review read against main tree at 2026-05-23)

**Commands run** (all exit 0; stdout not captured in review environment):

```bash
npm run task-lifecycle-smoke
npm run task-evidence-drafts-smoke
npm run task-copy-payload-smoke
git diff --check origin/main...HEAD   # N/A — no product diff in findings-only pass
```

**Not verified this pass:**

- Live Docker UX (container not confirmed on a review branch SHA).
- End-to-end browser submit → worker → tab move with real task IDs/CIDs/tx hashes.
- Postgres projection rows during live submit (would need `DATABASE_URL` + linked wallet path).

**Docker note:** Existing stack on `localhost:5174` was not used; static/API-path review only.

---

## Review Findings (legacy 2026-05-18 plan — superseded)

Prior brief assumed fixture-backed task UI and unwired mutations. Current `main` has live browser request/submit/reward paths documented in `docs/wiki/surfaces/tasks.md`. This pass replaces the stale “Not started” section above.
