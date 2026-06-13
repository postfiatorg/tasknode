# Network Task Feedback Summary

Generated: 2026-06-11

## Scope And Source

This report summarizes feedback submitted through rewarded Network and Alpha tasks, with emphasis on `task_node_core_product`.

Source data was pulled read-only from the live Task Node Fly app database using `fly ssh console -a tasknodeofficial-dev --process-group app` and SQL over:

- `task_projections`
- `task_events`
- `network_project_task_refs`
- `network_projects`

Included rows: rewarded Network or Alpha tasks with a network project reference or Network task kind.

Raw extraction counts:

| Scope | Rewarded tasks | Distinct wallets | Actual PFT rewarded | Full rewards | Partial rewards | Tasks with verification follow-up |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Task Node Core Product | 26 | 8 | 403,750 | 15 | 11 | 26 |
| Other network projects | 8 | 4 | 140,000 | 6 | 2 | 8 |
| Total | 34 | 8 | 543,750 | 21 | 13 | 34 |

Note: some historical tasks contain more than one `pf.reward.v1` event because of the previously investigated duplicate reward path. This memo uses the projected task reward and the latest reviewer summary as the summary source, not raw duplicate event totals.

## Executive Summary

The feedback is consistent: contributors can produce useful QA, specs, and operational audits, but Task Node still needs clearer state, clearer eligibility explanations, and cleaner evidence workflows.

The strongest product signal is not that contributors are unwilling to do work. It is that task offers and UI state often leave them unsure about the target environment, current blocker, wallet context, evidence requirement, or exact next action. When tasks include concrete IDs, commands, screenshots, and state transitions, the submissions are strong. When the UI asks for screenshots or files without making the expected proof obvious, the evidence quality drops and reviews become partial.

## Main Feedback Themes

### 1. Network task offers need tighter boundaries

Multiple submissions said refused or stalled tasks were often real product needs, but the contributor-facing offer did not make the scope concrete enough. The clearest recommendation was to add a structured task-boundary block to every Network task:

- target URL or environment;
- current starting state;
- exact surface or code area;
- expected output;
- explicit non-goals;
- done criteria;
- verification evidence required.

This came through most directly in `task_8809adb444e7bbf709b453c480f4aaf3`, which reviewed refused Network tasks and found duplicate wording, unclear environment targets, and unclear route state as acceptance blockers.

### 2. Onboarding eligibility is still not obvious

New contributors reported confusion about why Network tasks were not routed. One user was told by Hive Chat to find or request a "Network Diagnostic Report", but the actual path was to complete two personal tasks first. That mismatch produced a clear onboarding gap: users need an explicit eligibility panel that says what is blocking routing and what to do next.

Related feedback:

- show whether Hive/Network routing is locked, available, pending sync, or blocked by an outstanding proposed task;
- explain whether the blocker is account-wide or wallet-specific;
- show the current wallet being evaluated;
- show exact next action, not just generic "ask Hive" guidance.

### 3. Multi-wallet state is hard to reason about

Multi-wallet feedback clustered around three issues:

- users are not always sure which wallet is active for routing;
- old-wallet proposed tasks can look like current-account capacity blockers;
- wallet creation/import flows do not sufficiently explain whether an existing wallet can be linked, what address was created, and how that wallet affects eligibility.

`task_202affffa6a4cfab98df59b99357457b` found capacity behavior appears wallet-bound: one wallet was available for routing while another had `wallet_sync_pending` or a proposed task. That is good system behavior, but it needs to be visible in the product.

### 4. Evidence submission UX causes partial rewards

Partial reward decisions repeatedly came from evidence packaging problems rather than useless work. Common patterns:

- screenshots did not visibly show the reported issue;
- DOCX/PDF uploads were not extractable enough for review;
- before/after evidence was missing;
- screenshots showed a general page state but not the specific claim;
- verification responses answered around the request instead of directly answering it;
- template fields were left unfilled.

This is a product UX issue as much as a contributor issue. The app should make evidence requirements harder to miss and should preview what the reviewer will be able to inspect before submission.

