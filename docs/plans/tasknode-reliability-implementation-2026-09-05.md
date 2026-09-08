# Task Node reliability implementation

Authorized by the user on 2026-09-05: implement all nine recommendations from
the reliability audit and the subsequent explanation. Kimi K3 remains the
production task manager. Vercel GLM 5.3 remains the default downstream model,
GLM 5.3 Flash serves Instant, and Ambient remains backup. Preserve generous
answer budgets. Fleet consolidation is outside this implementation.

Baseline: production v703; working tree based on
`571d7833ed016165de32bd305ed765e62da066c7`, including existing provider, docs UX,
and obsolete-loop removal changes. A local binary diff and status snapshot were
saved under `/tmp/tasknode-reliability-implementation-before.*` before edits.

## Current status

Implementation, production deployment, documentation and recorded test evidence
are complete. See the [evidence index](../verification/reliability-implementation-2026-09-05/README.md).
The first naturally occurring nonempty scoped production round and a larger
latency/quality sample remain unverified. The dated entries below preserve the
work history; their earlier blockers do not describe the current deployment.

## Work and evidence

| Workstream | State | Evidence / remaining qualification |
| --- | --- | --- |
| Review and reward recovery | Deployed in v706; production repairs verified | Two production rewards completed; historical failed payment reconciled against its original encrypted payload and archive ledger. Recipient account still absent, so retry remains held. Legacy zero-rejection repair applied with both validated authority receipts; no rescoring or payment. |
| Immutable request receipts | Backend and browser deployed; Corbanu operator candidate deployed | 12 concurrent retries, conflicting owners/bodies, completed replay; browser lost-response, reload and simultaneous-tab checks pass. |
| Crash-safe queues and capacity | Deployed | Lease replacement rejects stale completion; six-way last-slot fixture passes. |
| Durable visible progress | Browser deployed; Corbanu operator candidate deployed | Old receipt lookup, pagination, unresolved visibility, owner/attempt retry and encrypted reopen recovery pass. Real PTY failure, reopen, process restart, exact receipt recovery and pagination pass. |
| Kimi completion supervision | Deployed; duty-outcome fixtures passed | Structured control inbox, per-duty outcome proof, partial resume, busy protection and duplicate-delivery/backoff checks pass. Existing production wake restored and a real verification/network-offer round completed. Scoped API/control cutover is live; first new nonempty scoped duty is not yet observed. |
| Shared task/API rules | Scoped API and operator terminal deployed | Common intake/eligibility, scoped agent API/atomic receipts, shared Corbanu transport and profile isolation. Live API/candidate terminal cutover complete. |
| Context and task quality | Deployed; contract, PostgreSQL and live corpus pass | Full account-scoped direct context, actual Kimi need, current linked wallet, typed continuation, duplicate/uncertain hold, stale assessment rejection. Eight-case live quality corpus passes on Vercel GLM 5.3 after clarifying revision/continuation semantics. |
| Latency | Backend stage 1 deployed | Owning worker roles, bounded execution, stage timings, concurrent reads and status cache implemented. Live restored network offer measured: queue 375 ms, context 19,346 ms, provider 154,372 ms, publication 140 ms. Live quality assessment took 9.4–42.7 seconds across the eight passing synthetic cases. |
| UX recovery qualification | Browser and real TUI recovery passed | Docs native unlock/folders/moves/search/mobile and browser request recovery pass. Deployed spreadsheet Coach/ODV accept ~100k-character fixture replies. Terminal refresh bug found and fixed; regression passes. |

Each workstream will record changed boundaries, targeted verification, deployment
evidence, and any remaining limitations here. Tests must use synthetic accounts
and fake providers for fault injection. Production recovery must preserve reward
guards and existing agent decisions. No new autonomous reward or portfolio rules.

Reference: [audit](tasknode-reliability-audit-2026-09-05.md).

## Backend stage 1 — deployed and worker checks passed

- Shared browser/terminal durable intake, account-scoped retry keys, immutable
  receipt body/owner, direct owned lookup and cursor pagination. Unresolved
  requests remain visible; old clients still need durable pending-command work.
- Context enrichment moved off direct submit/config into an account-scoped,
  persisted worker snapshot. Public personal intake rejects forged network
  task kinds; the existing board allocation domain service remains required.
- Network preparation has attempt tokens, heartbeats, stale fencing and an
  atomic request/allocation/intent commit. Capacity is rechecked under an
  account transaction lock. Generation commits offer/event/projection/receipt
  under the request attempt lock. Interval and immediate ticks share one run.
