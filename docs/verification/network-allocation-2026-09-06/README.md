# Network allocation investigation — September 6, 2026

Production state was read from the deployed web machine `8d4930ae156638` on release v707 at approximately 13:43–13:49 UTC. No tasks, badges, capacity limits, rewards, or runtime configuration were changed during this investigation.

## Secondfmaster is eligible and has unused capacity

Identity resolution through `resolveUserIdentityVector({ handle: "secondfmaster" })` matched the app account, linked-wallet mirror, and recommended profile:

- Account: `acct_oauth_df7ee2b244f3217f13d34eea`.
- Public handle and linked GitHub username: `secondfmaster`.
- Active wallet: `rHHaTGGL3vUidkR644aSmsc6fMoHRNpPTh`, confirmed by runtime wallet records, wallet-link history, active PFTL sync, and owned task projections. The resolved vector contained no additional historical wallet.
- Durable badge: `core_contributor`, status `verified`, not revoked.
- Task-creation candidate verdict: `eligible: true`.
- Canonical capacity: limit 1, used 0, free slots 1; no blockers.
- No `network_task_allocations` rows for this account.

This is account-scoped eligibility with a confirmed delivery wallet. It does not by itself override an individual board's assignment restrictions or task/badge fit.

The production Task Node Fixes board explicitly restricts `assignable_handles` to `goodalexander`. The other five boards have empty routing-constraint objects. Thus secondfmaster's Core Contributor badge does not currently authorize assignment on Task Node Fixes itself; the full-board cadence threshold also blocks the other boards where suitable contributor work could be considered.

## Immediate blocker: every board hits the scheduler's three-open-task threshold

The deployed `idleEligibleContributors()` returned seven eligible contributors with free capacity, including secondfmaster. The deployed `computeBoardDuties()` returned zero duties for the six production boards.

| Board | Proposed or accepted tasks |
| --- | ---: |
| PF Terminal | 4 |
| Community Promotion | 5 |
| Post Fiat L1 | 4 |
| AI L1 Governance | 3 |
| Task Node Fixes | 3 |
| Capital Markets | 3 |

`scripts/bm/lib.mjs::computeBoardDuties` computes `Math.max(0, 3 - openCount)` and emits `routing_due` only when that value is positive. All six boards therefore suppress routing duties despite the nonempty eligible pool. Several companion board skills also specify at most three open tasks, so changing only the JavaScript would leave contradictory operating instructions.

The supervisor is alive, polling successfully, and sees the production Kimi terminal as ready. Its published state is `ready` with an empty round and `quiet` duty state. It cannot deliver a routing duty the server does not create. Kimi K3 remains the production selector.

Generation is functioning once work is allocated: three network allocations were created during the preceding 24 hours, and all three generation jobs reached `published`. Two allocations subsequently reached `rewarded`; one remains `proposed`. Recent successful `task_create` audits belong to `board_manager_pfterminal`.

## Staleness supervision does not cover the full operating contract

Accepted tasks created on August 7 and August 8 still occupy board capacity. Creation age alone is insufficient to cancel a task; the manager must inspect submission/contact history.

Their latest recorded task events are also old: `task_4ec86f14eea5d3d61bcb7956a23ffb10` on August 7, and `task_a053012be777cf3ae51b7ff59336b322` plus `task_2aecc5ff81d841385cf53e4de36481d7` on August 8. These are concrete follow-up candidates, not automatic cancellation authorization.

The manager skill specifies accepted-task follow-up at seven days and cancellation after fourteen days without submission or contact. `computeBoardDuties` explicitly schedules old proposed tasks, but has no corresponding accepted-task or unanswered-verification staleness duty. A full board can therefore report quiet without directing Kimi to assess the old accepted work keeping it full.

## Separate confirmed review API defect

Round `round_8257b2b3-c1bc-443b-8e64-24f66b54b32e`, completed at 11:53:56 UTC, records a zero-PFT rejection of `task_3d0bbda2` because the agent could not inspect the submission and verification evidence through the scoped API. The preceding round asked the contributor to resupply evidence for the same visibility reason.

