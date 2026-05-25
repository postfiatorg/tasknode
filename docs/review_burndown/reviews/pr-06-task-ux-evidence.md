# PR-06 Review: Task UX, Evidence, Copy, And Unlock

Date: 2026-05-25
Branch: `review/06-task-ux-evidence`
Base: `origin/main` @ `d01d391`

## Summary

Reviewed task detail UX, evidence submission, copy-task brief, wallet unlock routing,
and task-kind surfacing across `src/features/tasks/**`, `src/main.jsx`,
`server/task-request.js`, and `server/product-contracts.js`. The task detail pane,
status vocabulary, verification-first layout, opt-in second evidence, styled file
picker, Codex copy format, and single wallet-unlock modal match the product spec.
Two maintainability gaps remain: refuse is hidden on proposed tasks while the wallet
is locked, and requested task kind is not validated server-side against Product
values.

## Findings

### P0

None.

### P1

1. **Refuse action is hidden on proposed tasks when the wallet is locked**
   - **File/line:** `src/features/tasks/TaskDetailModal.jsx:477-477`, `548-549`
   - **Severity:** P1
   - **Impact:** `showStopButton` requires `signingReady || !actions.canAccept`. On
     proposed tasks (`canAccept: true`) with a locked vault, only the Accept /
     Unlock wallet button renders. Users cannot refuse an unwanted offer without
     unlocking first, which contradicts `docs/wiki/surfaces/tasks.md` ("Proposed
     tasks show both Accept task and Refuse task") and blocks a no-signing exit
     path.
   - **Verification:** Read `TaskLifecycleActionPanel` guard; Accept already routes
     locked clicks through `handleSigningUnlockAction`; Refuse should do the same
     when visible.
   - **Fix:** Show the refuse/cancel button whenever `actions.canStop`, even when
     `!signingReady`; keep the unlock routing on click.

### P2

1. **`requestedTaskKind` is not restricted to Product values on the server**
   - **File/line:** `server/task-request.js:82`, `server/task-request-intent.js:40`
   - **Severity:** P2
   - **Impact:** Any string up to 80 characters is accepted. Review spec expects
     `personal`, `network`, and `alpha` only. Mis-typed or forged kinds could reach
     the generation worker without a deterministic 400.
   - **Verification:** No enum check in `taskRequestConfig` or intent start; UI
     hardcodes `"personal"` in `TaskRequestModal.jsx:75` and chat task-request
     paths in `src/main.jsx:1480`.
   - **Fix:** Validate against `{ personal, network, alpha }` and gate network/alpha
     with `taskProductConfig()` flags before bundle build.

2. **Review spec script name does not match `package.json`**
   - **File/line:** `docs/review_burndown/recent_work_pr_review_spec_2026-05-24.md:476`, `package.json:48`
   - **Severity:** P2
   - **Impact:** Spec lists `npm run task-request-unlock-smoke`; repo exposes
     `task-request-unlock-policy-smoke`. Review agents must discover the alias
     manually.
   - **Verification:** `npm run task-request-unlock-smoke` fails; policy smoke passes.
   - **Fix:** Add a package alias or update the spec to the existing script name.

3. **Task request UI exposes no kind selector despite Product config flags**
   - **File/line:** `src/features/tasks/TaskRequestModal.jsx:75`, `server/task-product-config.js:14-16`
   - **Severity:** P2 (product gap, not a regression)
   - **Impact:** `GET /api/tasks` returns `networkRequestEnabled` /
     `alphaRequestEnabled`, but the modal always publishes `personal`. Network and
     alpha tasks are only reachable through Board Manager / worker paths today.
   - **Verification:** Local `curl http://localhost:5174/api/tasks` →
     `networkRequestEnabled: false`, `alphaRequestEnabled: false`.
   - **Fix:** Document as intentional until network user-initiated requests ship, or
     add a gated kind picker when flags enable those paths.

4. **Manual task-state screenshots were not captured in this review environment**
   - **Severity:** P2 (evidence gap)
   - **Impact:** Static/CSS and smoke coverage prove copy, unlock policy, and build
     health, but proposed / verification / rewarded detail screenshots require a
     signed-in wallet with indexed projections. Local Docker returned
     `wallet_required` with zero tasks during review.
   - **Verification:** `curl http://localhost:5174/api/tasks` without session.
   - **Fix:** Integration owner should attach screenshots when merging if Fly dev
     or a seeded local wallet has representative task rows.

## What Looks Correct

- Task detail opens as an in-workspace cover pane (`task-modal-layer` fixed over
  Tasks, sidebar remains visible; full viewport on mobile). Wash overlay is
  disabled so the pane reads as part of the Tasks surface.
- List tabs and detail headers share lifecycle labels from `shared/task-lifecycle.js`
  (`Proposed`, `Verification requested`, `Awaiting review`, `Rewarded`, etc.).
- Verification-requested Overview foregrounds the current ask; original task details
  stay behind a Show/Hide toggle (`TaskOriginalContext`).
- Second evidence is opt-in via `Add second evidence`; drafts reset per submission
  phase (`submissionModeKey` effect in `TaskSubmitPanel`).
- File and screenshot pickers use styled `.task-file-picker` pills with hidden native
  inputs (`task-detail.css:791-818`).
- `buildTaskCopyPayloads` produces Codex-friendly briefs with title, description,
  steps, verification, task ID, request ID, reward, deadline, current verification
  request, and requested output (`task-copy-format.js`, covered by
  `scripts/task-copy-payload-smoke.mjs`).
- Accept and refuse/cancel share one unlock policy (`task-request-unlock-policy.js`)
  and one modal entry point (`openWalletVaultControl` in `src/main.jsx:1212-1219`).
  Task detail disables Escape while unlock is open (`escapeDisabled={walletUnlockOpen}`).
- Visible task kinds on list/detail are limited to `Personal`, `Network`, and `Alpha`
  via `publicTask()` in `server/repositories/tasks.js:108-109`.

## Checks Run

```bash
npm ci
npm run build
npm run task-request-unlock-policy-smoke   # spec name: task-request-unlock-smoke
npm run chat-markdown-smoke
node scripts/task-copy-payload-smoke.mjs
git diff --check
```

Manual evidence:

- `curl http://localhost:5174/api/tasks` → build-served API responds; task sync
  `wallet_required` without session (expected).
- Read `task-detail.css` and `TaskDetailModal.jsx` for workspace-cover layout,
  verification panel ordering, and unlock routing.

## Residual Risks

- Refuse-hidden-when-locked blocks a documented proposed-task workflow until fixed.
- Server-side kind validation is permissive; worker behavior for unknown kinds is
  undefined.
- End-to-end evidence publish (screenshot vision + PFTL submit) was not exercised
  live in this review pass.

## Merge Recommendation

**Merge** after integration owner re-runs `npm run quality` on this branch. Track
the proposed-task refuse visibility fix separately if product wants a no-unlock
refusal path before the next feature PR.

---

```text
Review PR: PR-06
Boundary: Task detail UX, evidence, copy, unlock
Branch: review/06-task-ux-evidence
Changed files:
  docs/review_burndown/reviews/pr-06-task-ux-evidence.md
  docs/review_burndown/burndown.md
Findings:
- P0: none
- P1: refuse hidden on proposed tasks when wallet locked
- P2: requestedTaskKind not enum-validated; spec script name drift; no UI kind selector; no live task-state screenshots
Fixes included: none (review-only)
Checks run: build, task-request-unlock-policy-smoke, chat-markdown-smoke, task-copy-payload-smoke, git diff --check
Manual app evidence: API/tasks wallet_required without session; code/CSS review of detail pane and unlock routing
Residual risks: refuse UX gap; permissive task kind; no live evidence publish in this pass
Merge recommendation: merge after quality re-run; fix refuse visibility in follow-up
```
