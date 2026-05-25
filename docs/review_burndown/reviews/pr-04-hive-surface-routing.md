# PR-04 Review: Hive Surface, Hive Chat, Context, Projects, And Routing Feed

Date: 2026-05-25
Branch: `review/04-hive-surface-routing`
Base: `origin/main` @ `d01d391`

## Summary

Reviewed the Hive coordination surface end to end: Hive routes, default Hive Chat,
Hive Context grouping, Board Manager feed wiring, project/routing read models, and
the Hive wiki contract. Core boundaries are sound — one durable Hive Chat per
account, Hive input persistence without billed model calls, Board Manager replies
routed through `sourceConversationId`, and routing feed ordering from live task
projections. This branch adds small UX fixes for project ID visibility and Hive
chat-history warning surfacing.

## Findings

### P0

None.

### P1

1. **Project IDs were not shown on Hive project cards or detail header**
   - **File/line:** `src/features/hive/HiveView.jsx:225-230`, `406-408`; `docs/wiki/surfaces/hive.md:24`
   - **Severity:** P1 (doc/UX mismatch)
   - **Impact:** Operators cannot refer to stable `network_projects.id` from the Hive surface even though the wiki requires it on the detail header and review spec asks for IDs on cards.
   - **Verification:** Read `ProjectDetail` and `ProjectCard`; neither rendered `project.id` before this branch.
   - **Fix:** Included — render `project.id` in project meta on cards and detail.

2. **Hive Context POST can succeed while chat-history write fails silently in the UI**
   - **File/line:** `server/hive-routes.js:187-214`, `src/main.jsx:1578-1614`
   - **Severity:** P1
   - **Impact:** Context entry persists, but the user sees only the generic saved-status row and never learns chat history failed (`chatHistoryWarning` was API-only).
   - **Verification:** `hive-routes.js` catches `appendChatUserMessage` errors into `chatHistoryWarning`; `main.jsx` ignored the field.
   - **Fix:** Included — append the warning to the local Hive saved-status row when present.

### P2

1. **Virtual Hive Chat appears before first explicit enable/create**
   - **File/line:** `server/repositories/chat-conversations.js:99-117`, `380-414`
   - **Severity:** P2
   - **Impact:** Signed-in users see a pinned virtual Hive Chat (`virtual: true`) in recents before `POST /api/hive/chat` or first message creates the row. Behavior matches docs ("every signed-in user gets one default Hive Chat") but the conversation is not durable until first write/enable.
   - **Verification:** `listChatConversations` synthesizes `virtualHiveConversation` when no DB row exists; `ensureHiveConversation` creates on Board Manager delivery or enable.
   - **Fix:** Deferred — acceptable lazy-create pattern; document if operators need eager creation on login.

2. **Hive Context raw inputs are network-visible, not account-private**
   - **File/line:** `server/repositories/hive-context.js:741+`, `src/features/hive/HiveView.jsx:728-755`
   - **Severity:** P2 (clarity)
   - **Impact:** All contributors' raw inputs appear to any Hive viewer. Grouping is per account and does not leak entries across groups, but this is shared network context rather than per-user privacy.
   - **Verification:** `getHiveContextDocument` returns grouped entries without account filter on GET.
   - **Fix:** None — matches wiki ("network context document"); keep explicit in docs if privacy expectations arise.

3. **Manual screenshot evidence not captured in this review pass**
   - **Severity:** P2 (evidence gap)
   - **Impact:** Spec asks for Hive page and Board Manager reply screenshots; this pass relied on static checks and code/doc review.
   - **Verification:** Required commands passed; live `#hive` screenshots were not taken in this environment.
   - **Fix:** Integration owner should capture screenshots when merging if UX sign-off is required.

## What Looks Correct

- **One default Hive Chat:** deterministic `hiveConversationIdForAccount`, pinned recents entry, rename blocked, disable flow with Settings re-enable (`src/main.jsx`, `chat-conversations.js`).
- **Hive acknowledgments as status, not agent content:** `hive_context_status` renders grey italic system row; legacy `hive_input_ack` rows are suppressed (`ChatMessages.jsx:162-174`).
- **Board Manager reply routing:** `resolveMessageTarget` prefers `hive_context_entry.sourceConversationId`, falls back to default Hive Chat, and `ensureHiveConversation` before append (`board-manager-actions.js:100-151`).
- **Failed deliveries in agent feed:** `formatBoardManagerAgentRun` / `resultSummary` surface `failed: …` from action results and run errors (`board-manager-run-summary.js:87-89`).
- **Hive Context UX:** collapsed panel, Secretary report first, raw inputs behind nested collapsible, grouped by contributor account (`HiveView.jsx:601-759`).
- **Routing feed:** derived from project activity, sorted newest-first, compact copy without raw IDs/CIDs (`hive-projects.js:323-334`, `FeedRow`).
- **Product documents:** collapsible `Project Status` with summary-first preview (`HiveView.jsx:313-357`).
- **Task state:** project tasks and routing feed derive from `network_project_task_refs` reconciled against `task_projections` (per wiki and `hive-projects.js` rollups).
- **Unread Hive notifications:** `board_manager_user_messages` unread count flows through app-state, sidebar badge, and clears on `PATCH /api/hive/chat` (`app-state.js:99`, `main.jsx:671-688`).

## Fixes Included On This Branch

1. Show stable `network_projects.id` on Hive project cards and project detail header.
2. Surface `chatHistoryWarning` in the Hive Chat saved-status row when chat-history persistence fails after a successful context write.
3. Add minimal `.hive-project-id` styling for monospace project IDs.

## Checks Run

```bash
npm ci
npm run build
npm run route-smoke
node scripts/hive-project-planning-smoke.mjs
git diff --check
```

All passed on 2026-05-25.

## Residual Risks

- Virtual Hive Chat lazy creation may confuse operators who expect a durable row before first message.
- Hive Secretary / Active Projects cascade still runs outside Board Manager ownership; wiki marks this as transitional.
- Full Board Manager `message_user` delivery depends on Postgres, linked wallet validation for Secretary queueing, and running workers in Docker/Fly.

## Merge Recommendation

**Merge** after integration owner re-runs `npm run build`, `npm run route-smoke`, and `node scripts/hive-project-planning-smoke.mjs` on this branch. Capture the two manual Hive screenshots from the review spec if UX sign-off is required before merge.

---

```text
Review PR: PR-04
Boundary: Hive surface, Hive Chat, context, projects, routing feed
Branch: review/04-hive-surface-routing
Changed files:
  src/features/hive/HiveView.jsx
  src/features/hive/hive.css
  src/main.jsx
  docs/review_burndown/reviews/pr-04-hive-surface-routing.md
Findings:
- P0: none
- P1: project IDs missing from Hive UI (fixed); chatHistoryWarning ignored in Hive Chat UI (fixed)
- P2: virtual Hive Chat lazy create; raw inputs are network-visible by design; manual screenshots not captured
Fixes included: project ID display; chatHistoryWarning surfacing; hive-project-id CSS
Checks run: build, route-smoke, hive-project-planning-smoke, git diff --check
Manual app evidence: not captured (static/route checks only)
Residual risks: lazy Hive Chat row; Secretary cascade still transitional; worker-dependent message_user delivery
Merge recommendation: merge after build + route-smoke + hive-project-planning-smoke re-run
```
