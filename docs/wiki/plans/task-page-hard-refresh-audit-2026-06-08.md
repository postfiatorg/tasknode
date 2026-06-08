# Task Page Hard Refresh Audit - 2026-06-08

## Executive Summary

The production backend currently has the task that the browser did not show.
The hard refresh did not create or repair the task. It replaced stale browser
app state with already-available server state.

The stale browser state reported by the user was:

- `2 outstanding`
- `22,004 PFT in flight`
- `11 task records synced`
- `1 requests processing`
- request strip: `Generating task`, `RPC broken`

The production read model after the reload was:

- `3 outstanding`
- `0 active requests`
- `12 task records synced`
- latest request `req_e32536f0-6112-4499-b60e-468d4be8ce32` is `proposed`
- generated task `task_c9b3a01981985030e2715e7ab1e385c6` is visible in
  `task_projections` as `proposed`

That means the failed boundary is task-page convergence in an already-open
browser tab. The PFTL outage was the triggering condition, but the current
production task projection is healthy.

## Scope

This audit looked at:

- the documented no-hard-refresh task-state fix;
- the Tasks page refresh and settle-window code;
- task request active/terminal semantics;
- the app-state projection refresh endpoint;
- task generation request-to-offer flow;
- current Fly production task/request/projection state for `goodalexander`.

No application code was changed for this audit.

## Production Evidence

Read-only Fly checks on `2026-06-08`:

- `fly status -a tasknodeofficial-dev`
  - app machine `8e3d4ea713dd68` is `started`
  - worker machine `18546e2a2d4ed8` is `started`
  - board-manager machine `1850d37c3462d8` is `started`
  - image: `tasknodeofficial-dev:deployment-01KTHQZV7DC39X3PVN5G5H7GRY`
- `fly ssh console -a tasknodeofficial-dev --process-group app -C 'node scripts/query-user-tasks.mjs --handle goodalexander --limit 20'`
  - resolved account: `acct_oauth_3c70e69ab7b8ef1fad3df508`
  - resolved wallet: `rPo8GkCA9YMKzuJGTHbj11kdVfPqSJHxNx`
  - latest request: `req_e32536f0-6112-4499-b60e-468d4be8ce32`
  - latest request status: `proposed`
  - generated task: `task_c9b3a01981985030e2715e7ab1e385c6`
  - generated title: `Document RPC Failure Reproduction And Impact`
  - visible projection: `true`
  - projection status: `proposed`
  - pending reducer count: `0`
  - failed reducer count: `0`
  - request created at `2026-06-08T01:00:15.314Z`
  - worker completed at `2026-06-08T01:00:36.082Z`
- Direct `listTaskState` read on Fly:
  - counts: `outstanding=3`, `verification=1`, `refused=1`, `rewarded=7`
  - active requests: `[]`
  - latest outstanding task is
    `task_c9b3a01981985030e2715e7ab1e385c6`, status `proposed`
  - sync status: `ready`
  - projection count: `12`
  - pending/processing/failed reducer counts: `0/0/0`

Interpretation:

The server had the task. The user's open browser had an older state snapshot:
`11` projections and one active failed/generating request. A full reload fetched
the current server state: `12` projections, no active requests, and the new
proposed task.

## Existing Architecture

### Forced App-State Projection Refresh Exists

The browser can request a projection replay through app state:

- `src/api.js:94-96` builds `/api/app-state?taskProjectionRefresh=1`.
- `server/app-state.js:122-129` calls
  `refreshLinkedWalletTaskProjection(...)` before `listTaskState(...)`.
- `src/main.jsx:465-476` forces that refresh whenever the user opens the Tasks
  route.
- `src/main.jsx:3123-3147` has Tasks-page polling that calls
  `refreshAppState({ taskProjectionRefresh: shouldForceTaskProjection })`.
- `src/main.jsx:3158-3176` forces refresh on browser focus or visibility return.

### The Documented Fix

`docs/wiki/surfaces/tasks.md:69-96` correctly identifies the canonical read
model as `task_projections` and says a stale list with a correct projection is a
browser convergence bug.

`docs/wiki/surfaces/tasks.md:104-113` documents the claimed request handoff fix:
after request recording or after active request count drops from nonzero to
zero, the browser polls every `2.5s` for up to `90s` with projection replay
enabled, and should return to `Outstanding` when a new outstanding task appears.

That promise is not currently proven for the user's incident class.

## What Failed

### 1. The Prior Fix Targeted Review-Loop Staleness More Than Request-to-Offer Staleness

The original audit in
`docs/code_reviews/task_frontend_workflow_audit_2026-05-19.md` focused on a
different live failure: a task projection was already `rewarded`, but the open
frontend still showed the earlier review state.

The current user report is a different edge:

1. A signed request was shown as still processing or RPC-broken.
2. The worker later produced a `proposed` offer.
3. The server projection became correct.
4. The open browser did not replace the request strip / old counts with the new
   proposed task until full reload.

