# Browser-Control QA Protocol

This is the release QA protocol for a browser tester driving Task Node through the app. The tester must stay in the browser. The report can only claim what was visible in the rendered app, what persisted after refresh, and what the browser console/network capture showed.

A run that only clicks routes and reports that pages loaded is a route-render pass, not product QA.

## Browser Boundary

The tester is responsible for:

- opening the requested Task Node URL in the requested browser profile;
- using the browser profile exactly as supplied: clean, reused, signed out, or already signed in;
- recording the current URL, visible account identity, route state, and visible errors;
- capturing browser console errors and failed browser requests from the start of the run when the browser supports that capture;
- using in-app pages, in-app status surfaces, route refreshes, and visible before/after values as evidence;
- taking screenshots or text captures for material user-visible states.

The tester must not leave the browser, inspect anything outside the rendered app, infer hidden state, or pause the run to ask the user for help. Money, custody, wallet creation, grant, funding, delete, delink, and send actions are tested only when the prompt already grants that approval.

## Approval Execution Contract

When the prompt grants approval for wallet, custody, funding, task signing, delete, or other write actions, that approval is an instruction to execute the approved app flow, not a reason to stop at the confirmation screen.

If approval is present:

1. Continue through the normal in-app confirmation steps.
2. For a new disposable QA wallet, create the wallet, acknowledge the recovery phrase gate, set a run-scoped QA vault password, confirm it, and finish wallet creation.
3. Do not print the recovery phrase or vault password in the report.
4. Record only non-secret visible proof: wallet address prefix/suffix, linked/unlocked/vault-saved state, visible PFT balance, visible billing credit, grant status, task receipt, transaction prefix/suffix, and refresh behavior.
5. Keep the wallet unlocked long enough to run downstream approved flows: task request submit, chat task request mode, evidence submission when an approved task is available, and wallet lock/unlock checks.
6. If the app blocks the approved flow after confirmation, capture the blocker and continue the rest of the checklist.

Stopping at a seed phrase, password, checkbox, unlock, or final confirmation screen is incomplete when the prompt already approved that action. The report must classify that row as Red or Amber with `approved flow not completed`, not as cautious success.

## No-Interrupt Mode

Browser QA exists so the user does not have to babysit the run. Do not interrupt the user for login, console setup, credentials, approval, or help deciding what to click. Make one autonomous pass, collect the best evidence available, and report once at the end.

If the app is signed out in the supplied browser profile:

1. Record the signed-out state.
2. Open the login dialog.
3. Try only safe existing-session login paths that do not require typing secrets, solving 2FA, approving a consent screen, or changing account security. Use this default order when visible: GitHub, X, email only if a reusable QA inbox/code is already available, Telegram only if a linked QA flow is already available.
4. If a provider asks for a password, code, captcha, device confirmation, new consent, account creation, or destructive permission, abandon that provider attempt and return to the app.
5. If no login path succeeds, continue with the public/signed-out suite: root render, mobile navigation, visible login entry points, public docs, public profile routes when available, System Status if reachable, and representative docs/runbook links.
6. Mark authenticated surfaces Gray with one shared blocker: `No authenticated browser context available`.

Do not repeat the same login blocker for every private surface. Do not write "you need to log in" as the next step. The useful output is a completed autonomous report plus one setup gap for a future run.

Do not stop the whole run after the first Red finding unless the app is unusable. Record the Red issue, continue every independent surface, and return one complete report.

## What Counts As QA

Valid browser-control QA combines four evidence layers:

1. Browser observation: the user-visible path was executed in the target environment.
2. Browser console/network capture: runtime errors and failed browser requests were captured for the run when available.
3. App-state proof: claimed persistence, billing, wallet, task, memory, status, and scheduler behavior was checked through visible app state, refresh behavior, in-app System Status, or another in-app page.
4. Clear pass/fail judgment: each surface gets Green, Amber, Red, or Gray with a concrete blocker.

The following are not enough for Green:

- root page load without the relevant UI workflow;
- no target URL;
- no visible account identity for an authenticated workflow;
- no browser console/network capture when the browser supports it;
- a screenshot or visible text from the wrong account;
- route navigation that does not exercise the action being claimed;
- "not tested because it uses funds/seeds" reported as Green;
- a durable-state claim without refresh or visible in-app state proof.

## Run Types

