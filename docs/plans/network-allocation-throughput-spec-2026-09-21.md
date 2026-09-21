# Network task allocation: throughput repair spec

Date: September 21, 2026. Repository: `/home/pfrpc/repos/tasknode`. Audience: the agent implementing this. Read the `tasknode` skill first; it is the operating contract for this repo.

## Why this spec exists

The Kimi board-manager allocation system does not allocate. In the seven days to 02:00 UTC today:

| Measure                                               | Value                                                                                         | Source                        |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------- |
| Badge-verified contributors with no live network task | 35                                                                                            | `task-create-and-rounds.json` |
| Active boards                                         | 7 (6 managed by Kimi)                                                                         | `allocation-state.json`       |
| Supervisor rounds completed                           | 89                                                                                            | `task-create-and-rounds.json` |
| Duties recorded                                       | 623, of which 22 `completed`                                                                  | same                          |
| `task create --execute` commits                       | 4 (three to the operator's own account on `board_tasknode_fixes`, one on `board_pf_terminal`) | same                          |
| Distinct accounts offered any network task, 14 days   | 3                                                                                             | `allocation-state.json`       |
| Live network allocations right now                    | 1                                                                                             | same                          |
| Newest generation job (01:41 today)                   | failed after 3 identical attempts on `task_intent_assessment_schema_invalid`                  | same                          |

The September 19 audit and repair (`docs/verification/task-hive-allocation-audit-2026-09-19/`, `docs/verification/task-hive-allocation-repair-2026-09-19/`) fixed the supervisor deadlock, candidate truncation, exhausted-queue stranding and mirror drift, across seven image iterations. Rounds now complete. Throughput did not return, because the remaining failures are in the parts nobody measures: the classifier rejects valid tasks, the manager writes prose instead of routing, and each board's "grounding source" is a brittle host-local dependency that the manager treats as a reason to do nothing.

Evidence for every number above is in `/home/pfrpc/Task Node Requests/network-allocation-evidence-2026-09-21/` (read-only production probes, rerunnable).

## Failure chain, confirmed

### F1. The intent classifier rejects valid work and the job burns all retries on a deterministic failure

`server/task-intent-assessment.js` sends `response_format: { type: "json_schema", strict: true, ... }` to `INFERENCE_MODELS.structured` (currently `zai/glm-5.3` via Vercel). The provider does not enforce the schema. Replaying today's failed job's exact input (`intent-raw-output.json`) returns, with `finish_reason: stop`:

```json
{
  "classification": "independent",
  "reason": "The request is a concrete, scoped bug fix ...",
  "newOutput": "A code fix in the Task Node server route layer ...",
  "priorTaskIds": []
}
```

That is a correct semantic answer with the wrong key (`classification` for `relationship`) and two missing booleans (`actionable`, `scopeClear`). The system prompt never names the required keys; it relies entirely on `response_format`. `validateTaskIntentAssessment` rejects it, `assessTaskIntent` wraps it as `network_task_intent_assessment_failed:task_intent_assessment_schema_invalid` with `retryable: true`, and `network-task-generation-jobs.js` retries the identical input twice more, 60 seconds apart, then fails the job. Nothing about the model's output is persisted (the catch fires before the `intentAssessment` UPDATE), so the operator sees a code and nothing else. The 30-day failure table shows the same family: `needs_review:uncertain` ×3, `provider_timeout` ×2, `schema_invalid` ×1, `duplicate` ×1, out of 7 recent failures; at least the schema case, and probably some `uncertain` cases, are classifier defects rather than judgments about the work.

### F2. The manager treats a board as a single lane and "nothing routable" as an acceptable outcome

Every one of the last ten rounds recorded the same six outcomes (`supervisor-rounds-tail.jsonl`):

- `board_pf_terminal`: deferred, "lane covered by live offer task_a3696…" (one proposed task to one contributor is treated as filling the board).
- `board_tasknode_fixes`: deferred, "lane occupied by live offer … proposed to goodalexander".
- `board_postfiat_l1v2`: deferred, "generation remains PAUSED: local main diverged (ahead 2053 / behind 1065 vs origin)".
- `board_community_promotion`: deferred, "nitter RSS returned 0 items, syndication empty".
- `board_capital_markets`: blocked, "gated on operator merge of agtico/agtico.github.io PR 1".
- `board_ai_l1_governance`: deferred, "lanes maintainer-owned".

`routingDuty` in `server/board-task-policy.js` hands the manager the full list of eligible idle contributors with free slots and says "there is no fixed ceiling; do not report quiet while eligible contributors remain". The skill (`ops/bm-runtime/skills/board-manager/SKILL.md`, "The routing pass: capacity is demand") says an idle eligible contributor is a management defect and requires either grounded work or a routed investigation per member. None of that is enforced. `recordDutyResult` accepts any `deferred`/`blocked` with 12+ characters of prose. So the manager's real behaviour is one task per board, then defer forever, and the system records that as 89 successful rounds.

### F3. Grounding sources are host-local and brittle, and their failure is treated as "no work"

- `board_postfiat_l1v2`'s skill says to generate from the current checkout and stop if it cannot be confirmed current. The checkout on the operator host is a divergent fork (ahead 2053 / behind 1065). The board has produced nothing for at least ten rounds because of a git state on one machine.
- `board_community_promotion` depends on a nitter RSS mirror that returns zero items. The board has produced nothing.
- `board_capital_markets` is waiting on an operator merge that nobody is tracking as a blocking action item with an owner and a due date.

None of these are engine restrictions. They are missing inputs, and the manager reports them as if they were routing decisions.

### F4. Failure is invisible

There is no metric for "eligible idle contributors" versus "tasks created", no per-board time-since-last-allocation, and no alert when a board defers N rounds in a row. Runtime status shows round counts and duty outcomes, which is why 89 rounds with 4 tasks looked healthy. The cross-round escalation added on September 20 (`ops/bm-runtime/supervisor.mjs`) deliberately excludes `routing_due` because it recurs legitimately; it therefore cannot see this failure.

## Scope

In scope: the classifier contract and retry policy; enforcement of the routing rule per eligible contributor; robust grounding sources for the three starved boards; allocation health metrics and alerts; a recovery of today's failed job. Out of scope: badge policy, reward caps, capacity rules, the reward publisher, supervisor delivery mechanics (already repaired), and any change to who may be assigned on `board_tasknode_fixes`.

Do not add a fallback that generates a task without a passing intent assessment, and do not weaken the duplicate/uncertain hold for genuine semantic verdicts. The point is to stop rejecting valid work and to stop accepting non-work as a round outcome.

## Work items

### W1. Classifier contract: prompt, normalization, repair retry, persisted raw output

Files: `server/task-intent-assessment.js`, `server/network-task-generation-worker.js`, `server/repositories/network-task-generation-jobs.js`, `scripts/task-intent-assessment-smoke.mjs`.

1. Name the schema in the prompt. The system message must state the exact JSON shape with key names, enum values and types, and one literal example. Keep the semantic guidance; add the contract. Do not rely on `response_format` alone for any provider.
2. Normalize before validating. Add `normalizeTaskIntentAssessment(raw)` that maps documented aliases to canonical keys (`classification`/`verdict`/`relation` → `relationship`; `prior_task_ids`/`priorTasks` → `priorTaskIds`; `new_output` → `newOutput`; `scope_clear` → `scopeClear`), coerces `"true"`/`"false"` strings to booleans, and drops unknown keys only when every required canonical key is present after mapping. It must not invent `actionable` or `scopeClear`: if either is missing after normalization, the response is still invalid.
3. One in-call repair attempt. When validation fails on a parsed object, send a second request in the same `assessTaskIntent` call with the model's own output and the exact validation error appended ("Your previous response was rejected: <error>. Return only the JSON object with keys …"). Persist both attempts' raw content. If the repair also fails, throw as today. Bound this to one repair per call.
4. Persist the raw model content on failure. Extend the job's `generated_task_payload.intentAssessment` (or a sibling `intentAssessmentFailure`) with `{ causeCode, provider, model, finishReason, contentPreview (≤2000 chars), attempts }` before throwing, using the same attempt-fenced UPDATE pattern the success path uses. Operators must be able to see what the model said.
5. Stop retrying deterministic failures as if transient. `task_intent_assessment_schema_invalid`, `_json_invalid`, `_unknown_reference`, `_reference_required` and `_continuation_output_required` after a repair attempt are `retryable: false` at the job level. Timeouts, 429s, 5xx and truncation stay retryable. A non-retryable classifier failure must fail the job with a distinct code (`network_task_intent_contract_failed:<cause>`) so board packets and `history` do not show it as a semantic hold or a provider outage.
6. Board packet and `history` must show, for each failed job: the failure family (provider / contract / semantic hold), the cause code, and the content preview. `scripts/bm/lib.mjs` already exposes `generation_failures`; extend it.

Acceptance: a fixture where the provider returns today's exact content (`intent-raw-output.json`) passes validation after normalization without a repair call; a fixture returning `{}` triggers exactly one repair request and, if the repair returns valid JSON, succeeds; a fixture where the repair also fails persists both raw contents on the job, fails it non-retryably with `network_task_intent_contract_failed`, and consumes one attempt, not three; the live qualification probe pattern from `docs/verification/task-hive-allocation-repair-2026-09-19/qualification-probe.mjs` run against today's job returns `independent/actionable/scopeClear` with zero mutations.

### W2. Recover today's failed job

Job `nettaskjob_7a9fb8fb01fe1877217375b6f77edb11`, allocation `netalloc_7a9fb8fb01fe1877217375b6f77edb11`, board `board_tasknode_fixes`, need "Fix the Task Node API crash on GET requests with a double-slash path". After W1 is deployed to the taskgen worker, use the existing guarded path: `bm task create board_tasknode_fixes --retry-failed …` through the scoped API (see `scripts/bm/writes.mjs:200` and the repair recovery record for the exact receipt pattern). Preserve job/allocation/intent IDs and lifetime attempts. Confirm one request, one offer event, one visible proposed task for the assignee. Do not create a second allocation for the same need.

### W3. Enforce the routing rule per eligible contributor

Files: `server/board-agent-rounds.js`, `server/board-task-policy.js`, `scripts/bm/lib.mjs`, `ops/bm-runtime/supervisor.mjs`, `ops/bm-runtime/skills/board-manager/SKILL.md` (and its installed copy at `/home/pfrpc/.corbanu/skills/board-manager/SKILL.md`, kept identical).

1. Structured routing outcomes. A `routing_due` duty result must carry, in addition to the free-text reason, a per-candidate disposition array: `[{ account_id, disposition: routed|investigation_routed|not_served, task_id?, reason_code?, reason }]` covering every `candidate_ids` entry on the duty. `validateDutyResult` rejects a routing result that omits any candidate. Add a `--dispositions <json>` flag to `duty-result`. `reason_code` is an enum: `no_badge_fit`, `source_unavailable`, `budget_exhausted`, `capacity_taken_this_round`, `restricted_board`, `contributor_declined_recently`, `other`. `other` requires ≥40 characters of reason.
2. Completion semantics. `routed` and `investigation_routed` must be backed by a `task_create` audit with `executed=true` in this round for that `account_id` (extend the existing routing-completion proof query). A routing duty whose dispositions include zero `routed`/`investigation_routed` entries is recorded as `not_served`, a new outcome distinct from `deferred`, and is never `completed`.
3. Cross-round routing escalation. In the supervisor's blocker tracker, track `routing_due` by board when the outcome is `not_served` in consecutive rounds while `candidate_ids` is non-empty. Threshold 3 rounds. On threshold: ALERTS.log line naming the board, the count of unserved eligible candidates, and the dominant `reason_code`; runtime-status `Stalled:` line; and a work-order directive that lists each unserved candidate by handle and badge and requires either a task or a `reason_code` for each. Keep the September 20 exclusion for `deferred` routing so that legitimately empty rounds do not alert.
4. Skill text. Replace the "lane" mental model explicitly: "A live offer to one contributor does not occupy a board. Route to every eligible idle contributor whose badges fit, or record a per-contributor `reason_code`." Add: "A missing or stale grounding source is `source_unavailable`; it is not a routing decision. Record it, then route investigations that do not need that source." Add the `--dispositions` usage.

Acceptance: a fixture round with a `routing_due` duty of three candidates rejects a result covering two; a result with three `not_served` entries records `not_served` and cannot be `completed`; three consecutive `not_served` rounds for the same board trigger the alert and directive; a `routed` disposition without a matching executed `task_create` audit is rejected with 409.

### W4. Grounding sources that do not depend on the operator host

Files: board skills under `ops/bm-runtime/skills/`, `scripts/bm/lib.mjs` (board packet sources), a new `server/board-sources.js` (or similar) with fetchers.

1. `board_postfiat_l1v2`: grounding comes from the canonical remote, fetched by the API into the board packet (recent commits, open issues/PRs, README index) via the GitHub API with a cached snapshot and a `fetched_at`. The skill must stop instructing the manager to inspect a local checkout. If the remote fetch fails, the packet carries `source_status: unavailable` with the error, and W3's `source_unavailable` applies; the manager still routes investigations that only need the public repository URL.
2. `board_community_promotion`: replace the nitter RSS dependency with the official X API using the existing credentials on the host (see `/home/pfrpc/x_access.txt`, `/home/pfrpc/xcreds.txt`; the implementer must confirm which is current and keep secrets out of the repo), or the website's own feed. Same `source_status` contract.
3. `board_capital_markets`: a blocked-on-operator item becomes a durable operator action in the board packet (`operator_actions: [{ id, description, since, owner }]`) surfaced in runtime status, instead of a free-text blocker repeated every round. The board still routes work that does not depend on that action.
4. Every board packet must expose `sources: [{ id, kind, status, fetched_at, error? }]` so a source outage is visible in one place.

Acceptance: board packet for each of the three boards shows a `sources` entry with status and timestamp; with the GitHub fetcher mocked to fail, the l1v2 packet reports `unavailable` and the routing duty still lists candidates; the local checkout is not referenced anywhere in the l1v2 skill.

### W5. Allocation health as a first-class signal

Files: `server/board-agent-runtime-status.js`, `server/system-status*` (whatever System Status already reads), `scripts/bm/lib.mjs`, `ops/bm-runtime/supervisor.mjs`.

Publish, per board and in aggregate: eligible idle contributors; tasks created (executed) in the last 24 h and 7 d; distinct accounts offered in 7 d; time since last executed `task_create`; consecutive `not_served` rounds; generation job failure counts by family (provider / contract / semantic) in 7 d; live allocations by status. Alert (ALERTS.log and runtime-status) when aggregate eligible idle ≥ 10 and executed creates in 24 h = 0. Extend System Status so "generation fresh" is not shown as allocation health; the page must show routing liveness next to it.

Acceptance: a fixture with 12 idle and zero creates in 24 h alerts; the runtime-status transcript for a board includes `Allocation:` lines with these numbers; System Status renders the aggregate.

### W6. Deployment and verification

Follow the layered-image method used on September 19–20 (record in `docs/verification/…`): confirm every replaced file's SHA-256 in the running image matches the pre-change commit, build per-process overlays, run the suites inside the images, push, then update the API machine (`8d4930ae156638`) and the taskgen worker machine (`7813e21f1295d8`; standby `e827021fd67708` carries the same image). Restart the host supervisor unit `tasknode-kimi-supervisor.service` for W3/W5 supervisor changes. Get explicit operator approval before touching production machines; do all preparation first so approval is the last step.

Recovery is proven only by the sequence the audit defined: selection → allocation/job → assessment → request → one offer event and projection → correct wallet's Tasks API → contributor-visible offer, for a representative set across boards, including at least one contributor who was never offered anything in the last 14 days. Observe at least two full rounds after deploy. Report tasks created, accounts offered, and per-candidate dispositions, not round counts.

## Ordering and estimates

1. W1 + W2 first (small, unblocks tasks immediately; roughly half a day including image build and the recovery).
2. W3 (one day; the enforcement is the core behavioural change).
3. W5 (half a day; makes W3's effect measurable).
4. W4 (one to two days; three fetchers plus skill rewrites; can run in parallel with W3 by a second agent if owned by file: W3 owns `board-agent-rounds.js`, `board-task-policy.js`, `supervisor.mjs`, SKILL routing sections; W4 owns `board-sources.js`, packet sources in `lib.mjs`, board-specific skills).
5. W6 throughout; production changes only with approval.

## Non-goals and guardrails

- No synthetic or template tasks. A task exists only after a passing intent assessment and the existing generation, schema and readiness checks.
- No change to badge, capacity, reward cap, or `assignable_handles` rules.
- No manager provider change; Kimi stays the task-selection owner. This spec changes what the system accepts from Kimi and what it shows Kimi, not who decides.
- Never delete rounds, jobs, allocations or audit rows to clear a metric. Reconcile with new rows and preserved history.
- Secrets stay on the host; the repo gets configuration names only.

## Evidence

- `/home/pfrpc/Task Node Requests/network-allocation-evidence-2026-09-21/allocation-state.json` — job counts, recent jobs, failure causes, allocations by day, live allocations, distinct accounts offered, boards, audit command counts.
- `…/task-create-and-rounds.json` — every `task_create` audit in 7 days, idle eligible count, round/duty totals.
- `…/intent-raw-output.json` — the classifier's actual output for today's failed job, captured by `intent-raw-probe-20260921.mjs`.
- `…/supervisor-rounds-tail.jsonl` — the last 60 supervisor events with per-duty outcomes.
- Probes are read-only (`SET TRANSACTION READ ONLY`); the classifier probe made one paid inference call and no database mutation.
