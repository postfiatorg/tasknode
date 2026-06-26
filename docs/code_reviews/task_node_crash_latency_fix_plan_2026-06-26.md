# Task Node Crash And Latency Fix Plan

Date: 2026-06-26

This plan turns the crash, P0, and major latency review into an implementation sequence. The goal is to remove known queue wedges, reduce production tail latency, and make expensive routes/workers bounded and observable without changing product economics.

## Goals

- No worker queue can be permanently wedged by a hung provider, IPFS, RPC, or database call.
- Web boot does not depend on one monolithic slow app-state response.
- Public and authenticated routes have explicit admission controls proportional to their cost.
- Runtime persistence does not block the Node event loop on high-frequency user actions.
- Large model/tool workflows expose progress, enforce per-account concurrency, and avoid unbounded backlog.
- Route-level latency spikes are either eliminated or made explicit and recoverable.

## Non-Goals

- No pricing, reward, or credit policy changes.
- No broad UX redesign.
- No rewrite of Task Node into a new framework.
- No full test-suite requirement for every step; each phase should verify the touched boundary.

## P0 Phase 1: Stop Queue Wedges

### 1. Task generation provider timeout and reclaim

Problem:

- `server/task-generation-worker.js` calls the provider without an `AbortController`.
- `claimTaskGenerationRequests()` moves rows to `generating`, but only claims `published` and `queued` rows later.
- A hung provider call keeps the worker `running` flag true and leaves the row unreclaimable.

Implementation:

- Add `TASKNODE_TASK_GENERATION_PROVIDER_TIMEOUT_MS`, default 90 seconds, bounded between 5 seconds and 20 minutes.
- Wrap `generateTaskWithProvider()` fetch with `AbortController`.
- Add stale reclaim for `task_requests.status = 'generating'` when `worker_claimed_at` is older than `TASKNODE_TASK_GENERATION_STALE_SECONDS`.
- Reclaim should either:
  - reset to `queued` when attempt count is below max, or
  - mark `failed` with a clear stale-running error when max attempts is reached.
- Add a worker heartbeat or update `worker_claimed_at` at stage boundaries for long generation.
- Ensure `markTaskRequestProposed()` and `markTaskRequestFailed()` only update the row when it is still owned by the current worker attempt.

Verification:

- Unit/smoke test with a provider fetch that never resolves and assert the row becomes retryable or failed.
- Existing taskgen replay smoke still passes.
- System status reports stale generation accurately.

Target files:

- `server/task-generation-worker.js`
- `server/repositories/task-requests.js`
- `server/system-status.js`
- `scripts/taskgen-replay-smoke.mjs` or a new focused stale-taskgen smoke

### 2. Add terminal-safe claim ownership to task generation

Problem:

- Task generation has no durable worker owner or attempt id, so stale reclaims and duplicate workers can race.

Implementation:

- Add columns or metadata fields for `worker_id`, `worker_attempt_id`, and `worker_heartbeat_at`.
- Claim rows with a generated attempt id.
- Guard completion/failure with `WHERE request_id = $1 AND status = 'generating' AND worker_attempt_id = $2`.
- Do not publish an offer from a stale worker if another attempt completed first.

Verification:

- Test two simulated workers where worker A stalls, worker B reclaims, and worker A later returns. Only worker B can mark the request proposed.

## P0 Phase 2: Split Worker Blast Radius

### 3. Replace the generic all-worker process with role-specific workers

Problem:

- `start:worker` runs `TASKNODE_PROCESS_ROLE=worker`, which starts the full `startBackgroundWorkers()` bundle in one Node process.
- Fly worker VM is 1 shared CPU and 512 MB.
- DB pool defaults to 6 connections, so workers can starve each other.

Implementation:

- Introduce explicit worker roles:
  - `worker:pftl`
  - `worker:taskgen`
  - `worker:task-review`
  - `worker:context-rewrite`
  - `worker:hive`
  - `worker:memory-profile`
  - `worker:airdrop`
- Update `process-role.js` to route roles to worker groups.
- Update `background-workers.js` so each process starts only its assigned group.
- Keep `worker` as a compatibility role, but make production reject or warn on it unless `TASKNODE_ALLOW_MONOLITH_WORKER=true`.
- Update `fly.toml` process definitions and document expected scale per process.