Pick the run type before starting. Do not silently downgrade scope after beginning.

| Run type | Purpose | Required depth |
| --- | --- | --- |
| Public route render pass | Catch blank screens and layout failures visible without login. | Browser route load, console/network capture when available, desktop and one mobile viewport. |
| Surface smoke | Prove one user surface works. | Browser workflow, console/network capture when available, refresh/persistence check when the surface claims persistence, evidence block. |
| Authenticated surface smoke | Prove one logged-in user surface works. | Requires a signed-in browser context or a safe existing-session login. Browser workflow, console/network capture when available, refresh/persistence check, evidence block. |
| Beta release QA | Prove launch readiness across the matrix below. | Requires authenticated browser context for private surfaces. Full app walkthrough, named account, visible before/after evidence, screenshots or text captures for material states. |
| Money/custody QA | Prove wallet, funding, grants, or PFT actions. | Requires approval already present in the prompt, safe test account, visible before/after balances, idempotency checks where the app exposes them. |
| Regression QA | Prove a specific bug class is fixed. | Reproduce or simulate the old failure through the browser, verify the generalized boundary, include a negative case. |

## Status Colors

Use these meanings exactly.

- Green: browser workflow was tested on the target environment, console/network capture was clean or understood, and visible app state matched the claim.
- Amber: browser workflow partially worked, evidence is incomplete, a non-blocking issue remains, or only visible read-state evidence was gathered.
- Red: workflow failed, was unsafe, produced misleading state, lost data, charged incorrectly, blanked the app, or had uncaught runtime errors.
- Gray: intentionally not tested in this run.

If browser console/network capture is missing, no browser-tested surface can be Green. It is Amber at best.

## Browser Start Checklist

At the start of the run:

1. Open the requested app URL.
2. Start browser console/network capture before the first workflow navigation when available.
3. Record browser/profile type: clean, incognito, reused, signed out, or already signed in.
4. Record the visible signed-in account identity, or record that the app is signed out.
5. Record desktop viewport size.
6. Record mobile viewport size when mobile layout is in scope.
7. Open Help and System Status when docs, schedulers, agents, status rows, or runbook links are in scope.

## Report Format

Use this header:

```text
QA Run:
Date:
Run type:
Tester:
Environment:
App URL:
Browser/profile:
Visible account:
Console/network capture:
System Status page:
Approval scope for money/custody/delete actions:
Autonomous auth attempts:
```

Use this summary:

```text
Summary:
Green:
Amber:
Red:
Gray:

Blocking issues:
1.

Non-blocking issues:
1.

Coverage table:
| ID | Surface | Status | Evidence block | Notes |
```

Use this evidence block for every tested workflow:

```text
Evidence:
ID:
Date:
Environment:
URL:
Account:
Browser/profile:
Surface:
Status color:
Browser actions:
UI path tested:
Expected visible result:
Observed visible result:
Refresh/persistence check:
Visible before/after values:
Console errors:
Network failures:
Screenshots/text captures:
Remaining blocker:
Relevant in-app docs/runbook:
```

Do not include placeholders. The evidence must be complete enough to paste into a task or release note without additional context.

## Default Execution Order

For Beta release QA, use this order unless the prompt explicitly changes it:

1. Start capture, open the target app, and establish visible account state.
2. If signed out, run the no-interrupt auth attempts.
3. If authenticated and wallet creation/signing is approved, make the wallet ready immediately: create or link wallet, save vault, unlock vault, record visible wallet state, refresh, and confirm it remains ready.
4. Run all visible chat modes.
5. Run Tasks negative blocker only if a blocker is still reachable without damaging the approved wallet state.
6. Run approved Tasks request submit.
7. Run Chat `+` -> `Request task`.
8. If a generated task appears and signing is approved, inspect lifecycle and submit harmless text evidence when the task state allows it.
9. Run Context read/write and Context Refine.
10. Run Hive, Profile, Memory, Docs, System Status links, Billing/Pricing, mobile layout, and remaining negative paths.
11. Return one report only after every required visible row is either tested, blocked by an attempted visible app action, or genuinely unavailable in the app.

Do not finish the report immediately after login, one chat call, the first Red issue, the wallet seed gate, or the first task blocker. Those are intermediate findings, not the end of Beta release QA.

## Required App Walkthrough

