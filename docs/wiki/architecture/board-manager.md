# Board Manager

The Board Manager is the leased Hive decision worker. It reads the compact Hive
source packet, asks the configured decision model for one action, validates that
action against the registry, and writes durable run/action evidence before any
board mutation is considered complete.

System Status row: `board_manager`

## Runtime Boundary

- Process: Fly `board-manager` process group.
- Entrypoint: `npm run start:board-manager`.
- Primary scripts: `scripts/board-manager-worker.mjs`,
  `scripts/board-manager-model-exec.mjs`, and
  `scripts/board-manager-ops.mjs`.
- Source tables: `board_manager_scopes`, `board_manager_runs`,
  `board_manager_jobs`, `board_manager_leases`, and
  `board_manager_action_results`.
- User-message delivery table: `board_manager_user_messages`.
- Open follow-up table: `board_manager_followups`.
- Network Task intent table: `network_task_intents`.
- Current Hive action results are rendered in the Hive surface as inspectable
  agent activity.

## Generation Intelligence

The Board Manager source packet now treats operator routing intent as
first-class generation context, not incidental prose that can disappear during
compression. `server/repositories/board-manager.js` extracts
`operatorStandingPolicy` from Hive Context, Secretary facts, and recent run
facts, builds the default `generationQualityPolicy`, and adds a bounded
`networkTaskOutputCorpus` with prior task ids, public CIDs/tx hashes, summaries,
repeated themes, and a `deduplicationWatchlist`
(`server/repositories/board-manager.js:514`,
`server/repositories/board-manager.js:539`,
`server/repositories/board-manager.js:607`). The corpus builder is bounded by
recent project-linked task rows and compact event summaries; it does not decrypt
or inject raw private evidence.

`prompts/hive/board_manager_v1.md` makes Network Task generation action-first:
pure documentation-only tasks are low value by model policy, the preferred next
step after a document is an action or delivery handoff, and
`decision_basis.source_facts` should cite prior task ids, CIDs, or tx hashes
when the decision relies on prior work (`prompts/hive/board_manager_v1.md:59`,
`prompts/hive/board_manager_v1.md:87`). This is prompt policy and model
context. It is not a deterministic code gate, task cap, blocklist, reward cap,
or automatic rejection rule.

`payload.network_task` carries model-authored audit/context fields so operators
can see what the Board Manager intended the downstream task generator to use:
`action_output`, `delivery_surface`, `recipient_or_reviewer`,
`escalation_stage`, `lineage_task_ids`, `referenced_outputs`,
`deduped_against`, and `why_not_duplicate`
(`server/repositories/board-manager.js:100`,
`server/repositories/board-manager.js:153`). These fields are preserved in the
normalized decision payload (`server/repositories/board-manager.js:242`) and
flow to Network Task generation for transparency. They do not approve, reject,
or suppress work in code.

The document-to-action ladder used by the prompts is:

1. If the prior output only documents a problem, the next task should require a
   concrete action such as a PR, mock, Discord handoff, direct collaboration,
   field test, or shipped artifact.
2. If a fix or mock already exists, the next task should route review,
   integration, publishing, or operator handoff instead of asking another member
   to re-document the same issue.
3. If the corpus shows overlapping prior outputs, the Board Manager should name
   what it referenced and what it deduped against in
   `decision_basis.source_facts`, `referenced_outputs`, and
   `deduped_against`.

## Capability Instrumentation

The Board Manager source packet also carries capability instrumentation. This
is context only, not enforcement. `server/repositories/board-manager.js` builds
`capabilityInstrumentation` from optional project metadata, eligible candidate
profiles, and durable capability-profile rows in
`board_manager_capability_profiles` (`server/db/migrations/058_board_manager_capability_profiles.sql`).
The packet can describe:

- `code_task`: work that requires code, PR, commit, deployment, or repository
  proof.
- `documentation_task`: report/memo/audit work whose output is only prose.
- `capability_gating_task`: proof-gathering work that establishes whether a
  contributor can access or deliver on a surface before substantive work is
  routed.
- `evidence_evaluation_packet`: an advisory packet that classifies submitted
  evidence as verified, unverifiable, or self-attested.

Capability requirements are read only when a project explicitly declares them
in metadata (`required_capabilities`, `requiredCapabilities`,
`capability_requirements`, or `routingConstraints.requiredCapabilities`).
Candidates default to no verified private-surface capability until a durable
capability-profile row says so. Network Diagnostic Report output and profile
claims are preserved only as declared context; they do not become verified repo
or channel access. A verified capability row is scoped by account, project,
capability type, safe scope label, scope digest, evidence reference, verifier,
timestamp, and optional expiry. Expired and revoked rows are visible as audit
context but do not satisfy a capability requirement.

The instrumentation deliberately avoids exposing private repo/channel
membership. Raw scopes are converted to safe labels and short digests. The
Board Manager may cite a missing verified capability as context, ask for a
capability proof, route a public-artifact task, or ask the operator for the
smallest missing decision. It must not treat this field as a deterministic
gate, wallet ban, reward cap, blocklist, or automatic rejection rule.

Reviewed operators can verify or revoke capability profiles through
`POST /api/hive/capability-profile`, guarded by
`TASKNODE_CAPABILITY_PROFILE_ADMIN_TOKEN`
(`server/capability-profile-routes.js`). The route writes only the durable
capability-profile audit row; it does not mutate task lifecycle, capacity,
reward, custody, or public directory state. Long-term verifier authority and
whether proof tasks are paid remain operator policy decisions.