The current regression coverage reflects that gap:

- `scripts/task-refresh-policy-smoke.mjs` tests active request polling and
  settle on active-count `1 -> 0`.
- `scripts/task-visible-state-smoke.mjs` tests task-action receipt overlays and
  rewarded hard-refresh parity.
- There is no test where a request is `generating` or recently `failed` with an
  RPC error while a generated `proposed` task becomes visible in
  `task_projections`.
- There is no test for overlapping `/api/app-state?taskProjectionRefresh=1`
  responses returning out of order during PFTL outage/recovery.

### 2. Request Active State Is Ambiguous

The server request lifecycle marks failed requests as active for 24 hours:

- `server/repositories/task-requests.js:94-100`
  - `failed` under 24 hours is active.
  - `published` under 20 minutes without a generated task is active.
  - `proposed`, `cancelled`, or any request with `generated_task_id` is terminal.

The frontend has matching fallback logic:

- `src/features/tasks/task-visible-state.js:48-58`
  - `failed` is active for 24 hours.
  - `generating`, `queued`, and `signing` are active.
  - `published` is active for 20 minutes if no generated task exists.

This makes sense for showing a recent failure, but it blurs two different UI
states:

- "work is still processing";
- "the worker hit a recoverable or terminal error."

The user's page literally said `1 requests processing` while the request row
said `RPC broken`. That is a bad product state. It also means the request
handoff logic is not server-authored enough: the page is still interpreting an
old request row while the canonical task projection may have already moved on.

### 3. The Settle Window Only Starts on Narrow Client-Side Events

The settle window starts in two places:

- `src/main.jsx:3131-3135`: after the modal reports the request was recorded.
- `src/main.jsx:3112-3121`: when active request count drops from nonzero to
  zero.

The active-count transition is defined by
`src/features/tasks/task-refresh-policy.js:8-13`.

That misses important cases:

- The browser may have been open through a PFTL outage. It can hold an old
  request row showing `generating` or `failed` while the server later reaches
  `proposed`.
- If the request remains classified as active because `failed` is active for 24
  hours, the `nonzero -> zero` settle trigger may not fire in the stale browser
  at the moment the offer projection becomes visible.
- If the settle window expires before projection catch-up, the later arrival of
  the proposed task is not treated as a handoff event unless the next server
  state is actually applied.

The current code can poll, but the handoff/reveal semantics are still local and
derived from counts. They are not driven by a server-authored "request
generated task X and projection X is now visible" fact.

### 4. Polling Is Not Monotonic

`src/main.jsx:994-1005` applies every successful `fetchAppState(...)` response
directly to `setAppState(...)`. There is no sequence number, no abort of older
task refreshes, and no generated-at monotonic guard.

During normal operation this is usually fine. During the incident it is fragile:

- PFTL was down or recovering.
- Forced projection refreshes can take longer than the `2.5s` polling interval.
- Multiple `/api/app-state?taskProjectionRefresh=1` requests can overlap.
- An older response can arrive after a newer response and repaint the browser
  with an older task snapshot.
- A hard reload cancels all in-memory state and in-flight requests, then runs
  the route-open projection refresh from a clean page.

This is a strong explanation for why a full reload was more reliable than the
open tab. The audit did not have the user's browser network log, so this exact
race is not proven from the tab, but the code currently allows it.

### 5. Server Sync Metadata Still Keeps the Page Polling, But That Did Not Save the Open Tab

The current Fly `listTaskState` response has `sync.requiresRefresh=true` and
`nextPollMs=2500` because there are accepted/review-active tasks:

- `shared/task-lifecycle.js:221-263` includes `accepted`, `submitted`,
  `verification_requested`, `verification_response_submitted`, and
  `reward_decided` in active refresh metadata.

So the frontend should keep polling. The fact that the user still needed a hard
reload means the remaining failure is not simply "polling is disabled." It is
one of:

- the browser did not apply the successful app-state response;
- stale/out-of-order app-state response overwrote a newer one;
- the open tab was running an old deployed JS bundle;
- the task request handoff was not represented as a durable server event the
  client could reconcile against.

All four are client convergence failures. None require hand-editing
`task_projections`.

## Why The Documented Fix Did Not Work

The documented fix was directionally correct but incomplete.

It fixed the task-action/review-loop class where a known task moves from one
lifecycle state to another. It did not close the request-to-offer class where a
separate `task_requests` receipt has to disappear and a new
`task_projections` row has to appear.

The implementation still relies on local browser timing:

- a `90s` local settle window;
- active request count changing from nonzero to zero;
- local focus/visibility events;
- repeated full app-state fetches without monotonic ordering;
- frontend interpretation of `failed` as still active for 24 hours.

