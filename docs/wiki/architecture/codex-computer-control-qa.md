# Browser-Control QA Protocol

This is the release QA protocol for a browser automation tester driving Task Node through a real browser. It is intentionally stricter than a click-through checklist. The goal is to prove user workflows, observable app state, and the backing system state that makes those workflows trustworthy.

This document is written for a browser-control tool. It must not require that tool to run `npm`, Python, Docker, Fly CLI, local repo commands, or shell scripts. Repo, deploy, and machine evidence may be supplied by an operator as supporting evidence, but browser QA itself happens in the browser.

A QA run that only clicks routes and reports that pages loaded is a route-render pass, not product QA.

## Capability Contract

The browser automation tester is responsible for:

- opening the requested Task Node URL in the requested browser profile;
- using a clean, reused, or already-authenticated profile exactly as instructed;
- completing OAuth/login flows only when credentials and human approval are available;
- recording the current URL, visible account identity, visible route state, and visible errors;
- capturing console and network failures from the start of the run when the tool supports DevTools or browser protocol capture;
- using same-origin browser fetches for `/api/app-state` and `/api/system/status` when authenticated API evidence is needed;
- taking screenshots or text captures for material user-visible states.

The browser automation tester is not responsible for:

- discovering the local repo path;
- running `git`, `npm`, Python, Docker, or Fly commands;
- inspecting server files or local source files;
- fixing failed background jobs;
- making money, custody, wallet creation, grant, funding, delete, or delink actions without explicit approval.

If the browser tool cannot use a logged-in profile or complete an auth flow, mark that auth workflow Gray or Amber and state the missing credential/session boundary. Do not replace login QA with shell/API inspection.

## Login Requirement

An internal anonymous browser is not valid for Beta release QA. It can only run a public route-render pass: root load, signed-out state, public docs, public profile routes, and visible auth entry points.

If the requested run includes Chat, Context, Tasks, Hive, Wallet, Memory, Profile private state, billing, Telegram linkage, or System Status as an authenticated surface, the tester must start from one of these:

- a real logged-in browser profile supplied by the user;
- a reusable browser storage state/session explicitly supplied for QA;
- a human-assisted OAuth/login flow completed during the run.

If none of those are available after the no-interrupt auth attempts below, continue with public/signed-out checks and report the authenticated matrix as blocked by missing authenticated browser context. Do not spend the run clicking the same logged-out blocker for every private surface and do not classify logged-in app behavior from an anonymous browser.

## No-Interrupt Mode

Browser QA exists so the user does not have to babysit the run. Do not interrupt the user for login, console setup, credentials, one-off approval, or help deciding what to click. Make one autonomous pass, collect the best evidence available, and report once at the end.

If the app is signed out in an existing Chrome profile:

1. Record the signed-out state.
2. Open the login dialog.
3. Try only safe existing-session login paths that do not require typing secrets, solving 2FA, approving a consent screen, or changing account security. Use this default order when visible: GitHub, X, email only if a reusable QA inbox/code is already supplied, Telegram only if a linked QA flow is already available.
4. If a provider asks for a password, code, captcha, device confirmation, new consent, account creation, or destructive permission, abandon that provider attempt and return to the app. Do not ask the user to intervene mid-run.
5. If no login path succeeds, continue with the public/signed-out suite: root render, mobile navigation, visible login entry points, public docs, public profile routes when available, System Status if publicly reachable, and representative docs/runbook links.
6. Mark authenticated surfaces Gray with one shared blocker: `No authenticated browser context available`.

Do not repeat the same blocker per surface. Do not write "you need to log in" as the next step. The useful output is a completed autonomous report plus a single setup gap for a future run, such as "Provide a persistent QA account/session before the next Beta QA run."

## What Counts As QA

Valid browser-control QA combines four evidence layers:

1. Browser observation: the user-visible path was executed in the target environment.
2. Console and network capture: DevTools or Chrome DevTools Protocol captured runtime exceptions and failed requests for the whole run.
3. State verification: app state, system status, logs, or database/API rows prove the UI is backed by durable state when the workflow claims persistence, billing, workers, wallet custody, or scheduler behavior.
4. Clear pass/fail judgment: each surface gets Green, Amber, Red, or Gray with a concrete blocker.

The following are not enough for Green:

- root HTTP `200` without the relevant UI workflow;
- no target URL or build/source evidence when the app/operator can provide it;
- no console/network capture;
- a screenshot or visible text from the wrong account;
- an API/database check without browser observation for a user workflow;
- route navigation that does not exercise the action being claimed;
- "not tested because it uses funds/seeds" reported as Green.

## Run Types

Pick the run type before starting. Do not silently downgrade scope after beginning.

| Run type | Purpose | Required depth |
| --- | --- | --- |
| Public route render pass | Catch blank screens and layout failures that are visible without login. | Browser route load, console/network capture, desktop and one mobile viewport. Must stay limited to public/signed-out behavior. |
| Surface smoke | Prove one user surface works. | Browser workflow, console/network capture, one backing API/state check, evidence block. |
| Authenticated surface smoke | Prove one logged-in user surface works. | Requires logged-in profile, supplied storage state, or human-assisted OAuth. Browser workflow, console/network capture, one backing API/state check, evidence block. |
| Beta release QA | Prove production-readiness across launch scope. | Requires authenticated browser context. Full matrix below, named account, status/API/log evidence, screenshots for material UX states. |
| Money/custody QA | Prove wallet, funding, grants, or PFT actions. | Explicit user approval, safe test account, before/after balances, idempotency check, chain/deposit evidence. |
| Regression QA | Prove a specific bug class is fixed. | Reproduce old failure or simulate it, verify generalized boundary, add negative case. |

## Required Artifacts

Every Beta release QA run must produce these artifacts or mark the run incomplete:

- browser automation transcript with target URL, run date, route sequence, and major actions;
- browser profile type and whether it was clean, incognito, or reused;
- account identity: Task Node handle plus external provider username or email, with secrets omitted;
- console/runtime event log for the whole run;
- network failure log for the whole run, including request URL path, status, and method;
- `/api/app-state` summary for the tested account, redacted for session ids and secrets;
- `/api/system/status` summary when workers, schedulers, RPCs, memory, Hive, tasks, wallet, or docs are in scope;
- screenshots or text captures for each user-visible state transition being claimed;
- one evidence block per surface or workflow.

For Fly dev, also include:

- visible System Status page state or same-origin `/api/system/status` output;
- current app bundle, build identifier, or operator-supplied Git SHA if available;
- operator-supplied Fly machine/process evidence when the surface depends on worker or board-manager health.

## Status Colors

Use these meanings exactly.

- Green: browser workflow was tested on the target environment, console/network capture was clean or understood, and backing state matched the UI.
- Amber: browser workflow partially worked, evidence is incomplete, a non-blocking issue remains, or only supporting evidence was gathered.
- Red: workflow failed, was unsafe, produced misleading state, lost data, charged incorrectly, blanked the app, or had uncaught runtime errors.
- Gray: intentionally not tested in this run.

If console/network capture is missing, no browser-tested surface can be Green. It is Amber at best.

## Browser Start Preamble

At the start of a browser-control QA run:

1. Open the requested app URL.
2. Start console and network capture before the first workflow navigation when the tool supports it.
3. Record browser/profile type: clean, incognito, reused, or already logged in.
4. Record the visible signed-in account identity, or record that the app is signed out.
5. Open Help -> System Status, or use same-origin browser fetch for `/api/system/status`, when workers, schedulers, RPCs, memory, Hive, tasks, wallet, or docs are in scope.
6. Record any build/source identifier surfaced by the app. If the app does not surface one, use operator-supplied build evidence if provided.

## Optional Operator Support Evidence

Operator support evidence can strengthen a report, but it is not a browser automation requirement. If supplied, paste it into the QA report as "Operator support evidence" and keep it separate from browser observations.

Useful operator evidence includes:

- deploy SHA or build identifier;
- Fly background guard output;
- `/api/system/status` captured outside the browser;
- relevant server logs for a worker, scheduler, RPC, or webhook;
- database/API row summaries for billing, wallet, tasks, Hive, memory, or Telegram.

Missing operator evidence downgrades only the surfaces that require backing-state proof. It should not cause a browser-control tool to run shell commands.

## Browser Capture Requirement

Computer-control QA must capture browser errors from the start of the run.

Minimum captured event classes:

- `Runtime.exceptionThrown`;
- `Log.entryAdded`;
- failed `Network.loadingFailed`;
- HTTP responses with status `>= 400`;
- current URL after each route transition;
- `document.body.innerText` summary after each major state.

Manual Chrome is acceptable only if DevTools Console and Network are open before the first navigation and the final report includes copied error/failure output. A manual run with "DevTools not captured" is not a valid Green QA run.

## Report Format

Use this header:

```text
QA Run:
Date:
Run type:
Tester:
Environment:
App URL:
Build/source evidence:
Account(s):
Browser/profile:
Console/network capture:
System-status capture:
Operator support evidence:
Approval scope for money/custody actions:
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
Operator support commands:
UI path tested:
Expected result:
Observed result:
State/API/log verification:
Console errors:
Network failures:
Screenshots/text captures:
Remaining blocker:
Relevant docs/runbook:
```

Do not include "Add to chat" placeholders. The evidence must be complete enough to paste into a task or release note without additional context.

## Mandatory Beta Matrix

The matrix below is the default launch QA scope. A row may be Gray only when the user explicitly removed it from scope or the environment lacks required credentials/funds.

