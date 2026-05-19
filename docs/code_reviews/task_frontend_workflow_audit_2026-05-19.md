# Task Frontend Workflow Audit - 2026-05-19

## Scope

Focused audit of Task Node frontend and workflow logic after the live task loop exposed stale state and ambiguous review transitions. The audit looked at task list rendering, task detail state, request receipts, lifecycle policy, server projections, and forensics display.

Representative live case:

```text
task_ab585795d15c8556386b8a4f8a4e68b6
projection status: rewarded
reward_actual_pft: 1.800000
event_count: 7
last reward tx: 4EA10743EEB9...
```

The backend projection was correct, but the open frontend continued showing the task in the previous review state. That is the failure mode this audit prioritizes.

## P0 Findings

### 1. Lifecycle state is duplicated across server and frontend

Impact: every new status or transition requires multiple manual edits. Missing any one of them can leave tasks in the wrong tab, wrong color, wrong action state, or stale refresh loop.

Representative excerpts:

```js
// server/task-lifecycle-policy.js
const terminalStatuses = new Set(["cancelled", "expired", "refused", "rejected", "rewarded"]);
const initialSubmissionStatuses = new Set(["accepted"]);
const verificationSubmissionStatuses = new Set(["verification_requested"]);
```

```js
// server/repositories/tasks.js
const verificationStatuses = new Set(["verification_requested", "verification_response_submitted"]);

function taskStatusLabel(status = "") {
  if (normalized === "verification_requested") return "Verification requested";
  if (normalized === "verification_response_submitted") return "Awaiting review";
}
```

```js
// src/main.jsx
const workerDrivenStatuses = new Set([
  "submitted",
  "verification_requested",
  "verification_response_submitted",
]);
```

Proposed fix: create one shared task lifecycle contract used by both server and client, likely `shared/task-lifecycle.js`. It should define status keys, display labels, tab bucket, terminal/review-loop flags, allowed actions, refresh behavior, and visual token names. The frontend should consume server-returned lifecycle metadata rather than maintaining its own status lists.

### 2. Task detail polling exits before the full workflow settles

Impact: after evidence or verification response submission, the modal can stop polling once it sees the submitted tx or an intermediate review state. The authority worker can later publish verification requests, reward decisions, or rewards without the open modal reflecting the final state.

Representative excerpt:

```jsx
// src/features/tasks/TaskDetailModal.jsx
const terminalOrReviewState = verificationResponse
  ? ["Rewarded", "Awaiting review"].includes(detail.task.status)
  : ["Rewarded", "Awaiting review", "Verification requested", "Submitted"].includes(detail.task.status);
if (hasSubmittedTx || terminalOrReviewState) return;
```

Proposed fix: split polling into two phases:

1. "Evidence transaction indexed" confirmation, which can stop when the submitted tx appears.
2. "Workflow settled" polling, which continues in the background while the task is in `submitted`, `verification_requested`, or `verification_response_submitted`, and stops only at terminal states or an explicit timeout with visible "Still awaiting review" copy.

This should be driven by status keys and lifecycle metadata, not display labels.

### 3. The Tasks page refresh policy is a client-side whitelist

Impact: the page can go stale whenever a worker-driven transition is not included in the local whitelist. This already happened with the rewarded transition after verification response processing.

Representative excerpt:

```jsx
// src/main.jsx
if ((!activeRequests.length && !workerDrivenTasks) || typeof onRequestSettled !== "function") return undefined;
const refresh = window.setInterval(() => {
  Promise.resolve(onRequestSettled()).catch(() => null);
}, 2500);
```

Proposed fix: make `GET /api/tasks` return `sync.requiresRefresh`, `sync.nextPollMs`, and `sync.refreshReason` based on server lifecycle metadata and pending worker state. The frontend should poll while the server says the projection is not settled. Longer term, use an event stream or websocket for task projection updates.

## P1 Findings

### 4. Status display styling uses human labels, not canonical status keys

Impact: labels such as `Awaiting review`, `Submitted`, or `Cancelled` can silently fall back to neutral styling because the map is not keyed on canonical status. The code still includes `Verification submitted`, which is not the current label.

Representative excerpt:

```jsx
// src/features/tasks/TaskRow.jsx
function taskStatusColor(status) {
  return {
    Proposed: "#7a5a1f",
    Accepted: "#4a5934",
    Refused: "#7c3c2e",
    Rewarded: "#6e5223",
    "Verification requested": "#5b4b8a",
    "Verification submitted": "#4a5934",
  }[status] || "#3d3d38";
}
```

Proposed fix: render color and glyphs from `statusKey` or a server-provided `statusTone`, not from the display label. Remove obsolete labels and keep display copy separate from behavior.

### 5. Request receipt visibility uses frontend time windows

Impact: a request can be hidden or shown based on local wall-clock age instead of canonical queue state. This makes stuck requests and recently-generated offers difficult to reason about.

Representative excerpt:

```jsx
// src/features/tasks/TaskRequestQueue.jsx
if (status === "failed") return requestAgeMs(request) < 24 * 60 * 60 * 1000;
if (["signing", "queued", "generating"].includes(status)) return true;
if (status === "published") return requestAgeMs(request) < 20 * 60 * 1000 && !request.generatedTaskId;
```

Proposed fix: have `/api/tasks/requests` return `isActive`, `isTerminal`, `isStale`, `canRetry`, and `displayUntil`. The frontend should render those fields directly.

### 6. Forensics truncates readable payload fields too aggressively

Impact: verification responses and evidence text can be cut off in the proof view, which makes it harder to audit exactly what was submitted.

Representative excerpt:

```js
// server/repositories/tasks.js
function detailValue(value) {
  if (typeof value === "string") return safeText(value, 1200);
  return safeText(JSON.stringify(value), 1200);
}
```

Proposed fix: keep compact previews, but add expandable full-value rows and one-click copy for untruncated evidence, verification asks, reward reasons, and raw payload fields.

## P2 Findings

### 7. Product configuration is embedded in the empty task state

Impact: feature flags and caps are mixed into a fallback state object, which makes environment behavior harder to audit.

Representative excerpt:

```js
// server/repositories/tasks.js
return {
  personalRequestEnabled: true,
  networkRequestEnabled: false,
  alphaRequestEnabled: false,
  dailyRewardCap: 8,
}
```

Proposed fix: move task product configuration into an explicit config endpoint or repository function. The empty state should only describe the absence of task data.

## Recommended Remediation Order

1. Create a shared lifecycle contract and replace duplicated status sets in `server/task-lifecycle-policy.js`, `server/repositories/tasks.js`, `src/main.jsx`, `src/features/tasks/TaskRow.jsx`, and `src/features/tasks/TaskDetailModal.jsx`.
2. Change `GET /api/tasks` to return server-derived refresh metadata for active/review-loop states. Remove frontend status whitelists for polling.
3. Rework task detail polling into transaction-indexed and workflow-settled phases.
4. Convert visual status rendering to `statusKey` or server-provided tone tokens.
5. Move request receipt active/stale logic to the server.
6. Add expandable/copyable full payload fields in Forensics.
7. Extract task feature flags and caps from `emptyTaskState`.

## Verification Coverage Needed

Add regression coverage for these product flows:

1. Proposed -> accepted -> submitted -> verification requested appears in Verification.
2. Verification requested -> verification response submitted shows `Awaiting review`.
3. Verification response submitted -> rewarded moves from Verification to Rewarded without manual reload.
4. Rewarded with positive payment shows paid amount and reward tx.
5. Rewarded with zero decision shows closed/no-payment explanation.
6. Stuck request remains visible as actionable stale state instead of disappearing by age.