The sequence below is the default Beta release walkthrough. A row may be Gray only when the prompt removes it from scope, the browser is not authenticated, or the action needs approval that was not already granted.

### Start And Navigation

1. Open root.
2. Confirm the app title and primary chat surface render.
3. Record visible account state.
4. Open Chat, Tasks, Hive, Wallet, Context, Memory, Profile, Help, Docs, and System Status from the app navigation.
5. Refresh at least three representative routes: Chat, Tasks, and Wallet.
6. Repeat root, Tasks, Wallet, Context, Memory, and Help on a mobile viewport.
7. Confirm mobile navigation is visible and usable.
8. Confirm no route produces a blank white screen.

### Login And Account

1. Open the login dialog.
2. Test GitHub login when a safe existing session is available.
3. Test email login only when a reusable QA inbox/code is already available.
4. Test Telegram login/link only when the linked QA flow is already available.
5. Test X login when a safe existing session is available.
6. After login, record Task Node handle, visible display name, and connected provider username/email.
7. Refresh and confirm the same account remains signed in.
8. Open the account menu and confirm Profile, Settings, Help, and Logout match the signed-in state.
9. Test logout only when it will not disrupt an approved ongoing run. Confirm signed-out state appears and private actions are gated.

### Chat

For each visible chat mode, run the same pattern:

1. Select the mode before typing.
2. Record the mode label.
3. Record visible credit/balance before send when shown.
4. Send a short deterministic prompt, such as `Reply with OK and the active mode label.`
5. Confirm the user message appears once.
6. Confirm the assistant response appears and is not truncated.
7. Record the first 200 characters of the response.
8. Record visible credit/balance after send when shown.
9. Refresh and confirm the conversation appears in Recents or the active chat.
10. Repeat for Frontier Instant, Frontier Thinking, Private Instant, Private Thinking, and Discount Thinking / DeepSeek API Direct when visible.
11. For a safe failure path, use only a visible app-supported error case. Confirm the app shows an actionable error and does not duplicate the user message.

In Beta release QA, every visible chat mode is required. Leaving a visible mode untested is an incomplete Chat run, not an acceptable final report.

### Chat Task Request Mode

1. Open Chat.
2. Open the `+` menu.
3. Choose `Request task`.
4. Confirm the composer placeholder changes to `Add any relevant details for your task request`.
5. Enter harmless task details.
6. If wallet is missing, locked, or seed vault is missing and wallet/task signing approval is not present, confirm the blocker is clear and no request is published.
7. If wallet/task signing approval is present, make the wallet ready first, then send the request.
8. Confirm the chat shows a task-request receipt instead of a normal assistant response.
9. Refresh and confirm the receipt persists in the conversation.
10. Open Tasks and confirm the corresponding request or generated task is visible when the app exposes it.

### Context

1. Open Context.
2. Confirm the saved context renders or a clear empty state appears.
3. Edit a harmless line.
4. Save.
5. Refresh and confirm the line persists.
6. Use Context Refine with a bounded prompt.
7. Confirm the refinement proposal is reviewable before applying.
8. Apply only if the change is harmless and in scope.
9. Try Publish to PFT without an unlocked wallet when safe. Confirm the wallet/vault blocker is clear.

### Tasks Overview

1. Open Tasks.
2. Record outstanding count, PFT in flight, chain-indexed count when shown, and requests-processing count when shown.
3. Open each tab: Outstanding, Verification, Refused, Rewarded.
4. Confirm counts match visible cards or empty states.
5. Open one task card when available.
6. Confirm the detail pane opens without losing the app frame on desktop.
7. Confirm Overview, Submit, and Forensics tabs render.
8. Confirm task title, task ID, status, deadline, reward, and event count are visible when present.
9. Refresh and confirm list/detail state remains coherent.

### Task Request From Tasks

Test the missing-wallet blocker even when write actions are not approved:

1. Open Tasks.
2. Click `Request task`.
3. Confirm the modal title is `Request task`.
4. Confirm the helper text says the user should describe the work they want generated.
5. Confirm the `Task details` field is visible.
6. If no wallet is linked, confirm the modal says `A linked PFT wallet is required.`
7. Confirm the primary action is `Open wallet`.
8. Click `Open wallet` only if it does not change custody state. Confirm the app takes the user to the wallet path or opens the wallet gate.
9. Return to Tasks and close the modal.

