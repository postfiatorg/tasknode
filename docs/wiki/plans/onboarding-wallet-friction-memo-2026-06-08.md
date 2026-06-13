# Onboarding And Wallet Friction Memo - 2026-06-08

## Scope

This memo reviews the remaining user-facing friction in Task Node onboarding,
task loading, task request, task submission, and multi-wallet Network Task
capacity flows after the June 8 task-state fixes.

Reviewed flows:

- first session checklist: login, handle, wallet link/create, seed backup,
  Context, Chat, Tasks, Hive, and Profile;
- wallet readiness: linked wallet, saved local vault, unlocked local vault, and
  task signing;
- Tasks list and direct task detail routes;
- personal task request publishing and request-to-offer handoff;
- task accept, evidence submission, verification response, and reward
  convergence;
- multi-wallet identity and Network Task capacity for
  `rhwiJxkiTkxTC65MrmLG7WiUkbiCyw2TaE` and
  `rPo8GkCA9YMKzuJGTHbj11kdVfPqSJHxNx`;
- operator observability for user, wallet, task, reward, memory, profile, Hive,
  Telegram, and usage questions.

Evidence used:

- user incident notes from June 8: hard refresh briefly looked signed out,
  task request sat at publishing/generating, task detail showed `Loading task
  detail`, screenshot selection was hard to perceive, and review state lagged
  until a hard refresh;
- `docs/wiki/surfaces/user-guide.md`;
- `docs/wiki/surfaces/wallet.md`;
- `docs/wiki/surfaces/tasks.md`;
- `docs/wiki/architecture/auth-wallet-boundary.md`;
- `docs/wiki/architecture/user-observability-logging.md`;
- `src/main.jsx`;
- `src/features/tasks/TaskRequestModal.jsx`;
- `src/features/tasks/TaskRequestQueue.jsx`;
- `src/features/tasks/TaskDetailModal.jsx`;
- `src/features/wallet/WalletView.jsx`;
- production read-only operator packet:
  `fly ssh console -a tasknodeofficial-dev --process-group app -C 'node scripts/user-observability.mjs --wallet rhwiJxkiTkxTC65MrmLG7WiUkbiCyw2TaE --since today --limit 5'`;
- Fly process baseline:
  `fly status -a tasknodeofficial-dev`, release 288, app/worker/board-manager
  started.

No authenticated browser screenshot was captured by Codex for this memo. The
user-visible behavior is reconstructed from the user's incident notes plus
production rows and source review.

## Production Snapshot

At `2026-06-08T20:15Z`, the read-only production operator packet resolved:

- account: `acct_oauth_3c70e69ab7b8ef1fad3df508`;
- public handle: `goodalexander`;
- active wallet: `rhwiJxkiTkxTC65MrmLG7WiUkbiCyw2TaE`;
- historical wallet with June 8 task activity:
  `rPo8GkCA9YMKzuJGTHbj11kdVfPqSJHxNx`;
- active Network Task blocker:
  `task_5ea47962f834e308c94c6d0d74362f9f`;
- Network allocation:
  `netalloc_095f932e40b401dd3ffafe39d5fd6c56`;
- Network capacity status for the active wallet: `at_capacity`;
- capacity blocker state: `accepted`;
- capacity metrics: `accountOutstandingCount=1`,
  `walletOutstandingCount=1`, `accountOnlyPendingCount=0`,
  `accountPendingGenerationCount=0`, `walletPendingGenerationCount=0`.

Same-day task rows in that packet show mixed wallet activity:

| Wallet | Kind | Offered | Accepted | Refused | Submitted | Rewarded | Reward PFT |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `rhwiJxkiTkxTC65MrmLG7WiUkbiCyw2TaE` | personal | 6 | 1 | 4 | 1 | 1 | 1.2 |
| `rhwiJxkiTkxTC65MrmLG7WiUkbiCyw2TaE` | network | 2 | 1 | 1 | 0 | 0 | 0 |
| `rPo8GkCA9YMKzuJGTHbj11kdVfPqSJHxNx` | personal | 3 | 2 | 0 | 2 | 1 | 1.5 |

Conclusion from production evidence: Network Task capacity is currently
computed for the active wallet and is blocked by the accepted Network Task on
`rhwiJxkiTkxTC65MrmLG7WiUkbiCyw2TaE`. The app still needs to expose that
identity/capacity explanation clearly to users.

## Findings

### P0 - Session Restore Looks Like Logout During Hard Refresh

Observed evidence:

- The user reported that refreshing during task request/detail work showed a
  completely logged-out state before the account randomly returned.
- `src/main.jsx` uses `fetchAppStateWithSessionRetry` with a session hint, but
  the visible fallback remains a generic `Loading product state` banner while
  `appState` is empty.