| ID | Surface | Test | Expected result | Required supporting evidence |
| --- | --- | --- | --- | --- |
| PRE-01 | Preflight | Confirm target URL, browser profile, account state, build/source evidence if available, and System Status. | No wrong-target ambiguity; app reachable; account state known; worker and board-manager state known when in scope. | browser transcript, System Status page or `/api/system/status`, operator guard/build evidence if supplied. |
| NAV-01 | Global navigation | Load root, Chat, Tasks, Hive, Wallet, Context, Profile, Memory, Docs. | No white screen; sidebar persists; each route has meaningful content. | console/network log plus text capture for each route. |
| NAV-02 | Stale bundle failure | Simulate or observe blocked lazy chunk for one route. | Visible refresh fallback, not blank screen. | DevTools blocked URL or documented simulation. |
| NAV-03 | Mobile layout | Repeat core route load at mobile viewport. | Page scrolls; no inaccessible primary controls. | viewport size and screenshots/text captures. |
| AUTH-01 | GitHub login | Clean browser profile, GitHub OAuth, return to app. | Correct GitHub username attached to intended account. | UI identity plus `/api/app-state` provider summary. |
| AUTH-02 | Email login | Clean browser profile, email code/magic-link flow. | Email account lands in app and persists after refresh. | UI identity plus auth event/API summary. |
| AUTH-03 | Telegram auth | Non-owner Telegram user links or authenticates. | Telegram identity attaches to intended account. | UI connected account plus Telegram event/log summary. |
| AUTH-04 | X login | Clean browser profile, X OAuth, return to app. | Correct X username attached to intended account. | UI identity plus `/api/app-state` provider summary. |
| AUTH-05 | Session persistence | Refresh and reopen app after login. | Same account remains signed in; no handle modal loop. | UI state before/after refresh. |
| AUTH-06 | Logout | Log out. | Account state clears and wallet unlock state clears. | UI state plus app-state summary. |
| CHAT-01 | Frontier Instant | Send a deterministic small prompt. | Response appears, message persists after refresh, billing records. | UI transcript, credit before/after, conversation state. |
| CHAT-02 | Frontier Thinking | Send a reasoning-mode prompt. | Response arrives without truncation or wrong mode. | UI transcript, provider/mode label, usage evidence. |
| CHAT-03 | Private Instant | Send a small prompt. | Response arrives through private route with correct label. | UI transcript and billing/provider summary. |
| CHAT-04 | Private Thinking | Send a small prompt. | Response arrives through private thinking route. | UI transcript and billing/provider summary. |
| CHAT-05 | Discount Thinking | Select `DeepSeek API Direct` and send prompt. | Direct DeepSeek route is labeled correctly and responds. | UI label, provider route/usage evidence. |
| CHAT-06 | Error path | Force or observe provider/API failure where safe. | User sees actionable error; no duplicate charge or duplicate user message. | network error and billing/conversation evidence. |
| CONTEXT-01 | Context read/write | Open Context, edit a harmless line, save/refresh. | Updated content persists. | before/after text capture plus app-state/API summary. |
| CONTEXT-02 | Context Refine | Request a bounded refinement and apply it. | Proposal is reviewable; apply changes only intended content. | UI proposal, applied result, persistence after refresh. |
| CONTEXT-03 | PFT publish blocker | Attempt publish without unlocked wallet. | Clear wallet/vault blocker. | UI blocker text and console/network capture. |
| WALLET-01 | No-wallet state | Open Wallet on account with no wallet. | Create/link actions visible; no fake address/balance. | UI capture plus app-state wallet summary. |
| WALLET-02 | Create wallet vault gate | Create wallet in approved test account. | Phrase generated locally; password required; vault saved before grant payout. | UI steps, local vault state, app-state wallet summary. |
| WALLET-03 | Missing vault safety | Use linked wallet with no local vault or simulate it. | Signing/grant payout blocked; no "send grant" without vault. | UI blocker plus `/api/wallet/initiation/retry` rejection without local confirmation. |
| WALLET-04 | Lock/unlock | Lock and unlock saved vault. | Visible state changes; signing-only actions become available only when unlocked. | UI state before/after plus app-state summary. |
| WALLET-05 | Backup seed | Open backup flow. | Password required; phrase not visible before password. | UI capture with secrets omitted. |
| WALLET-06 | Delink/relink | Delink only in approved disposable account. | Server link removed; local vault cleared; relink requires fresh proof. | before/after app-state and UI. |
| FUND-01 | Deposit address | Start top-up. | Clean Ethereum address allocated; supported assets shown. | UI capture plus deposit API summary. |
| FUND-02 | USDC credit | Use approved funded test path. | USDC credits usage once; duplicate sync idempotent. | before/after usage ledger and UI credit. |
| FUND-03 | USDC PFT grant | After qualifying USDC and vault unlock, send grant if approved. | PFT grant sent once; tx recorded; repeat blocked. | grant row, tx hash, UI balance/activity. |
| FUND-04 | USDT credit | Approved test deposit/sync. | USDT credits usage once. | usage ledger and UI credit. |
| FUND-05 | ETH credit | Approved test deposit/sync. | ETH credits according to policy. | usage ledger and UI credit. |
| TASK-01 | Task request blocker | Try request without wallet. | Clear linked-wallet requirement. | UI capture. |
| TASK-02 | Task request submit | With approved wallet/vault, submit a task request. | Acknowledgment and deterministic submitted state visible. | UI state plus task projection/API row. |
| TASK-03 | Lifecycle states | Inspect or fixture submitted, under review, accepted, rejected, rewarded. | State labels and next actions match docs. | UI captures for each state plus projection rows. |
| TASK-04 | Evidence boundary | Try text/url/screenshot/file evidence where available. | Validation works; oversized/unsupported evidence blocked. | UI validation and network capture. |
| HIVE-01 | Hive dashboard | Open Hive and compare active counts to rows. | Counts match visible projects/tasks. | UI capture plus Hive API/status summary. |
| HIVE-02 | Hive Chat | Send Hive Chat message. | Message persists; durable conversation updates. | UI before/after plus chat/message row or API summary. |
| HIVE-03 | Board action audit | Inspect latest Board Manager action. | Board messages/archives are explicit logged actions. | System Status row plus architecture link and run row summary. |
| HIVE-04 | Project detail | Open active project. | Real project title, status, next actions, task rows; no fake counts. | UI capture plus row/API summary. |
| TELE-01 | Telegram bot linked user | Send message from linked non-owner Telegram user. | Bot replies and logs message to account conversation. | Telegram event log plus UI conversation. |
| TELE-02 | Telegram unlinked user | Send from unlinked user if safe. | Bot rejects or explains linking requirement. | Telegram event log. |
| PROFILE-01 | Private profile | Open private profile. | Identity, aliases, PFT metrics, NFT/daily airdrop panels render. | UI capture plus app-state/profile API summary. |
| PROFILE-02 | Public profile | Open public profile route/session. | Public info obeys alias disclosure; no private internals. | public route capture. |
| PROFILE-03 | Daily airdrop state | Inspect airdrop panel. | Last run/zero state/payout state is honest. | UI capture plus airdrop status row. |
| MEMORY-01 | Memory render | Open Memory. | Layout readable, scroll works, no internal packet ids as primary labels. | desktop and mobile capture. |
| MEMORY-02 | Memory delete/clear | Approved test account only. | Deleted memory disappears after refresh without deleting unrelated state. | before/after UI plus API/state summary. |
| DOCS-01 | Help navigation | Open Help and docs page. | Docs render and navigation works. | UI capture. |
| DOCS-02 | System Status | Open System Status. | Every row has status, last run, and architecture/runbook link. | UI capture plus `/api/system/status`. |
| DOCS-03 | Runbook links | Click representative status links. | Linked architecture pages exist and describe green/amber/red and repair. | URL/title capture for each link. |
| BILL-01 | Usage accounting | Compare chat credit before/after one call. | Credit/debit changes match expected configured pricing or reports unavailable. | UI credit plus ledger summary. |
| BILL-02 | Failed call billing | Force safe failed call if possible. | Failed call does not charge as success. | provider error and ledger evidence. |