Test the approved submit path when wallet signing is approved. If no wallet exists and wallet creation is also approved, create the disposable QA wallet first, then continue this path:

1. Open Wallet first.
2. Confirm the account is signed in.
3. Confirm a linked PFT wallet is visible, or create the approved disposable QA wallet from the Wallet page.
4. Confirm the seed vault is saved and unlocked, or complete the approved unlock flow.
5. Return to Tasks.
6. Record the top summary counts.
7. Click `Request task`.
8. Enter a harmless request in `Task details`, such as `Generate a small QA task that can be completed with text evidence.`
9. Click `Request task`.
10. Confirm the primary button changes to `Publishing`.
11. Confirm double-clicking does not create duplicate visible requests.
12. Confirm success text starts with `Task request published to PFT. Transaction`.
13. Confirm the active request strip appears with `Task requests` while generation is pending, or confirm a task card appears if generation has completed.
14. Refresh.
15. Confirm the request receipt persists, the request leaves the strip after becoming a task, or the generated task card is visible.
16. Open the generated task when available and confirm the status and next action are clear.

Do not stop at the task request modal after proving the missing-wallet blocker if wallet creation/signing is approved. The blocker test is only the negative path; the approved submit path must still run.

### Task Lifecycle

For each available lifecycle state, open the task detail and record the visible label and next action:

1. Proposed: Accept and Refuse are clear when available.
2. Accepted: Submit tab focuses on evidence submission.
3. Submitted / Awaiting review: Submit tab shows read-only review state.
4. Verification requested: current verification ask is prominent and `Respond in Submit` routes to the Submit tab.
5. Verification response submitted: review state is clear.
6. Rewarded: reward amount or no-payment explanation is visible.
7. Refused / Cancelled / Expired: final state is visible and primary write actions are gone.

### Evidence Submission

Run only on an approved test task:

1. Open an Accepted or Verification requested task.
2. Open Submit.
3. Confirm the form asks for the current evidence type.
4. Add text evidence.
5. Add URL, screenshot/image, file, or second evidence only when the app exposes that option and the action is safe.
6. Confirm oversized, unsupported, or empty evidence is blocked visibly.
7. Submit evidence only with approved wallet signing.
8. Confirm the button shows a pending state.
9. Confirm the detail view moves to Submitted, Awaiting review, or Verification response submitted.
10. Refresh and confirm the same state remains visible.

### Wallet

1. Open Wallet.
2. Record visible PFT balance and wallet address state.
3. Confirm whether the wallet is linked, not linked, locked, unlocked, or missing a saved seed vault.
4. If no wallet exists, confirm Create wallet and Link wallet actions are visible.
5. Confirm Receive and Send are disabled or gated until the required wallet state is present.
6. Create wallet when already approved. Do not stop at the seed phrase/password gate. Complete the disposable QA wallet flow, keep secrets out of the report, and record linked/unlocked/vault-saved state after refresh.
7. Link wallet only when already approved. Confirm proof flow attaches the intended address.
8. Lock and unlock only when already approved. Confirm signing actions become available only after unlock.
9. Open Backup seed only when already approved. Confirm password is required before revealing the phrase.
10. Delink only on an approved disposable account. Confirm link is removed and signing actions are gated after refresh.

### Funding

Run only when money movement is already approved:

1. Open Wallet or Funding entry point.
2. Start top-up.
3. Confirm supported assets include USDC, USDT, and ETH when expected.
4. Confirm a clean deposit address is shown only when ready.
5. Record visible billing credit before deposit/sync.
6. Complete the approved top-up path.
7. Confirm credit changes once.
8. Repeat the visible sync/refresh path and confirm credit does not duplicate.
9. Confirm any PFT grant state is honest: pending, paid, failed, or blocked by wallet/vault state.

If funding is not approved but wallet creation is approved, still complete wallet creation and task-request signing. Do not mark task request Gray solely because funding was not tested.

### Hive

1. Open Hive.
2. Record active project count, task count, routed PFT, and any board/action summaries visible.
3. Open one active project.
4. Confirm project title, status, next actions, task rows, and routed context are real visible content, not placeholder counts.
5. Open Hive Chat.
6. Send a harmless message only when authenticated.
7. Confirm the message and response persist after refresh.
8. Open the latest visible Board Manager or board-action detail if exposed.
9. Confirm archives/actions are explicit logged board actions in the UI, not unexplained disappearance of user content.