- The auth hint is deliberately hidden from product state because the cookie is
  canonical, but the UI does not tell the user that a signed-in session is being
  restored.

Reproduction notes:

1. Sign in and open Tasks.
2. Navigate to a task detail URL such as `#tasks/<task_id>`.
3. Hard refresh while `/api/app-state` or session recovery is slow.
4. Observe the global loading or signed-out-looking shell before the signed-in
   session is restored.

Expected behavior:

The app should preserve the last known identity while it verifies the HttpOnly
session and should label the state as restoring the signed-in account.

Actual behavior:

The first visible state can look like the user lost login or wallet context.

User impact:

Users lose trust at the exact moment they are trying to sign or inspect a task.
They may stop interacting or repeatedly hard refresh, which worsens the state
race.

Recommendation:

Render an identity-preserving restore state from the session hint: display the
last known profile name/wallet, label the state `Restoring signed-in session`,
and only show a signed-out CTA after the retry fails. Emit observability events
for restore started, succeeded, and failed.

### P0 - Direct Task Detail Still Has An Unclear Loading Boundary

Observed evidence:

- The user reported `Loading task detail` on
  `#tasks/task_a9ba7775d8080c448f9ca8e58ac14101` for long enough that the task
  could not be acted on.
- `TaskDetailModal.jsx` now uses the list projection and session cache as a
  fallback when a selected task exists, so controls are not blocked by a detail
  fetch if projected task data is available.
- A direct task route is still selected only after app-state projected tasks are
  loaded in `src/main.jsx`. Before that, the page has no route-level task card
  to show.
- `TaskDetailLoadingPanel` only says `Loading task detail`; it does not explain
  whether the app is loading session state, wallet-scoped task projection, IPFS
  detail, or reducer replay.

Reproduction notes:

1. Open a cold browser on a direct task route.
2. Delay `/api/app-state` or task projection refresh.
3. Observe that the user has no task-specific explanation until the selected
   task is found.

Expected behavior:

The URL should immediately anchor the user to a task-specific shell with task
ID, active wallet, and the exact loading boundary.

Actual behavior:

The user can see a generic loading state and cannot tell whether the task is
missing, the wallet is wrong, or the projection is still syncing.

User impact:

The user cannot reliably understand or act on a task from a copied URL, which
breaks accept/submit flows and support reproduction.

Recommendation:

Add a route-level task bootstrap path that fetches
`GET /api/tasks/detail?taskId=...&refreshProjection=1` in parallel with
app-state and renders a task-ID shell immediately. Use the cached projection
when available, but show explicit states: `Restoring session`, `Loading active
wallet tasks`, `Refreshing projection`, or `Task not visible for this wallet`.

### P0 - Personal Task Request Handoff Is Still Opaque

Observed evidence:

- The user saw `Publishing`, closed the modal because the wait was confusing,
  then later saw `Generating task` and `1 requests processing`.
- `TaskRequestModal.jsx` updates a single pending label and still permits the
  Close action while publishing.
- `TaskRequestQueue.jsx` shows a compact row with status, age, title, and
  `lastError`; it does not show a request timeline, transaction hash, worker
  claim, generated task ID, projection visibility, or ETA.
- `docs/wiki/surfaces/tasks.md` documents that a signed request is not the same
  thing as a proposed task card, but that distinction is not visible enough in
  the product.

Reproduction notes:

1. Click `Request task`.
2. Enter task details and publish.
3. Close the modal while the action is pending or immediately after the PFTL
   transaction is signed.
4. Watch the compact request strip during generation and projection catch-up.

Expected behavior:

The user should see a persistent, understandable timeline:
`Signing -> Published to PFTL -> Queued -> Generating -> Offer published ->
Visible in Tasks`, with the current step and last update time.

Actual behavior:

The user sees short labels like `Publishing` or `Generating task` and cannot
tell whether the request is still working, failed, or safe to close.

User impact:

Users may abandon the flow, duplicate requests, or assume the app lost work.

Recommendation:

Replace the compact request strip with an expandable request timeline that shows
the request ID, tx hash when available, worker status, generated task ID, last
update, and failure reason. During pending publish, change `Close` to `Hide
progress` and show that the request continues in the Tasks queue.

### P1 - Multi-Wallet Scope Is Operator-Visible But Not User-Visible

Observed evidence:

- The production operator packet clearly distinguishes the active wallet
  `rhwiJxkiTkxTC65MrmLG7WiUkbiCyw2TaE` from historical wallet
  `rPo8GkCA9YMKzuJGTHbj11kdVfPqSJHxNx`.
- The same packet shows active wallet Network Task capacity as `at_capacity`
  because `task_5ea47962f834e308c94c6d0d74362f9f` is accepted.
- `docs/wiki/architecture/user-observability-logging.md` now requires identity
  vector resolution and wallet-specific capacity checks.