### 5. Navigation and screen affordances still confuse first-time users

New contributor QA identified several surface-level issues:

- Tasks panel scroll behavior feels broken because the visible page boundary is unclear.
- The task overview action area makes "Cancel" feel too prominent relative to the next expected action.
- Search Chats was reported as non-working.
- Context Refine and Agents sidebar entries were reported as non-working or misplaced.
- Settings includes controls that appear clickable but do not do meaningful work.
- Directory was reported as non-clickable.
- Logout should ask for confirmation.
- New chat should offer starter prompts such as "Help me build my context" or "Give me my first task."

The docs were praised as useful, but also described as overwhelming without a distilled path.

### 6. Deterministic task state and replay evidence are valuable

The strongest technical contributions were around replay, lifecycle proof, and deterministic state:

- network task recovery loop;
- deterministic lifecycle replay fixture;
- Docker-to-PFTL routing verification;
- complete lifecycle evidence from offer to reward;
- plain-English replay checklist;
- double reward event reproduction;
- stalled queue diagnosis.

These tasks show contributors can validate the system when the app exposes event IDs, CIDs, transaction hashes, ledgers, and state transitions clearly.

### 7. Verification follow-ups are too frequent and too easy to fail

All 34 included tasks had verification follow-ups. Follow-ups helped improve proof quality, but they also created repeated friction. A recurring pattern is that the original report was useful, then the follow-up failed because the requested artifact was too specific, not visible in the screenshot, or not directly answered.

The product should support the verifier by turning follow-up asks into explicit checklists in the submission UI.

## Priority Recommendations

1. Add a Network Task Boundary block to every generated Network task.

   This should include environment, surface, starting state, exact output, non-goals, done criteria, and evidence checklist. This is the highest-leverage fix for refusals, duplicate-looking tasks, and task acceptance hesitation.

2. Add a contributor eligibility panel.

   Show current wallet, routing status, outstanding proposed tasks, sync state, required prerequisites, and exact next action. This should answer "why am I blocked?" without needing Hive Chat.

3. Make wallet-specific capacity visible everywhere Network tasks are routed.

   Every eligibility or task-routing surface should clearly say whether the blocker belongs to the active wallet, another linked wallet, or the account. Include the wallet prefix and task title causing the block.

4. Improve the evidence submission workflow.

   Add a proof checklist, screenshot preview, extractable text preview for uploaded docs/PDFs, and a warning when the submitted artifact does not visibly satisfy the requested evidence type.

5. Make task lifecycle proof a first-class surface.

   The lifecycle/forensics page should expose offer, accept, submission, verification request, verification response, reward decision, and payment with event ID, CID, transaction hash, and ledger where available.

6. Clean up non-working or ambiguous navigation.

   Either implement Search Chats, Context Refine, Agents, Directory, and Settings controls, or hide/label them until they are real.

7. Keep docs, help chat, and task generation aligned.

   The same product concepts should use the same words across Help, Hive Chat, task briefs, onboarding docs, and UI labels. Do not tell users to find a flow that is not present in the product.

## Task Node Core Product Feedback Detail

### `task_8809adb444e7bbf709b453c480f4aaf3` - Draft Report on Refused Network Tasks

Feedback submitted:

- Reviewed six stopped/refused Network task rows.
- Found that task wording pointed at real product gaps but did not always make scope, route state, reward fit, or acceptance path concrete.
- Identified duplicate wording among status/timeline tasks.
- Noted uncertainty over whether "Task Node Core Product" referred to production or dev.

Reviewer outcome:

- Full reward.
- Reviewer called it a strong diagnostic report with concrete examples and actionable recommendations.

Product takeaway:

- Add the Network Task Boundary block before routing more implementation tasks.

### `task_e5e3e7b9a600bcde85e3d8cf626ed6bb` - Define Task Node Beta Consolidation Boundaries

Feedback submitted:

- Produced a launch-readiness scope across login, funding, context, chat, Hive, Telegram, tasks, and operations.
- Defined green/amber/red surface criteria.
- Listed required production surfaces and evidence requirements.
- Follow-up supplied a dated Telegram smoke evidence block.