- Generators execute only in their owning worker role; manual fixture/operator
  entry points remain explicit. Stage durations and progress metadata are
  recorded. Taskgen has 65,536 output tokens and a nine-minute overall deadline.
- Status uses independent concurrent reads and a bounded 15-second snapshot.
- Abandoned reward reservations are recovered only without payment evidence or
  guards. New payments persist transaction reconciliation references before RPC.
  Encrypted JSON reads/writes support 16 MiB with two concurrent gateway reads.

Focused verification passed in the owned temporary PostgreSQL database
`tasknode_reliability_20260905`: immutable receipts (12 concurrent retries,
conflicting bodies and owners, 111-row pagination), six-way last-slot capacity,
network lease replacement, abandoned publication recovery preserving unknown
payments, existing generation/recovery fixtures, and shared intake through mock
provider generation, offer event, projection and completed receipt. The latter
also proves cross-account context isolation. A 1.9 MB IPFS fixture round-tripped;
over-limit input was rejected before provider I/O. No fixture pays a reward.

Production read at 18:21 UTC found an old uncertain payment with no transaction
hash, a reservation abandoned before payment, and a current reward blocked at
IPFS pinning. These are separate recovery cases. No production payment guard
has been cleared or retried manually. Raw bounded metadata probe:
`/tmp/tasknode-review-before-20260905.json`.

Corbanu/Kimi supervision, shared/scoped agent API, runtime task quality
qualification, browser recovery and real TUI qualification remain in progress
in subsequent stages. This stage alone does not complete the nine workstreams.


Production verification at 18:57 UTC confirmed both recoverable cases completed:
`task_b3aff46e1d68c83810b10e120d42e304` and
`task_2d5fd452fc4bcbf054075ad3e534269b` are `rewarded`, with recorded transaction
references and the new prepared-transaction reconciliation receipts. The older
unknown payment remains guarded. An old terminal-decision/projection mismatch
still needs canonical replay. Probe: `/tmp/tasknode-review-stage1b-after.json`.

## Subsequent implementation — local, verification in progress

- Corbanu now shares ordinary and streaming HTTP transport, rejects credential
  origin changes and redirects, preserves split UTF-8 characters, and stores
  encrypted pending commands under profile/account/origin-scoped keys. CLI
  pending/recover commands and TUI request prefill recover uncertain submissions.
  Requests expose pagination, and asynchronous results carry identity/view/order
  fences. The vault cache now notices credential-file changes from other processes.
- A scoped board-agent API uses expiring hashed credentials, explicit board
  grants, and immutable command receipts committed with nested domain writes.
  Agent operations retain the existing domain rules and Kimi actor attribution.
  Ten-way retry, scope denial, and nested rollback fixtures pass.
- One checked agent registry assigns the existing Kimi K3 agent to all six boards.
  Durable rounds require explicit per-duty outcomes. Three unanswered deliveries
  leave the round pending and alert; journal activity cannot acknowledge it.
  The new supervisor uses a structured TUI inbox/readiness signal and preserves
  pending work on resume. Installation/live Kimi qualification is not complete.
- Board status publishing uses an explicit operational projection for every
  assigned board; the raw-pane/regex-scrubbing ingestion path was removed.
- Browser task submissions save an encrypted pending command before HTTP,
  restore it on reopen, and fence account changes. Failed requests have an
  owner/attempt-scoped retry operation and a visible retry button.
- UI and Kimi candidate capacity use a complete canonical count instead of a
  truncated blocker page. Routing enrichment is informational rather than an
  extra eligibility gate. Existing operator capacity grants remain unchanged.
- Network request preparation can persist its complete context directly in
  PostgreSQL under the job attempt. A structured semantic assessment compares
  prior outputs and identifies duplicates, continuations and unclear requests.
  Contract tests pass; live model quality evaluation is still required.

Corbanu focused session/cache checks: 18 passed. The first encrypted command-store
fixture exceeded the debug crypto timeout; the command concurrency test now uses
its storage contract fixture while existing vault tests own encryption behavior.
Docs browser checks passed for page-level unlock, folders, moves, reload,
native wallet unlock and desktop/mobile overflow. TUI checks and broader recovery
qualification are in progress; no live success is claimed for local changes.

The Rust incremental cache exhausted disk space. Generated incremental artifacts
were cleared (source and executables retained). Fly's local config file was
subsequently found empty, so further production probes/deployment require login
restoration. The user has been asked to run `fly auth login`; local work continues.