- The Tasks header shows aggregate facts like outstanding count, PFT in flight,
  synced record count, and requests processing, but it does not explain which
  wallet those facts belong to or why historical wallets appear in support
  packets.

Reproduction notes:

1. Link or view tasks under wallet
   `rPo8GkCA9YMKzuJGTHbj11kdVfPqSJHxNx`.
2. Link or view tasks under wallet
   `rhwiJxkiTkxTC65MrmLG7WiUkbiCyw2TaE`.
3. Compare task counts and Network Task eligibility in the operator packet.
4. Observe that the product UI does not provide the same wallet-scoped
   explanation.

Expected behavior:

The Tasks or Wallet surface should show active wallet, historical wallet
attribution, and current Network Task capacity reason.

Actual behavior:

The explanation is available to operators but not surfaced to users.

User impact:

Users cannot tell whether a missing task, capacity block, reward count, or
history change is caused by active wallet selection, account-wide history, or
projection lag.

Recommendation:

Add a wallet scope strip to Tasks: active wallet, historical wallet count,
projection sync time, and `Network capacity: available / busy / waiting for
profile / wallet not synced`. Add a per-wallet filter for task history and a
direct link to Wallet readiness.

### P1 - Wallet Readiness Has Too Many Separate Concepts

Observed evidence:

- The User Guide and Wallet docs correctly explain account login, linked PFT
  wallet, local seed vault, saved vault, locked vault, unlocked vault, and seed
  backup.
- `WalletView.jsx` tracks these as separate states:
  `walletLinked`, `vaultAvailable`, `vaultUnlocked`, `vaultStatusLabel`, and
  action contracts.
- Task signing surfaces reuse wallet unlock policy messages, but users still
  have to infer whether the blocker is account login, linked wallet, missing
  local vault, locked vault, or worker/projection state.

Reproduction notes:

1. Sign in as a new or returning user.
2. Link a wallet but do not have a saved local vault in this browser, or keep
   the vault locked.
3. Try to request, accept, refuse, or submit task evidence.
4. Observe `Open wallet` or `Unlock wallet` without a full readiness checklist.

Expected behavior:

The app should show a single signing readiness checklist with one next action.

Actual behavior:

The user sees different wallet messages in different surfaces and has to
mentally combine them.

User impact:

Wallet onboarding feels fragile. Users may think linking a wallet is enough for
all actions or may not understand why a linked wallet cannot sign from the
current browser.

Recommendation:

Add a shared `Wallet readiness` component used by Wallet, Tasks, Profile, and
Context publishing. It should show: account signed in, PFT wallet linked, local
vault saved in this browser, vault unlocked, seed backed up, and task signing
ready. Each failed row should have exactly one action.

### P1 - Evidence File Selection Feedback Is Too Subtle

Observed evidence:

- The user selected a screenshot and reported that it was not obvious anything
  happened.
- In `TaskDetailModal.jsx`, screenshot/file evidence updates the file name and
  may show a processed description after reading/compaction. There is no
  thumbnail, file chip, per-item progress row, or persistent callout explaining
  what remains before submit.
- The submit button stays disabled until the user checks `This evidence is
  ready to submit`, which can make a successful file selection feel like a
  failed selection.

Reproduction notes:

1. Open a task in `verification_requested` or `accepted`.
2. Go to Submit.
3. Choose `Screenshot`.
4. Select a file and wait for read/compaction.
5. Observe the file-name/processed-text feedback and disabled submit button
   until the readiness checkbox is selected.

Expected behavior:

A selected file should produce an obvious attached state and say what remains
before submission.

Actual behavior:

The feedback is small and easy to miss, especially during file processing.

User impact:

Users may click repeatedly, submit incomplete evidence, or assume the upload did
not work.

Recommendation:

Show an evidence attachment chip with file name, size, method, processing
state, and remove action. For screenshots, show a small thumbnail or image icon
plus `Screenshot attached`. When the submit button is disabled, show the exact
missing condition, such as `Confirm readiness to submit`.

### P1 - Review And Reward Convergence Still Needs Trust Copy

Observed evidence:

- The user submitted evidence, saw `Awaiting review`, then a hard refresh later
  showed the task as rewarded.
- `docs/wiki/surfaces/tasks.md` documents receipt overlays, projection refresh,
  and review-loop polling.
- `TaskDetailModal.jsx` polls task detail after submitted transactions and calls
  `onTaskChanged` with projection refresh, but the UI still does not expose a
  clear `signed -> indexed -> reviewed -> rewarded` timeline.

Reproduction notes:

1. Accept a task.
2. Submit initial evidence.
3. Submit verification evidence if requested.
4. Watch the list/detail status while the review worker publishes and the
   reducer projects the reward.