Reviewer outcome:

- Full reward.
- Reviewer noted the spec was comprehensive and operationally grounded, but Telegram still needed non-operator live validation before being called green.

Product takeaway:

- Keep beta status tied to evidence, not claims. Do not expose surfaces as production-ready unless a normal user path is proven.

### `task_c3cf8a2db679d60f3ed6a367f16cbaea` - Document New Contributor Onboarding Friction Points

Feedback submitted:

- Tasks panel scroll behavior feels broken when the cursor is outside the container.
- Cancel appears too prominent near the evidence/submit workflow.
- Search Chats was reported as non-working.
- Context Refine and Agents were reported as non-working or misplaced.
- Settings contains controls that appear active but do not do much.
- Directory was non-clickable.
- Logout should ask for confirmation.
- New chat should offer starter prompts.

Reviewer outcome:

- Partial reward.
- Core observations were useful, but follow-up screenshot did not clearly demonstrate the issue.

Product takeaway:

- Fix or hide dead navigation. Improve screenshot/evidence guidance.

### `task_19f12b461da11ee0fa9b4eb688fcb7a2` - Stress Test Email And Telegram Login State Flows

Feedback submitted:

- Added a deterministic auth fixture covering email and Telegram success, invalid code/signature, expired payload, reconnect, provider linking, stale state, and logout.
- Reported ambiguous/broken auth behaviors and minimal fixes.

Reviewer outcome:

- Full reward.
- Verification excerpt proved stale/replaced email challenge invalidation.

Product takeaway:

- Auth reliability can be tested deterministically. Keep this fixture in release gates.

### `task_803415484ccbba50d555c44189e8e648` - Create Multi-Wallet Onboarding UX Findings Memo

Feedback submitted:

- Users cannot clearly add an existing wallet.
- Newly created wallet address visibility is insufficient.
- Multi-wallet task/capacity status is not clear enough.
- Wallet onboarding needs clearer instructions and affordances.

Reviewer outcome:

- Partial reward.
- Findings were specific and actionable, but capacity/status screen evidence was weak.

Product takeaway:

- Add explicit wallet import/link language and capacity status evidence to the UI.

### `task_d90b053d2a5995ba3555dcf6f092b38e` - Document Task Allocation UI Issues

Feedback submitted:

- Reported inability to edit a proposed task after proposing it.
- Expected behavior: allow edits.
- Actual behavior: can only accept or refuse.

Reviewer outcome:

- Partial reward.
- Report file content was not extractable enough for full review.

Product takeaway:

- Support editable task proposals where possible, or explain why accept/refuse is the only available decision. Add extractable text preview for uploaded docs.

### `task_202affffa6a4cfab98df59b99357457b` - Test Multi-Wallet Capacity Tracking and Document Results

Feedback submitted:

- Tested `goodalexander` with wallet `rPo8...` and wallet `rhwi...`.
- Wallet 1 showed available for routing with no wallet-level blocker.
- Wallet 2 showed pending sync or proposed-task blocking state.
- Conclusion: capacity appeared wallet-bound, not globally account-bound.

Reviewer outcome:

- Full reward.
- Reviewer said screenshots and written findings clearly demonstrated multi-wallet eligibility behavior.

Product takeaway:

- The backend behavior appears directionally right; the UX needs to make this visible.

### `task_5ea47962f834e308c94c6d0d74362f9f` - Document Remaining Onboarding And Wallet Friction Points

Feedback submitted:

- Reviewed first-session checklist, wallet readiness, task request/generation, task loading, task submission/review, multi-wallet routing, Hive/Network context, and recovery expectations.
- Produced more than five ranked findings with impact, reproduction notes, and recommendations.

Reviewer outcome:

- Partial reward.
- Core memo was strong, but verification follow-up asked for a specific implementation detail and the response did not answer it directly.

Product takeaway:

- Verification asks need clearer UI affordances so users answer the exact request.

### `task_9271ac03f15cd533f7c7010bb675f0fc` - Implement Persistent Network Task State Recovery Loop

Feedback submitted:

- Implemented a persistent recovery loop for accepted/submitted/reviewed network task states.
- Added deterministic duplicate-transition protection.
- Added operator-facing recovery logs and a smoke test.

Reviewer outcome:

- Full reward.
- Reviewer accepted code excerpts showing publication gating and recovery decision logic.

Product takeaway:

- Recovery must be durable and idempotent. State repair should be visible to operators.

### `task_cd7bdd49fa89500f0e2ec88abb203749` - Build Deterministic Network Task State Replay Fixture

Feedback submitted:

- Added canonical JSON artifacts for offer, accept, submission, authority review decision, and reward payment.
- Added a reusable replay verifier and README.

Reviewer outcome:

- Full reward.
- Minor note: screenshot evidence would have strengthened the verification response.

Product takeaway:

- Keep deterministic replay fixtures as permanent regression coverage.

### `task_01af1624fcb74e41d902ca32b126f27d` - Verify Docker Network Task Routing Into PFTL Flow

Feedback submitted:

- Verified Board Manager allocation into generation job, task request, PFTL offer, and proposed projection.
- Found and fixed a Pinata metadata issue.
- Supplied generation job ID, request ID, task ID, and proposed state.

Reviewer outcome:

- Full reward.

Product takeaway:

- End-to-end routing is testable. Keep linked Postgres and PFTL identifiers in operator reports.

### `task_cbc53fb0cdabb53f1215e73435b37af0` - Define Stateful Network Task Agent Behavior Specification

Feedback submitted:

- Defined persistent state models, lifecycle transitions, agent roles, routing constraints, downstream propagation, and failure handling.
- Clarified difference between `link_failed` and `rewarded` with `0 PFT`.

Reviewer outcome:

- Full reward.

Product takeaway:

- Hive UX must distinguish repairable generation/link failures from terminal review outcomes.

### `task_b7ddc205f0edb66ceac71e159c4dd51c` - Demonstrate One Complete Network Task Lifecycle

Feedback submitted:

- Demonstrated offer, accept, submission, review, reward decision, and payment using concrete event IDs, ledgers, transactions, and proof anchors.

Reviewer outcome:

- Full reward.
- Formatting noise was noted, but the evidence was clear.

Product takeaway:

- Lifecycle evidence is valuable. Make it easier to export cleanly.

### `task_2e8a004e2ba3b4bd9c20d7e3ce512725` - Create Plain-English Network Task Replay Verification Check

Feedback submitted:

- Drafted a plain-English lifecycle checklist.
- Eventually supplied a concrete rewarded task example with task ID, transaction hashes, reward amount, and screenshot.

Reviewer outcome:

- Partial reward.
- Original checklist retained too many placeholders and did not fully populate lifecycle checkpoints.

Product takeaway:

- Provide a first-party replay checklist template that auto-fills known fields from task forensics.

### `task_470248719f5d8e556108165237165333` - Document Task Node Onboarding Friction Points

Feedback submitted:

- User could not understand why no Hive Mind tasks arrived after wallet creation.
- Hive Chat initially pointed them toward a "Network Diagnostic Report" that was not discoverable.
- Actual gating appeared to be completion of two personal tasks.
- Recommendation: clearly show new users the prerequisite for entering Network task routing.

Reviewer outcome:

- Partial reward.
- The report supplied one genuine friction point, but the task required at least three.

Product takeaway:

- Add an explicit "how to become eligible for Network tasks" state and next action.

### `task_31877c10f1e71f28d04ec317ef7ffdf9` - Document Stalled Task Queue Items and Blockers

Feedback submitted:

- Audited stalled proposed/generated rows.
- Found old-wallet proposed tasks, orphaned ownership, failed requests, sync lag, and `context_ipfs_fetch_failed`.
- Recommended actions included not counting old-wallet tasks against new wallet capacity, expiry/cancellation, and request repair.

Reviewer outcome:

- Full reward.

Product takeaway:

- Stalled queue dashboards should show owner, wallet, request ID, generation job, worker error, and recommended operator action.

### `task_492cc751fdbe1a0c7b7cf427b52bb4a4` - Audit Onboarding Documents From New User Perspective