The expanded AST-derived inference check now covers 64 entry files and 215
reachable files with zero regular-expression violations. HTML uses a real parser;
semantic message intent, task evidence references and explicit user reservation
requirements use validated structured outputs with conservative failure. Context
research uses the scorer's typed research requests. Account reservation extraction
uses one scoped batch, avoiding a call per account. Regression checks cover imported
aliases, export barrels, dynamic literal imports and RegExp constructors.

## Additional qualification and fixes

- `reliability-text-contract-smoke.mjs`: parser sanitization, typed report decisions,
  semantic citation grounding, cross-account rejection and no-regex regression pass.
- `network-task-direct-intake-smoke.mjs`: real temporary PostgreSQL intake passes.
  It caught and fixed a null encryption-key access in direct mode, an empty need
  passed to the quality assessment, and an assessment write using the wrong column.
- `task-request-browser-recovery-smoke.mjs`: real React modal, IndexedDB and two
  browser tabs pass lost-response/reload/key reuse/account isolation checks.
- `docs-library-visual-smoke.mjs`: fresh isolated browser context passes; desktop
  layout was visually inspected. Screenshots remain under docs-library-ux.
- PFDocs deployed sheet tests pass for Coach and ODV with 102,521-character synthetic
  replies, real encrypted channels/cell content, desktop/mobile containment, collapse
  and reopen. This qualifies transport/rendering, not live model response quality.
- `task-reward-reconciliation-smoke.mjs`: validated matching transaction required,
  actual delivered amount checked, provisional/missing/mismatched results stay held,
  failures require an explicit hash-scoped retry, stale attempts cannot overwrite a
  new guard, and previous payment evidence is retained. No fixture pays anything.
- `task-legacy-review-recovery-smoke.mjs`: only explicit historical reject/zero
  decisions with validated authority receipts can become rejected; positive rewards
  remain unfinalized. Replay cannot reopen a recovered rejection.
- Corbanu's actual PTY exposed menu refresh resetting the selection and filter.
  Refresh now preserves both; searchable Task Node rows now have search text.
  The new regression passes along with the other four Task Node menu tests.

Production payment reconciliation proof (archive endpoint, read-only before apply):
`B693CB25C06DDD069BF42485A03ADA06A019CB1DC544748F56ECD3CEAF0AD354`, ledger
4817402, validated `tecNO_DST_INSUF_XRP`, matching original event/payload digest,
0.40 PFT intended, zero paid. Guard now records `failed_validated`; publication
remains blocked. `account_info` at validated ledger 6051122 returns `actNotFound`
for its recipient, so no retry or activation transfer was attempted.

The two old zero-rejection receipts for task
`task_cdd241775a0a65ddae909bae3b771d29` were verified against archive ledgers
3308439 and 3308440. Repair was applied and a 21:36 UTC production read confirms
`rejected`, zero reward, the preserved proof, and published review state.

Deployment is still blocked by the empty Fly login file. The API changes and new
Kimi supervisor are **not live**. The existing Kimi terminal remains alive; its
wake path was temporarily broken by staging the new supervisor. The 21:29 UTC
compatibility repair below restores the existing terminal while scoped cutover
remains pending.


## Status checkpoint — 21:09 UTC

The implementation is not finished or fully deployed. The production agent is
still Kimi K3, and its last observed round completed at 19:16 UTC. The staged
runtime wrapper now expects the new scoped API credential; that cutover has not
been installed. A manual wrapper check records `credential_missing`. This is a
production wake-continuity regression from staging live cron entrypoints and must
be resolved before calling the work complete. The existing terminal was preserved.
Production returns 404 for `/api/agent/board/command`; `fly auth whoami` reports no
access token. The user has been asked to restore Fly login. Do not install the new
supervisor or claim scheduled Kimi operation is recovered on this evidence.

Additional local qualification: final web build, bundle budgets, lint, formatting
and diff checks pass. Context now loads on navigation; server HTML parsing is kept
out of the browser bundle, which uses its native parser. Nine malformed/entity/
hidden-content fixtures produce matching browser/server text and sanitization.
Docs browser checks pass again. In the candidate's real PTY, a failed request was
retried with its original attempt, cursor pagination opened the older receipt,
and an inbox work order waited while a menu was open before entering the normal
terminal turn after the menu closed. These are synthetic endpoint checks, not a
production Kimi cutover. Complete the remaining create/reopen/restart exercises.


## Production continuity restored — 21:29 UTC