Verification:

- `npm run start:worker` in local dev still works or prints a clear compatibility warning.
- New process commands start only intended workers.
- `npm run system-status-smoke` still reports all worker categories.

Target files:

- `server/process-role.js`
- `server/background-workers.js`
- `package.json`
- `fly.toml`
- `docs/wiki/operations/` or `docs/wiki/architecture/`

### 4. Set per-process DB pool defaults

Problem:

- A single `DATABASE_POOL_MAX=6` default is too small for app-state plus all workers, and too large if every split worker uses it.

Implementation:

- Add role-aware pool sizing:
  - web default: 8 to 12
  - taskgen/context rewrite: 3 to 5
  - PFTL reducers/watchers: 3 to 5
  - low-frequency workers: 1 to 3
- Preserve explicit `DATABASE_POOL_MAX` override.
- Expose role, pool max, active, idle, and waiting in system status.

Verification:

- Pool metrics reflect role-specific defaults.
- No process starts with an accidental 30-connection pool unless explicitly configured.

## P1 Phase 3: App-State Latency And Boot Reliability

### 5. Break app-state into parallel, time-bounded sections

Problem:

- `/api/app-state` blocks first render.
- `appState()` awaits many independent sections sequentially.
- First cold computes use `allowOverflow: true`, which bypasses the concurrency gate.

Implementation:

- Replace sequential awaits with a section registry and `Promise.allSettled`.
- Give each section a small timeout:
  - readiness/session: 1 second
  - usage: 2 seconds
  - wallet grants: 2 seconds
  - tasks: 3 to 5 seconds
  - chat recents/messages: 2 seconds
  - context document/history: 2 seconds
- Return per-section fallback data with a `partial: true` marker and section error codes.
- Remove `allowOverflow: true` for first compute. If the gate is saturated:
  - return cached state if present,
  - otherwise return a minimal signed-in skeleton with `partial: true`.
- Add route-level timeout for `/api/app-state`.

Verification:

- Focused test that a delayed `task_state` section does not block session/chat skeleton.
- Focused test that gate saturation returns a bounded response.
- App still boots in local dev.

Target files:

- `server/app-state.js`
- `server/app-state-gate.js`
- `server/index.js`
- `src/main.jsx`

### 6. Split first-render state from heavy panels

Problem:

- The client renders workspace content only after full app-state.

Implementation:

- Keep `/api/app-state` as the boot contract but make it lightweight.
- Move heavy sections behind panel routes:
  - `/api/tasks`
  - `/api/context`
  - `/api/context/history`
  - `/api/chat/history`
  - `/api/profile/*`
- On first render, show available shell/session/chat controls while heavy panels load independently.
- Avoid calling full app-state for context save refresh; fetch `/api/context` or use the save response.

Verification:

- Boot still renders with a simulated slow task-state section.
- Context save updates the editor from the save response without requiring full app-state.

## P1 Phase 4: Admission Control And Memory Pressure

### 7. Global request body admission guard

Problem:

- Several routes allow 8 MB request bodies and buffer them entirely in memory.
- Fly hard concurrency is 120 on a 512 MB VM.

Implementation:

- Add an in-process byte budget for active body reads, for example `REQUEST_BODY_ACTIVE_BYTES_MAX`.
- Reject new large-body reads with 429 or 503 when active body bytes exceed the budget.
- Add route-specific lower body limits where possible:
  - chat text-only: much lower than 8 MB
  - attachments/evidence: keep high only for routes that need it
  - Context Rewrite instructions: keep 1.2 MB only if actually needed
- Prefer streaming or multipart storage for evidence in a later pass.

Verification:

- Unit test concurrent body readers exceeding budget.
- Existing chat/task route smoke passes.

Target files:

- `server/index.js`
- `server/task-routes.js`
- `server/hive-routes.js`

### 8. Rate limit all expensive read and mutation routes

Problem:

- `/api/app-state`, `/api/context`, `/api/context/history`, `/api/system/status`, and Context Rewrite routes are not rate-limited.
- `route-policies.js` carries auth metadata, but `enforceRoutePolicy()` only enforces methods and rate limits.

Implementation:

- Add rate limits:
  - `/api/app-state`: per account/IP, modest burst, short window
  - `/api/context`: per account/IP
  - `/api/context/history`: per account/IP
  - `/api/context/edit/save`: per account/IP, compatible with autosave
  - `/api/system/status`: admin bearer or strict public limit
  - `/api/context/rewrite/jobs`: strict per-account create limit and separate poll limit
- Add a test that every policy route requiring rate limits is enforced.
- Consider enforcing `auth` centrally in a later security pass; for this plan, do not change handler semantics broadly.

Verification:

- Route-policy smoke for 429 behavior.
- Existing auth/route smoke still passes.

## P1 Phase 5: Context Rewrite Admission And Backlog Control

### 9. Add per-account active-job limit

Problem:

- Context Rewrite creation checks current credit but does not reserve credit or prevent multiple active jobs.

Implementation:

- Add `CONTEXT_REWRITE_MAX_ACTIVE_PER_ACCOUNT`, default 1.
- In `createContextRewriteJob()`, lock account/job rows and reject if active queued/running jobs exceed the limit.
- Return the existing active job id and status so the client can resume polling instead of enqueueing another job.
- Add a unique partial index if feasible:
  - `(account_id)` where status in `('queued', 'running')`
  - or a migration-safe application lock if multiple active jobs will be allowed later.

Verification:

- Test double-submit creates one job and returns conflict/resume metadata for the second.
- Existing Context Rewrite smoke still creates one job.

Target files:

- `server/repositories/context-rewrite.js`
- `server/context-rewrite-actions.js`
- `src/features/context/context-rewrite-client.js`
- `src/main.jsx`

### 10. Add credit reservation or pending-spend accounting

Problem:

- Multiple queued jobs can all pass the same `availableCreditUsd` check before any actual billing posts.

Implementation:

- Add pending spend accounting for queued/running jobs:
  - either write a pending ledger hold,
  - or subtract `sum(max_cost_usd)` for active jobs from available credit during admission.
- Keep actual billing unchanged.
- Release pending hold on completion/failure/cancel.

Verification:

- Test account with enough credit for one job but not two.

## P1 Phase 6: Provider Timeout Coverage

### 11. Add timeouts to remaining OpenRouter calls

Problem:

- Daily airdrop scoring and public profile snapshot generation call OpenRouter without `AbortController`.

Implementation:

- Add `TASKNODE_DAILY_AIRDROP_PROVIDER_TIMEOUT_MS`, default 90 seconds.
- Add `TASKNODE_PUBLIC_PROFILE_PROVIDER_TIMEOUT_MS`, default 60 seconds.
- Wrap both fetches with `AbortController`.
- Normalize abort errors to stable error codes.
- Ensure worker leases are released in `finally`.

Verification:

- Unit/smoke test aborted provider calls.
- `npm run profile-daily-airdrop-worker-smoke`.
- Public profile regenerate route returns bounded failure on timeout.

Target files:

- `server/profile-daily-airdrop.js`
- `server/profile-daily-airdrop-worker.js`
- `server/profile-public-snapshot.js`
- `server/profile-routes.js`

## P2 Phase 7: Runtime Store Durability And Event Loop Health

### 12. Move hot mutable state out of synchronous whole-file persistence

Problem:

- `runtime-store.js` writes the whole JSON store synchronously on many user actions.

Implementation:

- Prioritize moving these to Postgres:
  - sessions
  - account identities/profile visibility
  - context documents
  - context history snapshots
  - auth events
- Keep runtime-store as local-dev fallback only.
- Add async persistence wrapper for any remaining file-backed writes.
- Add `TASKNODE_RUNTIME_STORE_MAX_BYTES` guard in production to warn/fail before the file becomes too large.

Verification:

- Runtime smoke with Postgres-backed sessions.
- Context edit smoke with Postgres-backed documents.
- Startup status exposes runtime-store mode and file size.

### 13. Short-term mitigation for context autosave

Problem:

- Context editor autosaves after 900 ms, posts the full document, and then refreshes app-state.

Implementation:

- Increase debounce to 2 to 3 seconds or save on blur plus explicit command.
- Do not refresh full app-state after save; update local state from response.
- Add server-side context cache invalidation if full app-state remains involved.
- Add route-policy rate limit compatible with autosave.

Verification:

- Context edit smoke.
- Manual local edit confirms saved revision updates without full app-state refresh.

Target files:

- `src/main.jsx`
- `server/product-contracts.js`
- `server/app-state.js`
- `server/route-policies.js`

## P2 Phase 8: Public Diagnostics Hardening

### 14. Make system status cheap and protected

Problem:

- `/api/system/status` is public and performs many database checks.

Implementation:

- Require admin bearer in production, or split into:
  - `/api/health`: public, cheap, no DB fan-out
  - `/api/system/status`: admin-only, detailed
- Cache detailed system status for 10 to 30 seconds.
- Add a query budget: if a status category times out, return partial status instead of waiting.

Verification:

- Public `/health` remains fast.
- Admin status route returns cached detailed response.
- System status smoke updated for auth behavior.

Target files:

- `server/system-status.js`
- `server/route-policies.js`
- `server/index.js`
- `scripts/system-status-smoke.mjs`

## P3 Phase 9: Frontend Route Latency

### 15. Split large lazy chunks

Problem:

- Build warns that `wallet-core` and `DocsView` are over 1 MB minified.

Implementation:

- Keep wallet route lazy, but split wallet crypto/XRPL-heavy helpers into sub-route or action-level dynamic imports.
- Audit DocsView imports; move large static docs/content into separately loaded markdown or JSON chunks.
- Add `manualChunks` only if it improves route load behavior without hiding the problem.
- Add a bundle-size check threshold for route chunks.

Verification:

- `npm run build`.
- Confirm no route chunk over agreed threshold, or document exceptions.

Target files:

- `src/features/wallet/WalletView.jsx`
- `src/wallet-core.js`
- `src/features/docs/DocsView.jsx`
- `vite.config.js`
- `scripts/file-size-check.mjs`

## P3 Phase 10: Observability And Regression Coverage

### 16. Add reliability smoke suite

Create focused tests for:

- Hung task generation provider reclaims or fails row.
- Stale worker attempt cannot publish after reclaim.
- App-state section timeout returns partial state.
- App-state gate saturation returns bounded response.
- Context Rewrite double-submit is rejected or resumed.
- Context Rewrite pending spend prevents oversubscription.
- Public/system status rate limit or admin requirement is enforced.
- Large request body budget rejects overload.
- Daily airdrop/public profile provider aborts are bounded.

Suggested script:

- `npm run reliability-smoke`

### 17. Add dashboards/status signals

Expose in system status:

- app-state active computes, rejected/partial count, section timeout counts
- DB pool max/active/idle/waiting per process role
- task generation stale reclaim count
- task generation in-progress age
- context rewrite active jobs per account aggregate
- request body active byte budget
- runtime-store file size and write latency

## Rollout Order

1. Task generation timeout, stale reclaim, and worker attempt guard.
2. Worker role split and role-aware DB pool defaults.
3. App-state section parallelization, timeout, and gate behavior.
4. Route/body admission controls.
5. Context Rewrite active-job and pending-spend admission.
6. Remaining provider timeouts.
7. Runtime-store hot-path migration or mitigation.
8. System status protection/cache.
9. Frontend chunk split.
10. Reliability smoke suite and status signals.

## Definition Of Done

- No known queue can stay running forever without timeout, heartbeat, stale reclaim, or terminal failure.
- Production worker processes are split by role or explicitly configured to run monolith mode.
- `/api/app-state` responds within a bounded time even when task/context/chat sections stall.
- Large request payload concurrency cannot exceed a configured memory budget.
- Context Rewrite cannot enqueue unbounded active paid jobs for one account.
- Public diagnostics cannot be used as an unbounded DB fan-out endpoint.
- Context autosave does not force full app-state recomputation on every save.
- `npm run build` passes, and any remaining bundle-size warnings are documented with owners.
