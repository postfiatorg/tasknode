# Codex Computer Control QA Checklist

This checklist is for Codex or another computer-control agent testing Task Node through the browser. It is meant for beta-release QA where the user wants product confidence, not only code-level smoke tests.

Computer-control QA must prove what a user can see and do. API calls, database queries, and logs are supporting evidence, but they do not replace direct UI observation when the checklist item is a user workflow.

## Rules Of Engagement

- Test the requested environment explicitly: local Docker, local Vite, Fly dev, or production.
- Record the exact URL, account, browser profile type, app build or Git SHA when available, and timestamp.
- Use a fresh incognito or temporary browser profile for auth tests unless the test intentionally depends on an existing session.
- Do not expose session cookies, seeds, private keys, wallet passwords, OAuth codes, Telegram tokens, or API keys in reports.
- Do not create, reset, delink, or fund accounts outside the requested test account.
- Do not spend real funds or submit real PFT transactions unless the user explicitly asked for that live path.
- Do not mark a workflow green from code inspection, local build success, or a screenshot of a different account.
- If direct API or database checks are used, label them as supporting evidence and still report whether the visible UI matched.

## Status Colors

Use these colors consistently in the final QA report.

- Green: tested through the browser on the target environment and behavior matched expected results.
- Amber: partially tested, worked with caveats, or only supporting evidence was collected.
- Red: tested and failed, blocked the workflow, or produced unsafe/confusing user-visible state.
- Gray: not tested in this run.

## Evidence Block

Every tested surface should end with one evidence block in this format.

```text
Evidence:
Date:
Environment:
URL:
Account:
Browser/profile:
Surface:
Status color:
Commands run:
UI path tested:
Observed result:
Console/network errors:
Supporting logs or rows:
Remaining blocker:
Relevant docs/runbook:
```

## Preflight

- Confirm repo and branch: `git status --short` and `git rev-parse --short HEAD`.
- Confirm target app URL opens and the root page is not blank.
- Confirm the deployed app build contains the expected latest bundle if testing Fly.
- Confirm worker and board-manager process health when testing scheduler-dependent features.
- Confirm System Status is reachable in Help.
- Confirm the test account and expected identity before mutating user state.
- Confirm browser console capture is enabled before beginning route or workflow testing.
- Confirm screenshots or text captures are stored only if they do not expose secrets.

## Global Render And Navigation

- Root app loads without a white screen.
- Sidebar renders with Chat, Tasks, Hive, Wallet, Context, and More.
- Route changes do not blank the app.
- Back/forward browser navigation preserves a sane app state.
- Refreshing each primary route returns to the same surface.
- Stale bundle or blocked lazy chunk shows a visible refresh fallback instead of a blank page.
- Mobile viewport can scroll vertically and no primary content is trapped off-screen.
- Desktop viewport has no overlapping headers, cards, toolbars, or buttons.
- Console has no uncaught runtime exceptions.
- Failed API calls are shown as actionable UI states, not silent missing content.

Recommended route set:

- `#/`
- `#chat`
- `#tasks`
- `#hive`
- `#wallet`
- `#context`
- `#profile`
- `#memory`
- `#docs`

## Login And Account Identity

- Sign out or use a fresh browser profile before each provider test.
- GitHub login starts, returns, and lands in the app.
- GitHub account username and Task Node display identity match the expected test account.
- Email login starts, delivers or displays the expected dev verification path, verifies, and lands in the app.
- Telegram auth works for a non-owner test Telegram user.
- X login starts, returns, and attaches to the intended account when enabled.
- Discord remains explicitly out of scope if it is not supported.
- Reload after login keeps the account signed in.
- Logging out clears visible account state and local unlocked wallet state.
- Switching providers does not accidentally merge two unrelated users.
- Profile identity, sidebar identity, and account state API agree.

## Wallet And Funding