The live cron now retains the existing Kimi K3 terminal until scoped API and
candidate terminal readiness have both been verified. A tested compatibility tick
uses structured duty/session data and the legacy terminal's SGR composer protocol;
it never clears unsent text, kills the terminal, or uploads raw pane content. The
old transcript cron was removed and the existing wake cron reinstalled. A real
production work order covered all six boards and contained two governance duties.
Kimi issued verification decision `bmdec_4d50f1a2-7bb7-408a-9e7e-c48139b8cdff`,
which the backend consumed, and queued network request
`req_net_5d10f3a111af12374d04005c2c717655`. A minimal cron-environment check correctly
waited while Kimi was busy. This repairs scheduled delivery; it is not the new
scoped API/control-inbox supervisor cutover. That still needs Fly authentication.
The installer now verifies its prerequisites before changing schedules, and keeps
the previous schedule if the new service cannot finish its first tick.

`bm-production-wake-smoke.mjs` proves changed layouts, busy/aborted/wrong threads,
unsent drafts, no-duty quiet, spacing and unresolved-work retention. The inference
AST check now covers 65 entry files and 217 reachable files without regex.
A final production read confirms both recovered rewards remain paid, the legacy
rejection remains corrected, and the failed 0.40 PFT transfer remains guarded as
`failed_validated` without any retry. Evidence: `/tmp/tasknode-final-production-read.json`.

Separate real Corbanu CLI processes reproduced a lost committed HTTP response,
reopened the encrypted pending request, and recovered `req_saved_0` with the original
key and exactly one server request. Evidence lives in Corbanu's PF-44 QA directory.
Coach and ODV spreadsheet result files are now stored separately; Coach's repeated
large-response deployed-editor check passes. Their model responses remain fixtures.


## Measured live request — 21:37 UTC

The network request from Kimi's restored round reached `proposed` in one worker
attempt. Deployed stage timing metadata records queue wait 375 ms, context 19,346
ms, provider 154,372 ms, publication 140 ms, total processing 173,858 ms. This is
one production observation, not a p95 or a before/after benchmark. It demonstrates
that provider generation dominates this case; the staged direct PostgreSQL context
snapshot removes remote context hydration but its live improvement and the new
semantic gate's extra time remain unmeasured. Preserve the requested large output
budgets. Evidence: `docs/verification/reliability-implementation-2026-09-05/production-recovery-and-latency.json`.

The browser's main JavaScript bundle is 311,912 bytes (build reports 311.91 kB),
with the 24.91 kB Context screen loaded on navigation. Existing bundle budgets
pass without raising limits. This is an asset-size result, not a measured page
load speedup. The new server parser is absent from the browser bundle.


## Scheduled operation verified — 21:47 UTC

The host cron did not produce its expected 21:45 tick. Its global daemon was left
untouched. `bm-install-production-wake.sh` installed a single user-level systemd
wake timer and removed the superseded Kimi wake/transcript/reset cron entries,
preserving unrelated schedules. The timer's first autonomous invocation completed
with exit 0 at 21:47:31 UTC and recorded zero remaining duties across six boards;
its next firing is 22:00 UTC. This is observed scheduled execution, beyond the
earlier manual delivery. The scoped supervisor installer replaces this timer only
after the API/candidate preflight and a successful supervisor tick. Its daily idle
reset also uses a systemd timer. No extra Kimi process was created.


## Final local checkpoint — 22:00 UTC

The production wake timer fired automatically again at 22:00 UTC, found one new
duty and submitted it to the existing Kimi terminal. Production continuity is
restored. No fleet consolidation or extra production Kimi process was introduced.

Local qualification now includes real Corbanu process restart with the same
thread, pending request restoration, original receipt recovery without duplicate
commands, cursor pagination, busy-inbox protection, and duplicate work-order
suppression across restart. Coach mobile and ODV desktop sheet screenshots were
visually inspected. Both retain a usable composer with long replies. The latest
Coach fixture is 107,522 characters; neither sheet test claims live model quality.

A remaining eligibility presentation mismatch was corrected: wallet indexing and
routing-report progress are informational; neither is rendered as a routing
blocker. Missing badges say `Badge needed`. The shared-capacity PostgreSQL fixture
and rendered browser panel pass. User and operator docs reflect the current source
and explicitly identify pending deployment.

Final checks passed: web build, bundle budgets, lint (including runtime operator
modules), formatting, diff whitespace, 169 API policies, 26 public Help sources,
runtime dependency/role boundaries (web 316 files/19 packages; worker 216 files/8
packages), Kimi harness/failed-cutover preflight, production wake state-machine
fixtures, 65-entry/217-file inference regex check, and the focused capacity/UI
regressions. Existing focused Rust tests remain valid; no Rust source changed
since the qualified candidate build. Candidate source manifests record the exact
changed files, including pre-existing work, without committing or pushing them.