5. Compare visible state before and after a hard refresh.

Expected behavior:

The user should see the signed transaction and current projection state, plus a
clear statement that chain/reducer sync is still reconciling if the app has not
shown the terminal reward yet.

Actual behavior:

The status can appear stale without an explanation.

User impact:

Users interpret a normal async projection delay as lost work or broken reward
state.

Recommendation:

Add a task lifecycle timeline in detail and list rows with transaction hash,
last projected event, projection sync age, and current worker/reducer state.
When a receipt is overlaying stale projection, label it `Signed locally, syncing
canonical task state`.

### P2 - Network Task Entry Point And Eligibility Are Not Plain Enough

Observed evidence:

- `docs/wiki/surfaces/tasks.md` says `Request task` creates personal tasks and
  is not the Network Task entry point.
- Network Tasks are routed by Hive Board Manager based on gates, diagnostic
  profile, project need, and capacity.
- The current task itself is a Network Task, but the most visible Tasks CTA is
  still `Request task`, which can imply the user can manually ask for Network
  work there.

Reproduction notes:

1. Open Tasks with no current Network Task, or with the active Network Task
   capacity blocker.
2. Look for how to get another Network Task.
3. Observe that the primary CTA is `Request task`, while Network eligibility is
   not presented as a first-class user-facing card.

Expected behavior:

Users should see that personal task requests and Network Task routing are
different systems.

Actual behavior:

The distinction is mainly in docs and operator packets.

User impact:

Users may click `Request task` expecting Network work or not understand why an
accepted Network Task blocks further routing.

Recommendation:

Add a compact `Network Task eligibility` panel to Tasks or Hive that shows:
current wallet, profile status, sync status, capacity status, active blocker,
and next action. Keep `Request task` labeled as personal work.

### P2 - Observability Counts Can Overwhelm Operators Without Product Context

Observed evidence:

- The production operator packet is useful, but the same-day daily usage rollup
  contained a very high `taskActionCount` while the user-facing issue was a
  smaller number of visible interactions.
- This may be expected if task sync, projection, or UI events are counted as
  task actions, but the packet does not distinguish user-clicked actions from
  background task events in the summary.

Reproduction notes:

1. Run
   `node scripts/user-observability.mjs --wallet <wallet> --since today --limit 5`.
2. Compare daily usage rollup counts with task rows and recent visible events.

Expected behavior:

Operator packets should separate user-initiated clicks from background sync and
projection events.

Actual behavior:

Rollup counts can look alarming without source labels.

User impact:

Support may misread high counters while investigating a user-visible blocker.

Recommendation:

Split observability usage rollups into `user_initiated_task_action_count`,
`background_task_projection_count`, and `ui_blocker_count`, or add source
breakdowns beside high counts.

## Prioritized Recommendation List

1. Ship identity-preserving session restore and direct task route bootstrap.
   This addresses the most damaging trust break: a refresh looking like logout
   or task loss.
2. Replace request and task lifecycle ambiguity with visible timelines. Show
   signing, PFTL publish, worker state, projection visibility, review, and
   reward state as separate steps.
3. Make wallet scope visible in Tasks. Show active wallet, historical wallet
   attribution, projection sync age, and Network Task capacity reason.
4. Add a shared wallet readiness checklist across task-signing surfaces. One
   checklist should explain account, linked wallet, local vault, unlock, backup,
   and signing readiness.
5. Improve evidence attachment feedback. File selection needs an obvious
   attached state and exact disabled-submit reason.
6. Add a Network Task eligibility panel. Do not make users infer Board Manager
   routing or capacity from the personal `Request task` button.
7. Keep the observability operator packet, but separate user-clicked actions
   from background task/reducer events so support conclusions are easier to
   trust.

## Verification Notes

Commands run:

```bash
fly status -a tasknodeofficial-dev
node scripts/user-observability.mjs --help
npm run user-observability-smoke
fly ssh console -a tasknodeofficial-dev --process-group app -C 'node scripts/user-observability.mjs --wallet rhwiJxkiTkxTC65MrmLG7WiUkbiCyw2TaE --since today --limit 5'
```

Results:

- Fly release `288` is deployed with app, worker, and board-manager machines
  started.
- `node scripts/user-observability.mjs --help` prints the expected operator
  usage.
- `npm run user-observability-smoke` passed.
- The production operator packet resolved the user identity vector, current
  wallet, historical wallet, task rows, Network Diagnostic Report status, and
  active Network Task capacity blocker.

Submission conclusion:

The remaining blocker class is not only missing backend state. The core user
friction is that Task Node still hides the active state boundary: auth restore,
wallet readiness, task request worker state, PFTL projection, task detail
hydration, and wallet-scoped capacity are visible to operators but not explained
clearly enough to users in the app.