Feedback submitted:

- Found onboarding docs too technical after the opening sentence.
- Flagged terminology, navigation, help content, and UI clarity issues.
- Recommended more plain-language explanations and clearer first-time-user pathing.

Reviewer outcome:

- Partial reward.
- Good coverage, but severity and recommendation mapping were inconsistent.

Product takeaway:

- Use explicit severity and recommendation fields in docs review templates.

### `task_e47ccb993f7b9fc7c751abf843314233` - Fix Recommended Connections On Private Profile Page

Feedback submitted:

- Identified recommendation index and private profile rendering issues.
- Implemented recommendation profile preview and exposed useful profile/wallet affordances.

Reviewer outcome:

- Partial reward.
- Functional fix was shown, but before/after evidence was incomplete.

Product takeaway:

- Recommendation UX needs inspectability, and implementation tasks need before/after screenshot slots.

### `task_2cb0390bcdcbefcfdd415cb70280a36c` - Test Vapor Wallet Unlock And Cutover Flows

Feedback submitted:

- Audited fresh-install and existing-session wallet flows.
- Found no major blocker but identified edge cases around encrypted vault creation, unlock state, backups, and cutover behavior.

Reviewer outcome:

- Partial reward.
- Only one unlocked-state screenshot was supplied; task requested several key states.

Product takeaway:

- Wallet QA checklists should require screenshots for locked, unlocked, backup, cutover, and error states.

### `task_5fd17ef435e99e79f6e87b12d9966817` - QA Hive Chat Onboarding Flow

Feedback submitted:

- Produced a QA report for Hive Chat onboarding.
- Included expected contributor journey, nine input exchanges, severity-rated issues, and prioritized recommendations.

Reviewer outcome:

- Full reward.
- Reviewer wanted future screenshots to capture more findings and final submission confirmation.

Product takeaway:

- Hive Chat onboarding needs a visible first path and better proof capture for QA.

### `task_8f8ff4b94792842a9b54a63769710afd` - Audit And Reproduce Double Reward Event Path

Feedback submitted:

- Reproduced a real double-reward behavior, not just a display duplicate.
- Traced two reward decisions and two reward payments for one task.
- Documented root cause and remediation.

Reviewer outcome:

- Full reward.

Product takeaway:

- Reward paths require idempotency and chain/database reconciliation checks. Keep duplicate-payment audits in release gates.

### `task_2ebb368d49cd48d11802d4f3c4692dd7` - Verify And Patch Hive Acceptance Gate Messaging

Feedback submitted:

- Added clearer `Next reward task` previews.
- Improved project cards and Hive Mind Agent `Next Check` messaging.

Reviewer outcome:

- Partial reward.
- Implementation looked substantially complete, but before/after evidence for each fix was incomplete.

Product takeaway:

- Acceptance-gate messaging should always show next reward-bearing task, blocker, and next action.

### `task_724460b146babbd93e71cdce425bd0e6` - Audit Task Node Determinism and Board State

Feedback submitted:

- Audited determinism failures and board-state reporting issues.
- Included reproduction methodology, paired output comparisons, command results, severity rankings, and remediation recommendations.

Reviewer outcome:

- Full reward.

Product takeaway:

- Board state and task generation determinism need ongoing regression tests.

### `task_07db61566d7c4c44f0a3ffe3c88458e0` - Validate Four Beta Gates and Record Evidence

Feedback submitted:

- Submitted a concise validation report for four beta gates.

Reviewer outcome:

- Partial reward.
- Required screenshots for each gate were missing or did not show the requested Board Manager decision evidence.

Product takeaway:

- Gate validation tasks need screenshot slots tied to each gate.

### `task_dc07336c457592a783e53b0b7a175df9` - Ship Four Acceptance Gates Beta Document

Feedback submitted:

- Defined beta shipping gates for Telegram, Task Generation, Context Editing, and Hive Board.
- Included pass/fail reviewer tests and current risks.

Reviewer outcome:

- Full reward.

Product takeaway:

- Acceptance gates should stay narrow and testable.