The source confirms the missing read boundary: `boardPacket()` returns task summary buckets, and the scoped dispatcher has no task submission/evidence read command. An infrastructure visibility failure must produce a blocked review with an operator-visible reason, rather than count as contributor failure or consume verification rounds. Restore a board-scoped evidence reader before treating this review interface as complete. Reconsider the affected decision only after evidence and canonical task state are inspected; this investigation does not reverse rewards or decisions.

## Repairs identified during the initial investigation

1. Reconcile the three-open-task board cadence policy with the intended use of available contributors. If the blanket threshold is replaced, update both duty computation and board skills, while retaining badge/work fit, account capacity, assignment restrictions, and reward-budget enforcement.
2. Represent eligible contributors blocked by board cadence as visible blocked work, rather than an empty/quiet workload.
3. Schedule the accepted-task and verification follow-ups already required by the manager's operating contract, using actual last contact/submission state and leaving cancellation decisions to Kimi.
4. Restore scoped submission and verification evidence reads. Require a blocked review outcome when evidence cannot be read because of an API failure.
5. Add regressions for a full board with eligible idle contributors, accepted-task follow-up, scoped evidence access and denied cross-board access, and infrastructure failures that must not become contributor rejections.

The underlying database receipts are retained in the private operator scratch directory `/mnt/HC_Volume_101713660/pfrpc/scratch/tasknode-network-allocation-audit-20260906`. This report intentionally omits credentials and other contributors' private account material.


## Repair and focused verification

The repair removes the fixed three-open-task ceiling from duty computation and the installed board skills. Routing duties now carry the eligible contributor pool and preserve assignment restrictions, badge eligibility, account capacity, and reward budgets. A change in the eligible pool produces a fresh duty identity rather than being hidden by a prior round's backoff.

Staleness uses the latest creation, task-event, or contact timestamp; projection refresh timestamps do not reset it. Proposed offers become cancellation candidates at seven days; accepted work gets follow-up at seven days and becomes a cancellation candidate at fourteen days without contact or submitted evidence. Unanswered verification gets follow-up at 72 hours. Kimi retains the decision. The new `task cancel --stale-only` dry-run and execution path recheck eligibility. Execution fences the exact prior status and activity versions and refuses to overwrite concurrent contact, submission, or reward state. Existing mirror synchronization and cancellation replay guards remain in place.

The scoped `task detail <id>` command exposes requirements, original submission, verification response, source event IDs, and activity state. Cross-board reads are denied. Review and verification writes now refuse unavailable source evidence with an explicit blocked-review error. This does not reverse the historical rejection described above.

Verification used the disposable local PostgreSQL database `tasknode_routing_20260906`, separate from production:

- `node scripts/board-routing-staleness-smoke.mjs`: full boards at 3, 5, and 20 open tasks still route; assignment restrictions remain; seven/fourteen-day boundaries; recent contact and submitted work protected; eight protected state/activity cases; a real concurrent transaction invalidates stale cancellation; scoped evidence reads succeed and cross-board access fails; unavailable evidence blocks rejection and verification writes.
- `node scripts/board-manager-cancel-network-task-smoke.mjs`: proposed/accepted cancellation, mirror synchronization, paid/personal/submitted protections, reducer replay and direct-write cancellation guards.
- `node scripts/network-task-capacity-smoke.mjs`: canonical capacity, including six concurrent requests for the last slot.
- `node scripts/board-agent-reliability-smoke.mjs`: concurrent command retries, scope, rollback, and round completion evidence.
- `node scripts/board-manager-v0-smoke.mjs`: existing manager contract.
- `npm run lint`, `npm run format-check`, `git diff --check`, and `npm run build`: passed.
- `node scripts/inference-no-regex-check.mjs`: passed, 64 entry files and 218 reachable files.
- `npm run api-reference-check`: 169 policies match the generated inventory.
- `node scripts/bm.mjs --help`: updated commands are present.

The updated repository skills were installed with `bash ops/bm-runtime/bm-install-skills.sh`; the existing production Kimi K3 terminal and supervisor remain in use. No Corbanu binary replacement or additional manager loop is required.

Targeted cancellation audits now capture the scoped task detail instead of rebuilding the global planning corpus inside the command transaction. This removes unrelated source reads from cancellation. The command response explicitly distinguishes `dry_run`, `cancelled`, and `skipped`, and states when `--execute` is still required. The scoped fixture verifies both the preview and committed cancellation through the real command dispatcher.