### Telegram

Run only when the browser or app exposes a safe Telegram link/test path:

1. Open the Telegram connection surface.
2. Confirm linked username or unlinked state.
3. For a linked non-owner user, send a harmless message through the approved Telegram path.
4. Confirm the app records or displays the corresponding conversation when that surface exists.
5. For an unlinked user, confirm the bot rejects or explains the linking requirement.

### Profile

1. Open private Profile.
2. Confirm identity, aliases, connected accounts, wallet summary, PFT earned, rewards, drops, NFTs, and daily airdrop panels render when available.
3. Confirm private-only implementation details are not shown as primary user-facing labels.
4. Open public profile view.
5. Confirm public disclosure matches alias/privacy expectations.
6. Confirm private fields, seed/vault state, internal packet IDs, and hidden billing details are absent from public view.
7. Inspect daily airdrop state. Confirm zero-run, pending, paid, or failed states are honest and not presented as user earnings when no payout happened.

### Memory

1. Open Memory.
2. Confirm the layout has breathing room and scroll works on desktop.
3. Repeat Memory on mobile.
4. Confirm memory items use readable labels before packet IDs.
5. Confirm provider/model IDs are hidden unless opened in a diagnostics detail.
6. Open Deep Memory when available.
7. Delete one memory only on an approved test account.
8. Refresh and confirm the deleted item stays gone without unrelated account state disappearing.
9. Clear memory only when already approved. Refresh and confirm the page shows the expected empty state.

### Docs, Help, And System Status

1. Open Help.
2. Open Docs.
3. Confirm docs navigation works.
4. Open System Status.
5. Confirm every visible status row has a label, status color, last-run or freshness text when applicable, and a clickable architecture/runbook link.
6. Click representative links for each visible family: Board Manager, task generation/review, PFTL/RPC, memory, profile/daily airdrop, Ethereum deposits, pgvector/vector search, rendering or app delivery when shown.
7. Confirm each clicked link opens an actual docs page with status-color meanings and debugging guidance.
8. Return to System Status and confirm navigation still works.

### Billing And Pricing

1. Open any visible billing, pricing, model, or status-pricing surface.
2. Confirm current chat modes and model labels match the app controls.
3. Confirm visible pricing text is clear for private, frontier, and discount/direct options when shown.
4. For one approved chat call, record credit before and after.
5. Confirm the visible debit makes sense for the selected mode or the app clearly states pricing is unavailable.
6. For a safe failed call path, confirm failed calls do not visibly charge as successful calls.

## Mandatory Beta Matrix