The documentation says this prevents the hard-refresh state. The tests do not
prove that for the user's actual case: PFTL/RPC interruption, request row says
`RPC broken`, server later has a proposed projection, and the open page must
replace `11 task records synced / 1 requests processing` with
`12 task records synced / proposed task`.

## Remediation Plan

### P0: Make Task Refresh Monotonic In The Browser

Add a task-app-state request controller in `src/main.jsx`:

- track an incrementing task refresh sequence;
- abort the previous task refresh when a newer task refresh starts;
- ignore any app-state response older than the latest applied task response;
- compare `state.generatedAt` or a server-provided task sync version before
  applying task buckets;
- keep wallet-balance merge behavior, but do not allow older `tasks` payloads to
  overwrite newer `tasks` payloads.

Regression:

- simulate two app-state responses where the older response resolves last;
- assert the UI keeps the newer task count and proposed row.

### P0: Make Request-To-Offer Handoff Server-Authored

Extend `listTaskState` / task request public state with explicit handoff fields:

- `latestRequestId`;
- `latestRequestStatus`;
- `generatedTaskId`;
- `generatedTaskVisible`;
- `requestHandoffState`: `waiting`, `generating`, `failed`, `generated_visible`,
  `generated_projection_pending`, `terminal_error`;
- `taskSyncVersion`: max of task projection updated time, request updated time,
  reducer updated time, and pointer observation updated time for the account.

The browser should use this server state directly. It should not infer handoff
success only from active request count.

Regression:

- request status `proposed` plus visible generated projection removes the
  request strip and shows the task;
- request status `failed` plus visible generated projection still shows the
  task and does not count as processing;
- request status `failed` without a generated projection shows `Needs attention`
  rather than `requests processing`.

### P0: Extend The Settle Window On Request Updates, Not Only Active-Count Drop

The settle window should start or extend when any of these occur:

- request is recorded;
- latest request `updatedAt` changes;
- latest request status changes;
- latest request gets `generatedTaskId`;
- server reports `generated_projection_pending`;
- projection count increases while the user is on Tasks.

This replaces the fragile `activeRequestCount: 1 -> 0` dependency with a
request/projection high-watermark.

Regression:

- user is on `Verification`;
- request completes into a proposed outstanding task;
- UI returns to `Outstanding` and shows the proposed task without full reload.

### P1: Split "Processing" From "Needs Attention"

Change the request strip copy and counts so failed requests do not render as
`requests processing`.

Expected behavior:

- `signing`, `published`, `queued`, `generating`: processing.
- `failed` without generated task: needs attention.
- `failed` with generated task/projection: hidden from active strip, task card
  wins.
- `proposed` with generated projection: hidden from active strip.

Regression:

- a 10-minute-old failed request appears as actionable failure, not processing;
- a generated task always wins over a failed request row with the same
  `request_id`.

### P1: Add Production Diagnostics For This Exact Boundary

Add read-only diagnostics to app-state/task logs:

- account hash;
- request id;
- generated task id;
- projection count;
- active request count;
- task sync version;
- app-state generatedAt;
- whether task projection refresh was forced;
- refresh duration.

This avoids the current blind spot where we can prove the server state after
the fact but cannot prove which app-state response the user's tab applied.

### P1: Add A Focused Smoke For The Exact Incident

Add a smoke that constructs:

1. previous client state: `2 outstanding`, `11 projectionCount`,
   one active failed/generating request with `lastError='RPC broken'`;
2. server next state: `3 outstanding`, `12 projectionCount`, latest request
   `proposed`, generated task visible;
3. user is on `Verification` or `Outstanding`;
4. no hard refresh is performed.

Expected:

- request strip disappears;
- task count becomes `3`;
- generated proposed task appears;
- current tab moves to `Outstanding` during handoff;
- older/stale app-state response cannot revert to `2` outstanding.

## Immediate Operator Guidance

For this incident class, query production before editing rows:

```bash
fly ssh console -a tasknodeofficial-dev --process-group app -C 'node scripts/query-user-tasks.mjs --handle goodalexander --limit 20'
```

If `visibleProjection=true`, `projectionStatus=proposed`, and reducer counts are
zero, the backend is not missing the task. The open browser is stale.

If `task_requests.status='proposed'` has `generated_task_id` but
`visibleProjection=false`, then repair projection/reducer state.

If `task_requests.status in ('published', 'queued', 'generating', 'failed')`
and no generated task exists, then inspect worker/PFTL/IPFS/OpenAI failure
before touching frontend code.

## Bottom Line

The prior fix was real but incomplete. It covered stale lifecycle transitions
for existing task cards better than it covered the request-to-offer handoff
under RPC failure and recovery.

The product-level repair is not to special-case this task. The repair is to make
task refresh monotonic, make request-to-offer handoff server-authored, and add a
regression test that proves an open Tasks page replaces an RPC-broken request
strip with the generated proposed task without a full browser reload.