When Board Manager chooses `initiate_network_task`, `payload.network_task` also
carries model-authored `task_work_type` using the vocabulary above. This value
is persisted into Network Task generation source metadata and the encrypted
request bundle as audit context. It is not part of semantic idempotency and does
not approve, reject, or suppress any task in code.

## JSON Handling Hardening

The Board Manager decision provider parses strict JSON, retries once with a
schema-guided repair prompt when provider output is malformed, and then fails
closed with `do_nothing` if repair also returns malformed JSON
(`server/board-manager-decision-provider.js:139`,
`server/board-manager-decision-provider.js:161`,
`server/board-manager-decision-provider.js:180`,
`server/board-manager-decision-provider.js:352`). A fail-closed decision
records why no board mutation executed, so malformed provider text cannot become
an unvalidated action.

The Secretary packet path has the same shape: it repairs malformed JSON once,
then writes a deterministic source-derived fallback packet that preserves
non-compressible operator policy and generation-quality fields instead of
silently dropping them (`server/board-manager-secretary-packets.js:180`,
`server/board-manager-secretary-packets.js:243`,
`server/board-manager-secretary-packets.js:702`).

## Status Derivation

Green means the `global_hive` scope is enabled and the latest completed run is
fresh for the configured cadence. A fresh running run is also green.

Amber means failed Board Manager jobs were updated inside the recent failure
window. Historical failed jobs remain in counts for audit but do not keep the
row amber forever.

Red means the scope is missing, paused, disabled, stale beyond cadence, the
latest run failed, or a running run is stale.

## Debug And Repair

Start with the scheduler and Fly process state:

```bash
npm run board-manager:ops -- status
npm run fly:board-guard
fly status -a tasknodeofficial-dev
```

If the scope is paused, resume it deliberately:

```bash
npm run board-manager:ops -- resume --reason "operator recovery"
npm run board-manager:ops -- enqueue --reason "operator recovery run"
```

Inspect `board_manager_jobs.last_error`, `board_manager_runs.error`, provider
secrets, and action-hook errors before retrying. Do not manually mutate Hive
project rows while the Board Manager scope is enabled unless the repair is a
bounded data fix with a recorded reason.

If a user receives repeated Hive messages, inspect recent `message_user` runs,
`board_manager_user_messages`, and `board_manager_followups` first. A delivered
message must create one open follow-up keyed by account and, when known,
project. New Hive input from that account marks open follow-ups answered. The
action hook should skip duplicate responses to the same Hive Context entry and
should skip account/project messages while an open follow-up is waiting for the
user. A repeated-message burst means the follow-up row was missing, expired
incorrectly, or the Board Manager found a materially new blocker.

Task-action Hive messages also require a runtime `message_precondition`.
Any Board Manager `message_user` action that asks a user to accept, decline,
review, verify, unblock, or otherwise act on a Network Task must name the
related task id or allocation id plus the task/allocation statuses that must
still be true at send time. The action hook rebuilds the account live state
immediately before delivery. If the task was refused, rewarded, cancelled,
expired, replaced by another allocation, below the user's recorded reservation
rate, or already has an open follow-up that contradicts the message, the
message is skipped and an audit result records the stale precondition. This is
the guard that prevents "please accept this task" nudges from being delivered
after the user already refused or completed the task.

If the board creates duplicate project cards, inspect the create result. The
`create_project` hook checks active and archived project rows before inserting.
When a matching archived row exists, the correct action is `restore_project`
unless an operator archive lock is present. When a matching active row exists,
the correct action is to refresh the project document, assign a contributor, or
initiate a Network Task under that existing project.

If the board generates repetitive Network Tasks, inspect `network_task_intents`
before the generation jobs. Intent idempotency is semantic: project, candidate,
task class, normalized project need, and reward band. A repeated Board Manager
run should return `network_task_semantic_intent_exists` instead of enqueueing a
second job for the same work.

If the board keeps choosing `do_nothing` while a user appears eligible for
Network Tasks, inspect `boardActionPressure` before trusting a project document
or older follow-up summary. `eligibleCandidateCount > 0` means at least one
candidate is live after outstanding tasks and pending generation jobs are
accounted for. Other users' stale tasks, orphaned allocations, generated-but-
unlinked jobs, and open follow-ups do not globally block that candidate. Recent
refusals are routing feedback, not a current capacity status, unless the live
packet includes an explicit availability constraint. A recent stopped task with
no newer replacement task or generation job should create action pressure even
when the project still has older work open.

Capacity matching is wallet-aware. A Network Task with a concrete candidate
wallet consumes capacity for that wallet, not forever for every future wallet
the same account links. If an account delinks `rOld` and links `rNew`, an active
task on `rOld` remains auditable but must not make `rNew` unavailable for
routing. Pending work without a candidate wallet is the fallback account-level
blocker until the wallet is known.

Capacity verdicts come from one shared predicate,
`listNetworkTaskCapacityBlockers` in
`server/repositories/network-task-capacity.js`, used identically by the
`initiate_network_task` executor hook, `getNetworkTaskEligibility`, and
`boardActionPressure.candidateCapacity`. Liveness is allocation-status based
with no time window (an accepted task older than 24 hours still blocks),
ignores task class (an active `alpha` allocation blocks a `network` allocation
and vice versa), excludes allocations whose `task_projections` status is
terminal, and excludes wallet-bound allocations whose wallet is no longer an
active linked user wallet. `npm run network-task-capacity-smoke` asserts the
three call paths agree.