### Historical deployment checklist — superseded by v706 and the scoped cutover

1. Restore Fly login on this host. `fly auth whoami` still reports no access token;
   the new production agent API still returns 404. Existing GitHub workflows do
   not provide an alternative Fly deployment path, and the current Task Node DB
   proxy has no reusable Fly token in its environment.
2. Run the eight-case live intent evaluation with the working production gateway
   credentials before enabling the new semantic gate. The local credential's 401
   is an authentication failure, not evidence of classifier accuracy.
3. Deploy the remaining Task Node source and migration 135, verify scoped API
   commands against production, qualify/install the Corbanu candidate, provision
   its agent credential and resume the production Kimi thread at an idle boundary.
4. Run the gated supervisor installer and verify a real scoped command receipt,
   completed per-duty results and resume. Retire the compatibility wake adapter
   after that successful cutover. The new scoped supervisor is not deployed yet.

The historical 0.40 PFT transfer remains safely held as `failed_validated`: its
recipient does not exist on the ledger. No automatic retry, wallet activation
payment, rescoring or extra transfer was performed.

## 22:42 UTC — authenticated deployment resumed

Fly login is restored. The full eight-case live intent corpus passed on Vercel
`zai/glm-5.3`. The first run passed seven cases; an Ambient fallback classified
a changed-requirement revision as independent. The general continuation definition
now includes revisions of a prior artifact. Both runs are retained in verification
artifacts; this is a small synthetic corpus, not a production quality rate.

The final backend deployment is running. The optimized Corbanu operator candidate
is building. The launcher now checks the readiness PID against the actual child
process, accepts explicit thread resume only without bypassing its idle check, and
pins the terminal home. Kimi’s skill now describes six-board scope, scoped API
commands, immutable retries, and per-duty outcomes. Fixture checks pass.

## Production v706 — backend deployment complete

Release `v706` completed at 22:42 UTC with image
`registry.fly.io/tasknodeofficial-dev:deployment-01M1SVQNG1Z55PFQZAQD1CRDXZ`.
All configured background-role guards passed. The web page returns 200 and
the scoped board endpoint rejects an unauthenticated request with 401. A newly
provisioned credential reads exactly the six registry boards and current duties
through the production API. No mandatory duty was outstanding at that read.
Credential material remains in a private operator file; only its hash is stored
in PostgreSQL. The production terminal cutover remains the final step.

## 22:53 UTC — scoped Kimi cutover complete

The optimized Corbanu candidate and matching code-mode host are installed under
`/home/pfrpc/pf-boards/packages/reliability-20260905/`. The old terminal was
verified idle with an empty composer, exited normally, and resumed as PID 1776109
on the same thread `01a07030-4786-72d2-a7e4-87b077c8788f`. Its tool calls and
scoped `boards`/journal commands succeeded. The new supervisor is active with
zero restarts; readiness and successive successful tick records are fresh.
The old wake timer/service and compatibility/transcript code have been deleted.

Production evidence: `scoped-production-proof.json` records one committed Kimi
journal command, committed supervisor commands and the matching terminal/thread.
The API returned no mandatory duties, so no nonempty round was manufactured for
testing. Per-duty completion, blocked/deferred results and partial resume passed
PostgreSQL fixtures; the first naturally occurring nonempty scoped production
round remains an observation to collect. The older production Kimi verification
and network-offer round remains separate evidence, not proof of the new API path.

The live initialization uncovered missing CLI help for scoped commands. Help now
runs locally without a credential and explains round IDs and duty outcomes. An
empty `round-status` call gives an actionable usage error. Daily handoffs use a
board/date retry key so a previous day's immutable response cannot be reused.

All implementation and deployment work is complete. The Corbanu public release
is outside this operator deployment. Remaining observations: the first nonempty
scoped round and a larger production latency/quality sample. One historical
0.40-PFT payment remains held because its recipient account does not exist; no
retry, activation transfer, rescoring or invented payment rule was applied.

Final checks after operator cleanup: launcher/help fixtures, lint, formatting and
diff checks pass. The inference AST check covers 64 entries and 216 reachable
files with zero regex violations. Corbanu sprint records retain the previously
recorded shared-worktree/write-scope and duplicate-ID conflicts; no unrelated
sprint allocation was changed. The remaining PF-44 item is live observation,
not implementation or deployment.