| ID | Surface | Test | Expected visible result | Required browser evidence |
| --- | --- | --- | --- | --- |
| PRE-01 | Start | Confirm URL, profile, account state, viewport, and System Status page. | No wrong-target ambiguity; app reachable; account state known. | Header plus screenshot/text capture. |
| NAV-01 | Desktop navigation | Open root, Chat, Tasks, Hive, Wallet, Context, Profile, Memory, Help, Docs, System Status. | No white screen; each route has meaningful content. | Console/network capture plus text capture for each route. |
| NAV-02 | Route failure fallback | Observe or safely trigger a route-load failure if the browser supports it. | Visible refresh/retry fallback, not blank screen. | Browser failure capture and UI capture. |
| NAV-03 | Mobile layout | Repeat core route load at mobile viewport. | Page scrolls; primary navigation is accessible. | Viewport size and screenshots/text captures. |
| AUTH-01 | GitHub login | Use safe existing-session GitHub login. | Correct GitHub username attached to intended account. | UI identity before/after refresh. |
| AUTH-02 | Email login | Use supplied reusable email flow. | Email account lands in app and persists after refresh. | UI identity before/after refresh. |
| AUTH-03 | Telegram auth | Use approved Telegram link/auth path. | Telegram identity attaches to intended account. | Connected account UI and refresh. |
| AUTH-04 | X login | Use safe existing-session X login. | Correct X username attached to intended account. | UI identity before/after refresh. |
| AUTH-05 | Session persistence | Refresh and reopen app after login. | Same account remains signed in; no handle modal loop. | Before/after route captures. |
| AUTH-06 | Logout | Log out when safe. | Account state clears and private actions are gated. | UI state before/after refresh. |
| CHAT-01 | Frontier Instant | Send deterministic small prompt. | Response appears, message persists, visible debit recorded when shown. | UI transcript, credit before/after, refresh. |
| CHAT-02 | Frontier Thinking | Send reasoning-mode prompt. | Response arrives without truncation or wrong mode. | Mode label, transcript, refresh. |
| CHAT-03 | Private Instant | Send small prompt. | Response arrives through private route with correct label. | Mode label, transcript, refresh. |
| CHAT-04 | Private Thinking | Send small prompt. | Response arrives through private thinking route. | Mode label, transcript, refresh. |
| CHAT-05 | Discount Thinking | Select `DeepSeek API Direct` and send prompt. | Direct DeepSeek route is labeled correctly and responds. | Label, transcript, visible usage/credit. |
| CHAT-06 | Error path | Use safe app-supported failure case. | Actionable error; no duplicate user message or visible duplicate charge. | Error UI, transcript, credit before/after. |
| CHAT-07 | Chat task request | Use `+` -> `Request task`. | Composer enters task-request mode; receipt or wallet blocker is clear. | Placeholder, receipt/blocker, refresh. |
| CONTEXT-01 | Context read/write | Edit harmless context and save. | Updated content persists. | Before/after text and refresh. |
| CONTEXT-02 | Context Refine | Request bounded refinement and apply. | Proposal is reviewable; only intended content changes. | Proposal, applied result, refresh. |
| CONTEXT-03 | PFT publish blocker | Attempt publish without unlocked wallet when safe. | Clear wallet/vault blocker. | Blocker text and route capture. |
| TASK-01 | Task route | Open Tasks and all tabs. | Counts, tabs, empty states or task cards are coherent. | Text capture for each tab. |
| TASK-02 | Task request blocker | Click `Request task` without ready wallet. | Modal shows linked-wallet or vault/unlock requirement. | Modal capture and Open wallet action. |
| TASK-03 | Task request submit | With approved ready wallet, submit a task request. | Publishing state, success receipt, active request strip or generated task. | Before/after counts, success text, refresh. |
| TASK-04 | Task detail | Open a task card. | Overview, Submit, Forensics render and agree on status. | Detail captures. |
| TASK-05 | Lifecycle states | Inspect proposed, accepted, submitted, verification, rewarded, refused/cancelled when available. | State labels and next actions match lifecycle. | Capture for each available state. |
| TASK-06 | Evidence boundary | Try text/url/screenshot/file evidence where available and approved. | Validation works; unsupported evidence is blocked. | Form captures and result state. |
| WALLET-01 | Wallet read state | Open Wallet. | Linked/no-wallet, balance, address, vault, and action gates are honest. | UI capture and refresh. |
| WALLET-02 | Create wallet | Approved test account only. | Phrase/backup flow is gated; wallet actions update visibly. | Step captures with secrets omitted. |
| WALLET-03 | Missing vault safety | Use linked wallet without saved seed vault when available. | Signing/grant/task actions are blocked. | Blocker text. |
| WALLET-04 | Lock/unlock | Approved test account only. | Signing actions available only after unlock. | Before/after UI. |
| WALLET-05 | Backup seed | Approved test account only. | Password required before phrase reveal. | UI capture with secrets omitted. |
| WALLET-06 | Delink/relink | Approved disposable account only. | Link removed; relink requires fresh proof. | Before/after UI and refresh. |
| FUND-01 | Deposit address | Start top-up when approved. | Address and supported assets are shown only when ready. | UI capture. |
| FUND-02 | USDC credit | Approved funded test path. | USDC credits once. | Visible credit before/after and refresh. |
| FUND-03 | USDT credit | Approved funded test path. | USDT credits once. | Visible credit before/after and refresh. |
| FUND-04 | ETH credit | Approved funded test path. | ETH credits according to policy. | Visible credit before/after and refresh. |
| FUND-05 | PFT grant | Approved qualifying path. | Grant is paid once or honestly blocked/pending. | Grant panel before/after. |
| HIVE-01 | Hive dashboard | Open Hive and compare counts to visible rows. | Counts and rows are coherent. | Dashboard and row captures. |
| HIVE-02 | Hive Chat | Send harmless Hive Chat message when authenticated. | Message persists after refresh. | Transcript and refresh. |
| HIVE-03 | Board action audit | Inspect latest visible board action. | Board messages/archives are explicit logged actions in the UI. | Action/detail capture. |
| HIVE-04 | Project detail | Open active project. | Real title, status, next actions, task rows. | Project capture. |
| TELE-01 | Telegram linked user | Use approved linked Telegram path. | Bot/account linkage works and conversation appears where expected. | Visible connection/conversation capture. |
| TELE-02 | Telegram unlinked user | Use safe unlinked path. | Bot rejects or explains linking requirement. | Visible rejection/linking capture. |
| PROFILE-01 | Private profile | Open private profile. | Identity, aliases, PFT metrics, NFTs, daily airdrop panels render. | Profile capture. |
| PROFILE-02 | Public profile | Open public profile. | Public disclosure is correct; private implementation details absent. | Public route capture. |
| PROFILE-03 | Daily airdrop state | Inspect airdrop panel. | Last run/zero state/payout state is honest. | Panel capture. |
| MEMORY-01 | Memory render | Open Memory. | Layout readable, scroll works, internal IDs not primary labels. | Desktop and mobile capture. |
| MEMORY-02 | Memory delete/clear | Approved test account only. | Deleted memory disappears after refresh without unrelated loss. | Before/after UI and refresh. |
| DOCS-01 | Help navigation | Open Help and Docs. | Docs render and navigation works. | UI capture. |
| DOCS-02 | System Status | Open System Status. | Every row has status, freshness, and architecture/runbook link when applicable. | Status page capture. |
| DOCS-03 | Runbook links | Click representative status links. | Linked docs pages exist and explain status colors and repair. | URL/title capture for each link. |
| BILL-01 | Usage accounting | Compare visible credit before/after one approved chat call. | Credit/debit changes match visible pricing or report unavailable. | Before/after credit and mode label. |
| BILL-02 | Failed call billing | Use safe failed-call path if available. | Failed call does not charge as success. | Error UI and credit before/after. |