## Live rollout

Release v708 deployed successfully, including migration registration, remote image build, Fly machine checks, and the background-worker guard. At 15:16:43 UTC the production scoped API returned eight duties: three `stale_accepted` and five `routing_due`, each eligible board including secondfmaster in its seven-person candidate pool. The Task Node Fixes assignment restriction remained in force.

The existing supervisor delivered `round_f2fdf903-deb6-4788-b6a9-55c03b8f8a2b` at 15:16:37 UTC to the existing Kimi K3 thread `01a07030-4786-72d2-a7e4-87b077c8788f`. No additional manager process was started.

The production `task detail task_3d0bbda21f3eaf3221380827b0c5791b` command returned the original submission and verification response as readable, with five source events and no truncation. This proves access through the formerly missing evidence boundary. The historical task remains in its recorded terminal state; no reward decision was reversed.

Two early cancellation previews hit `Query read timeout` before committing. Their saved retry keys subsequently recovered successful previews. This exposed the unnecessary global source-packet construction corrected in the follow-up patch described above. Preview receipts do not mean tasks were cancelled; production state and executed audit results are the verification source.


At 15:23:12 UTC the scoped production API confirmed all three old accepted tasks were cancelled:

- `task_a053012be777cf3ae51b7ff59336b322` — Kimi executed its cancellation at 15:20:33 UTC.
- `task_2aecc5ff81d841385cf53e4de36481d7` — completed Kimi's already-selected preview through the same scoped API with `--stale-only --execute`; the response confirmed the task and allocation were cancelled.
- `task_4ec86f14eea5d3d61bcb7956a23ffb10` — completed the already-selected preview using the same guarded command; task and allocation were cancelled.

The latter two HTTP command calls returned in 522 ms and 124 ms after v709 removed the global planning reads. These are two observed calls, not a latency benchmark. The newer accepted task `task_0378d312d18c5e7d67cf7c2423ec062f`, with September 4 activity, stayed accepted and ineligible for cancellation. The available contributor pool increased from seven to eight, and Task Node Fixes received a routing duty for its one permitted contributor.

A final regression checks that changing the eligible pool cannot let a manager mark routing complete without an actual successful task creation while that board still has routing demand. Cancellation can change pool membership in the middle of a round; that change must wake new work without weakening completion proof.

The live manager also attempted a historical operator referral using unset account/wallet environment variables. The scoped dispatcher now returns HTTP 400 with the specific missing flag, rather than an opaque retriable HTTP 500. All three required create fields are covered in the fixture. A live invalid-input request confirmed `board_agent_required_flag:account` without creating a task. Current identities are available through the board packet; no account identity was invented or hard-coded into task routing.


## Verified outcome

Final release **v711** passed deployment and background-worker checks. Three stale accepted tasks are cancelled in both projections and allocation records. The recently active accepted task remains intact.

Kimi created five real allocations across PF Terminal, Post Fiat L1, AI L1 Governance, Capital Markets, and Community Promotion. At 15:34:49 UTC secondfmaster's PF Terminal allocation `netalloc_25d4fe10298b32ef9bf0fe6802ac97d8` reached **published**, and task `task_c9412113667f8b174cce30f2d21ebed5` reached **proposed** in the canonical task projection:

> Write Two Terminal-Ownership Regression Tests for CorbanuTerminal

Request: `req_net_5ab0d7057c25e69954c68cf4fea7cd4c`. Offer event: `offchain:evt_d066079ecc92df048a8aecac`; payload reference: `postgres:evt_d066079ecc92df048a8aecac`. These are the production offchain lifecycle references, not claims of an onchain transaction or IPFS publication. The scoped board API and database are the verification surfaces; a browser render was not required for this backend repair.

The other four allocations were still queued or generating at this observation. The production manager and workers remain running to process them. This report confirms routing through publication for secondfmaster and durable routing for the other four; it does not claim those four offers were already visible.

The bounded evidence is in [live-repair-proof.json](live-repair-proof.json). Full private receipts, deployment logs, and fixture logs remain on the mounted data volume under `tasknode-routing-fixture-20260906`.