- Wallet page opens for a signed-in account.
- No-wallet state shows clear Create wallet and Link wallet actions.
- Create wallet generates a local 24-word phrase in the browser.
- The user must confirm the phrase was saved before wallet creation continues.
- The encrypted local vault is saved before any initiation grant is sent.
- The 12 PFT initiation grant is not sent when the local vault is missing.
- Existing linked wallet with missing vault is clearly shown as a risk state.
- Lock and unlock update the visible vault state.
- Backup seed requires wallet password and never exposes the phrase without local password entry.
- Delink removes the server wallet link and clears local vault state for the browser.
- Relink requires a fresh local proof.
- Wallet balance reads from the linked wallet and never shows fake zero while still checking.
- Wallet transaction feed handles empty, loading, error, and populated states.
- Receive shows the correct linked PFT address.
- Send is disabled or blocked unless the local vault is unlocked and the signing boundary is implemented.
- USDC top-up allocates a clean Ethereum deposit address.
- USDC balance sync credits usage once and duplicate sync does not double-credit.
- USDC grant readiness is shown after the threshold, but payout requires local vault unlock.
- USDT top-up credits usage when the balance increases.
- ETH top-up credits usage when the balance increases according to the configured policy.
- Deposit address, usage credit, and PFT wallet are not presented as the same custody boundary.

## Chat

- New chat opens and accepts input.
- Private Instant sends and receives a useful response.
- Private Thinking sends and receives a useful response.
- Frontier Instant sends and receives a useful response.
- Frontier Thinking sends and receives a useful response.
- Discount Thinking is labeled `DeepSeek API Direct` and uses the intended provider route.
- Chat failures show actionable errors and do not consume or duplicate visible user messages.
- Message history persists after refresh.
- Conversation switching works.
- Chat titles or recents do not show internal packet ids as user-facing labels.
- Model/provider labels are understandable and do not duplicate category dividers.
- Token usage and billing estimates are either accurate or explicitly unavailable.
- Long outputs are not cut off by too-small output budgets for the selected model.
- Console and network logs show no uncaught exceptions during send.

## Context And Refine

- Context opens without requiring a wallet.
- Existing context content loads for the account.
- Editing context saves or clearly shows unsaved state.
- Context Refine mode accepts a user request and returns a proposed edit.
- The proposed edit preserves user meaning and does not overwrite unrelated content.
- Applying a refine result updates the visible context.
- Rejecting a refine result leaves context unchanged.
- Publishing to PFT is blocked until a wallet is linked and local vault is unlocked.
- Historical context restore shows only records for the linked wallet and account.
- Missing local vault produces a clear restore blocker, not a broken preview.

## Tasks

- Task request entry point is visible from Chat or Tasks as intended.
- Submitting a task request produces an immediate visible acknowledgment.
- Submitted, under review, accepted, rejected, and rewarded states render distinctly.
- State labels match the deterministic state mapping in docs and code.
- Task detail opens without layout breakage.
- Accept, refuse, cancel, submit evidence, and review actions require the correct wallet/vault boundary.
- Evidence upload or URL submission validates allowed formats.
- Evidence preview does not leak private raw packet ids as the primary user-facing title.
- Verification request state is visible when a task is awaiting review.
- Rewarded state shows amount, transaction reference when available, and final status.
- Refused/rejected state shows reason and next action.
- Empty task lists explain what is missing without pretending work exists.

## Hive And Board Manager

- Hive opens and active project counts match visible rows.
- Hive Chat is a durable conversation, not a transient task-manager trigger.
- User Hive Chat messages persist after refresh.
- Board Manager messages appear only through explicit logged actions.
- Board Manager does not randomly archive active user work.
- Archived items are reversible unless explicitly operator-locked.
- Project detail pages show readable titles, status, and next action.
- Board Manager Secretary Packet status links to an existing architecture page.
- Network task generation worker status links to an existing architecture page.
- Task review and reward worker status links to an existing architecture page.
- Hive status rows show last run, next run or cadence, owner, and runbook link.

## Telegram

- Telegram login/auth works for the test account, not only an operator account.
- Telegram bot receives a message from the linked user.
- Telegram bot rejects or explains messages from unlinked users.
- Telegram chat uses the selected expected chat mode or a documented default.
- Telegram replies are logged to the correct Task Node conversation.
- Telegram failures are visible in logs and do not silently drop messages.
- Telegram auth state appears in connected accounts where expected.

## Profile And Public Profile