## Required Negative Paths

Run these unless the prompt explicitly limits scope.

| ID | Negative path | Expected visible result |
| --- | --- | --- |
| NEG-01 | Missing or expired session opens a private route. | Signed-out/login state, not white screen. |
| NEG-02 | Missing wallet attempts task/context wallet action. | Clear linked-wallet blocker. |
| NEG-03 | Linked wallet with missing saved seed vault attempts signing/grant payout. | Clear seed-vault blocker; no payout. |
| NEG-04 | Locked wallet attempts signing. | Unlock prompt; no signing proceeds. |
| NEG-05 | Provider/model failure during chat. | Actionable error; no duplicate user message. |
| NEG-06 | PFTL status unavailable or degraded in the app. | Wallet/balance/task state degrades honestly. |
| NEG-07 | Deposit readiness unavailable. | Top-up address is not shown as ready. |
| NEG-08 | Scheduler or agent stale in System Status. | Status row is amber/red with a docs link. |
| NEG-09 | Route load failure. | Refresh/retry fallback instead of blank route. |

## Surface Rules

### Auth

For each auth provider tested, include:

- provider username/email shown by the app;
- Task Node handle/display name;
- whether the account was newly created or resumed;
- connected-provider state after refresh;
- logout result when tested.

Do not report "login retained" as the same thing as testing login. A reused session only proves session persistence.

### Chat

Test all exposed modes, not only the default. For each mode include:

- selected mode label before send;
- exact user message;
- first 200 characters of assistant response;
- visible credit before/after when shown;
- conversation title or safe identifier;
- persistence after refresh.

If a mode is not tested, mark that mode Gray. If only one mode is tested, Chat overall is Amber unless the run scope was explicitly one mode.

### Wallet And Funding

Wallet tests must distinguish:

- account login;
- wallet linked to the account;
- seed vault saved in the browser;
- vault unlocked;
- chain-visible PFT balance shown by the app;
- billing credit shown by the app;
- PFT initiation grant state shown by the app.

Never collapse these into one "wallet works" claim.

Money/custody actions require approval already present in the prompt. Without approval, wallet creation, funding, send, delink, seed reveal, and grant payout are Gray or Amber, never Green.

With approval, wallet creation must be completed on the disposable QA account. A report that opens Create wallet, sees the seed/password gate, and cancels before final creation is incomplete for WALLET-02 and cannot claim the downstream task request path was tested.