## Required Negative Path Suite

Run these unless the user explicitly limits scope.

| ID | Negative path | Expected result |
| --- | --- | --- |
| NEG-01 | Expired or missing session hits private routes. | Signed-out/login state, not white screen. |
| NEG-02 | Missing wallet attempts wallet-bound task/context action. | Clear linked-wallet blocker. |
| NEG-03 | Linked wallet with missing local vault attempts signing/grant payout. | Clear local-vault blocker; no payout. |
| NEG-04 | Locked vault attempts signing. | Unlock prompt; no server-side seed request. |
| NEG-05 | Provider/model failure during chat. | Actionable error; no duplicate user message. |
| NEG-06 | PFTL RPC unavailable or degraded. | Wallet balance/transaction status degrades honestly. |
| NEG-07 | Ethereum clean-address probe unavailable. | Top-up address not exposed as ready. |
| NEG-08 | Worker/scheduler stale. | System Status amber/red with runbook link. |
| NEG-09 | Lazy route chunk blocked. | Refresh fallback instead of blank route. |

## Surface-Specific Detail

### Auth

For each auth provider, the QA report must include:

- provider username/email shown by the app;
- Task Node handle/display name;
- whether the account was newly created or resumed;
- connected-provider state after refresh;
- logout result.

Do not report "login retained" as the same thing as testing login. A reused session only proves session persistence.

### Chat

Test all exposed modes, not only the default. For each mode include:

- selected mode label before send;
- exact user message;
- first 200 characters of assistant response;
- before/after credit or usage state;
- conversation id or safe conversation title;
- persistence after refresh.

If a mode is not tested, mark that mode Gray. If only one mode is tested, Chat overall is Amber, not Green.

### Wallet And Funding

Wallet tests must distinguish:

- account login;
- server wallet link;
- browser encrypted vault saved;
- browser vault unlocked;
- chain balance;
- account billing credit;
- PFT initiation grant.

Never collapse these into one "wallet works" claim.

Money/custody actions require explicit approval in the report header. Without approval, wallet creation, funding, send, delink, and grant payout are Gray or Amber, never Green.

### Tasks

Route loading is not task QA. A task workflow claim requires at least one of:

- visible blocker tested for missing wallet/vault;
- submitted task request and projection;
- lifecycle state fixture with UI captures;
- evidence submission validation;
- review/reward worker evidence.

### Hive

Hive QA must compare visible counts to backing state. If the report says "2 active projects" or "72K PFT routed", it must say where that came from and whether visible rows agree.

### Docs And System Status

System Status QA must click at least one link in each status family:

- Hive/Board Manager;
- task workers;
- PFTL cache/RPC;
- memory workers;
- profile/daily airdrop;
- Ethereum deposits or pgvector when present.

Every clicked link must land on an existing docs page. Broken docs links are Red for Docs/System Status.

## Acceptance Rules

Use these gates when reviewing a QA report.

- If the report says `Console/network errors: Not captured`, every browser-tested surface is at most Amber.
- If the browser opened the wrong app URL, wrong environment, wrong account, or wrong browser profile, the affected workflow is Red.
- If the run uses an internal anonymous browser, only public/signed-out route behavior can be tested. Authenticated surfaces must be Gray or blocked, not Amber or Green.
- If the requested scope is Beta release QA and no authenticated browser context is available, run the no-interrupt public/signed-out suite, then report the missing logged-in profile/session once as the shared blocker for authenticated surfaces.
- If build/source evidence is missing because the app does not surface it and no operator evidence was supplied, Preflight is Amber, not Red.
- If a provider was already signed in and OAuth was not re-run, that provider auth is not tested.
- If Chat tested only one mode, Chat is Amber unless scope explicitly said one mode.
- If Wallet did not create/link/unlock or verify the local-vault gate, Wallet is Amber at best.
- If Funding did not use approved deposit/sync evidence, Funding is Gray or Amber, not Green.
- If Tasks only opened a route and saw a wallet blocker, Tasks is Amber.
- If System Status links were not clicked and verified, Docs/System Status is Amber.
- If a workflow changes durable state but there is no after-refresh or backing-state check, it is Amber.
- If user-facing state contradicts backing state, it is Red.

## Corrective Review Of A Shallow Report

The example below is how to classify a route-clicking report like:

- internal anonymous browser;
- no reusable logged-in session;
- safe existing-session login attempts did not complete;
- no chat mode exercised because the app was signed out;
- no console/network capture;
- no build/source evidence from the app or operator;
- wallet/funding/task write paths not exercised;
- system status viewed but runbook links not clicked.

Correct classification:

| Surface | Correct status |
| --- | --- |
| Preflight | Amber: target URL loaded, but build/source evidence and operator worker evidence are missing. |
| Public route render | Amber: public signed-out routes, mobile navigation, docs, and visible login entry points were tested. |
| Beta release QA | Blocked: one shared blocker, no authenticated browser context after safe no-interrupt login attempts. |
| X session persistence | Gray: no signed-in profile or OAuth flow was available. |
| Chat | Gray: signed-out browser cannot test logged-in chat behavior. |
| Wallet | Amber: no-wallet read state only; custody/funding not exercised. |
| Tasks | Amber: blocker observed only; no task lifecycle. |
| Context | Amber: read/blocker only; refine/save not exercised. |
| Hive | Amber: read-only route/detail; counts not verified against backing state. |
| Docs/System Status | Amber: rendered, but links/runbooks not verified. |
| Profile | Amber: rendered, but public/private disclosure not verified with backing state. |

That report can be useful as a quick route smoke, but it is not comprehensive QA.

## Final Release Gate

A beta surface can be called Green only when all are true:

- the workflow was tested through the browser on the requested environment;
- console/network capture was active for the workflow;
- account identity is named and matches the intended test account;
- visible result is recorded;
- after-refresh persistence is checked for durable state;
- supporting API/log/database evidence is included for workers, billing, wallet, tasks, Hive, memory, status, and docs links;
- remaining blocker is `none`;
- relevant docs/runbook link exists and was opened when operational status is involved.

If any condition is missing, downgrade to Amber or Red and state exactly what remains untested.