- Private profile opens for the signed-in account.
- Public/private toggle state is understandable.
- GitHub/X/Telegram aliases show according to disclosure settings.
- Hidden aliases are not exposed on public profile.
- Public profile route renders without requiring the private session.
- PFT earned separates task rewards and airdrops with clear labels.
- Daily airdrop panel shows last run, amount, and explanation when available.
- Zero airdrop state is not presented as a successful payout to real users.
- Profile NFT gallery renders actual minted/profile data or an honest empty state.
- Public profile does not show internal packet ids, model ids, or provider implementation names unless intentionally in an audit surface.

## Memory

- Memory tab opens and scrolls.
- Memory view is not crowded against page edges.
- User-facing memory entries are readable and not dominated by internal packet ids.
- Provider model ids are hidden unless the surface is explicitly technical/audit.
- Failed memory job banner explains whether the user needs action or operator action.
- Delete/clear memory controls are present where intended.
- Deleting memory removes the visible user memory and survives refresh.
- Clearing memory does not delete unrelated chats, context, tasks, or billing state.
- Memory worker status in System Status has a working architecture/runbook link.

## Docs And System Status

- Help opens from the app.
- The requested docs page is reachable from the Help navigation.
- System Status appears in the expected Help location.
- Each System Status row has a clickable architecture/runbook link.
- Linked architecture pages exist and describe green, amber, red derivation.
- Runbooks include commands or operator actions for recovery.
- Deprecated plans are clearly marked and point to current surface/architecture truth.
- Active Plans section contains only truly active work.
- Docs do not contradict live UI labels or shipped provider names.
- Docs search/navigation does not produce blank pages.

## Billing And Pricing

- Usage credit balance is visible where expected.
- Chat calls decrement or record usage according to the configured billing policy.
- Private model pricing uses current configured provider prices.
- DeepSeek API Direct pricing is documented where the model is described.
- Live pricing, if shown, states its source and update time.
- Billing history separates admin grants, deposits, chat debits, and PFT rewards.
- Failed provider calls do not charge the user as successful calls.
- Replayed syncs do not duplicate deposit credits.

## Errors, Logs, And Recovery

- Browser console has no uncaught exception for the tested workflow.
- Network tab has no unexpected 401, 403, 404, 409, or 500 for the happy path.
- Expected negative-path errors are visible and actionable.
- Server logs show the request path and account id or safe correlation id.
- Worker retries have bounded retry counts and visible failure records.
- Recovery instructions exist for every red System Status row.
- Restarting the app process does not lose durable user-visible state.
- Restarting worker or board-manager processes resumes scheduled work from durable state.

## Accessibility And Layout

- Primary controls are keyboard reachable.
- Buttons have meaningful labels or accessible names.
- Form fields have labels.
- Focus is trapped in modals and returned on close where practical.
- Text fits in buttons, cards, sidebars, and modals on mobile and desktop.
- Long chat, memory, docs, task, and wallet pages scroll normally.
- Loading states reserve enough space to avoid major layout jumps.
- Empty states are concise and do not read like marketing copy.
- Color-only states also include text labels.

## Negative Path Tests

- Expired session routes to login or signed-out state without a white screen.
- Missing wallet blocks wallet-bound actions.
- Missing local vault blocks signing and grant payout.
- Locked local vault blocks signing but still shows non-sensitive wallet state.
- Provider outage shows a clear chat or auth error.
- PFTL RPC outage shows wallet balance or transaction feed degradation.
- Ethereum RPC outage blocks new deposit address exposure when clean-address probe cannot run.
- Worker failure appears in System Status with last error or last run.
- Stale bundle chunk shows refresh fallback.

## Final QA Report Template

```text
QA Run:
Date:
Tester:
Environment:
App URL:
Git SHA or build:
Account(s):
Browser/profile:

Summary:
- Green:
- Amber:
- Red:
- Gray:

Blocking issues:
1.

Non-blocking issues:
1.

Evidence blocks:
<paste one block per tested surface>

Follow-up required:
1.
```

## Release Gate

A beta surface can be called green only when:

- The user workflow was tested through the browser on the target environment.
- The account tested is named.
- The visible result is recorded.
- Console/network errors are recorded.
- Any supporting command output is summarized.
- A remaining blocker is either `none` or explicitly listed.
- The docs/runbook link for that surface exists if the workflow touches operations, scheduling, workers, RPCs, billing, wallet custody, or PFTL.