### `task_5dc3c23dd1460a044bfa2ce1fede2292` - Define Restored Core Product Task Flow

Feedback submitted:

- Defined the restored core Task Node flow: user context to task request, generated task, acceptance, submission, review, and reward.
- Included state definitions, acceptance criteria, P0 blockers, and prioritized board tasks.

Reviewer outcome:

- Full reward.

Product takeaway:

- This remains the canonical task-flow shape: one clear deterministic loop before feature expansion.

## Adjacent Network Project Feedback

The non-Task-Node-Core rewarded tasks reinforce the same themes:

| Project | Task | Feedback signal |
| --- | --- | --- |
| `hive_chat_onboarding` | `task_be20292fdbb2942ac35196be8c7935ec` - Create Hive Chat New User Quickstart Guide | New users need a plain-language path for wallet validation, first message, board, tasks, rewards, and submissions. |
| `network_onboarding_positioning` | `task_45a3af60c70fb9a1311e88663754dbfa` - Draft Plain-Language Network Onboarding Starter Pack | Network onboarding needs simpler vocabulary and contributor-facing next steps. |
| `contributor_activation_reward_trust` | `task_2fa17202f941537b166cef01ee6b66c8` - Draft Contributor Trust And Reward Framework | Contributors need trustable reward expectations and transparent review logic. |
| `market_alpha_tasks` | `task_70828af0024abd3cff1501aadb689e22` - Write Task Node Boundary and Success Specification | Task boundaries and success criteria are a recurring product need beyond core product tasks. |
| `market_alpha_tasks` | `task_51695c2b7a50bcd890040e330391f6dd` - Produce Alpha Task Routing Seed Pack | Routing seed work also depends on clear task classes and evidence expectations. |
| `pft_distribution_v3` | `task_f4ebbc971fb721789892f5cbc3ff403f` - Validate Distribution V3 Idempotency Under Replay Conditions | Reward infrastructure needs replay-safe idempotency. |
| `pft_distribution_v3` | `task_90cc5546fd95c57f86a708d2c230afea` - Verify Reward Deduplication Across Distribution V3 Paths | Duplicate reward prevention remains a cross-system safety concern. |
| `pft_distribution_v3` | `task_d2527276782f04a30ce1bbe19bc5c188` - Trace Distribution V3 Reward Routing Consistency | Reward routing must be traceable and reconcilable. |

## Evidence Quality Lessons

The review outcomes imply the following product changes would improve future Network Task completion quality:

1. Convert verification asks into structured UI fields.

   If the authority asks for "one screenshot plus 1-2 sentences", the submit surface should show separate required slots for screenshot and text.

2. Warn when files are not reviewer-readable.

   DOCX/PDF evidence should show extracted text or warn that the reviewer may not be able to inspect it.

3. Auto-fill lifecycle identifiers where possible.

   For lifecycle/replay tasks, the app should help populate task ID, event IDs, transaction hashes, CIDs, ledgers, reward amount, and final state from indexed events.

4. Show before/after requirements explicitly.

   Implementation tasks should have dedicated before and after proof slots when the verifier needs comparative evidence.

5. Keep follow-up requests short and exact.

   The more specific the follow-up, the more likely users are to satisfy it. Broad "submit screenshots" guidance produced weaker evidence.

## Product Backlog Extract

High priority:

- Add a Network Task Boundary block to task offers.
- Add a Network eligibility and capacity panel.
- Make wallet-specific blockers visible and understandable.
- Improve evidence submission slots and previews.
- Fix or hide dead navigation surfaces.

Medium priority:

- Auto-fill lifecycle/forensics proof exports.
- Add onboarding starter prompts to chat.
- Add severity/recommendation templates to docs and UX review tasks.
- Add first-party before/after evidence requirements to implementation tasks.

Release-gate priority:

- Keep auth fixture, deterministic replay fixture, duplicate-reward audit, and stalled-queue audit in the operator checklist.
- Require non-operator Telegram validation before marking Telegram fully green.
- Require screenshot/proof evidence for each beta gate, not only a written gate summary.