### Tasks

Route loading is not task QA. A task workflow claim requires at least one of:

- visible blocker tested for missing wallet/vault;
- task request submitted through the browser with approved wallet signing;
- lifecycle state inspected through visible task detail;
- evidence validation tested through the Submit tab;
- task receipt or generated task shown after refresh.

The minimum task-request blocker proof is: Tasks -> Request task -> modal title -> Task details field -> linked-wallet/vault/unlock blocker -> Open wallet action.

The minimum approved task-request submit proof is: Wallet ready -> Tasks -> Request task -> fill Task details -> Publishing state -> success receipt -> active request strip or generated task -> refresh persistence.

When wallet creation/signing is approved and the browser account starts with no wallet, the minimum proof expands to: Wallet -> Create wallet -> seed gate acknowledged -> QA vault password set -> wallet linked/unlocked -> refresh -> Tasks -> Request task -> fill Task details -> Publishing state -> success receipt -> active request strip or generated task -> refresh persistence.

### Hive

Hive QA must compare visible counts to visible rows. If the report says "2 active projects" or "72K PFT routed", it must say where that appeared in the app and whether visible rows agree.

### Docs And System Status

System Status QA must click at least one link in each visible status family:

- Hive / Board Manager;
- task generation or task review;
- PFTL / wallet / RPC health;
- memory;
- profile / daily airdrop;
- Ethereum deposits, vector search, rendering, or app delivery when shown.

Every clicked link must land on an existing docs page. Broken docs links are Red for Docs/System Status.

## Acceptance Rules

Use these gates when reviewing a QA report.

- If console/network capture is missing, every browser-tested surface is at most Amber.
- If the browser started on the wrong URL or wrong account, Preflight is Red.
- If a provider was already signed in and OAuth was not re-run, that provider auth is not tested; session persistence may still be tested.
- If Chat tested only one mode, Chat is Amber unless scope explicitly said one mode.
- If Beta release QA leaves any visible chat mode untested, the report is incomplete for Chat.
- If Wallet did not create/link/unlock or verify the seed-vault gate, Wallet is Amber at best.
- If wallet creation was approved but the tester stopped at the seed/password gate, WALLET-02 is incomplete and downstream task-signing rows remain untested by tester error.
- If Funding did not use approved visible deposit/credit evidence, Funding is Gray or Amber.
- If Tasks only opened a route and saw a wallet blocker, Tasks is Amber.
- If Task request submit was not run with approved wallet signing, TASK-03 is Gray.
- If wallet creation/signing was approved and no task request was submitted, TASK-03 is incomplete unless the app produced a visible blocker after wallet readiness was attempted.
- If System Status links were not clicked and verified, Docs/System Status is Amber.
- If a workflow changes durable user state but there is no refresh check, it is Amber.
- If user-facing state contradicts another visible app state, it is Red.

## Corrective Review Of A Shallow Report

A report with one reused session, one chat mode, no console/network capture, wallet/funding/task write paths not exercised, and System Status viewed but links not clicked is a useful route smoke, not comprehensive QA.

Correct classification:

| Surface | Correct status |
| --- | --- |
| Start | Amber: target loaded, but evidence incomplete. |
| Global route render | Amber: routes loaded, but no console/network capture. |
| Session persistence | Amber: reused session retained; fresh OAuth not proven. |
| Chat | Amber: one mode worked; provider matrix not covered. |
| Wallet | Amber: read state only; custody/funding not exercised. |
| Tasks | Amber: blocker observed only; no request submit or lifecycle. |
| Context | Amber: read/blocker only; refine/save not exercised. |
| Hive | Amber: read-only route/detail; counts not verified against visible rows. |
| Docs/System Status | Amber: rendered, but links/runbooks not verified. |
| Profile | Amber: rendered, but public/private disclosure not verified. |

## Final Release Gate

A beta surface can be called Green only when all are true:

- the workflow was tested through the browser on the requested environment;
- console/network capture was active when available;
- account identity is named and matches the intended test account;
- visible result is recorded;
- after-refresh persistence is checked for durable state;
- in-app state supports the claim;
- remaining blocker is none;
- relevant docs/runbook link exists and was opened when operational status is involved.

If any condition is missing, downgrade to Amber or Red and state exactly what remains untested.
