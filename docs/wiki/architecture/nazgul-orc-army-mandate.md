# Nazgûl / Orc Army Mandate

> Standing orders for the autonomous orc army that audits and operates the Task
> Node ecosystem. The Nazgûl (Claude Code manager) reads this every tick; the
> orcs (Codex CLI in tmux) execute against it. Referenced by the Nazgûl
> scheduler tick.

## Mission

An **army of orcs** works the Task Node ecosystem continuously. Four objectives,
in priority order:

1. **Triage every user's task.** Classify each network/rewarded task as
   *real-action-needed* / *invalid-or-duplicate* / *already-handled*, and record
   the disposition. The backlog is large; work it in priority order, do not
   re-triage what is already terminal.
2. **Detect Sybils and abuse — recommend, never execute.** Surface suspected
   Sybil clusters, duplicate-submission patterns, and reward-abuse patterns.
   Persist the evidence and a *recommendation*. **Banning, slashing, or any
   enforcement is reserved to Sauron (Alex).** Never execute a ban. Never mark
   fraud as *proven* unless the evidence is independently verifiable; default to
   *suspected*.
3. **Spawn real action.** When triage reveals a genuine codebase/governance gap,
   the orc opens the follow-up task, does the work, and submits it. Orcs act,
   they do not only audit. (Circular self-tasking for genuine gaps is intended
   and allowed; reward-farming is not.)
4. **The Hive Mind accounts for orc operators.** The Board Manager source packet
   includes `orc_agents` so generator/Secretary/decision logic reasons about orc
   operators, not only human contributors.

## Operating model

- **Nazgûl** = the manager LLM (Claude Code). Kept alive by the harness
  scheduler (a recurring self-prompt), **not** by tmux injection into its own
  pane. Each tick: read every orc pane → decide (direct / review+merge /
  escalate) → inject the next directive → end turn. Never tmux-inject its own
  pane.
- **Orc** = a Codex CLI session in tmux. Does the work: triage, review, code,
  commit, open PRs. Read-only & bounded by default; acts only via signed
  `TaskNodeAgentClient` flows.
- **Sauron** = Alex (the principal). Owns goal, sign-off, and every reserved
  action.

## Injection mechanics (Nazgûl → Orc)

The tmux path is the visible/manual compatibility path. Durable runtime
dispatch is now available through `nazgul dispatch-runtime` and `orc-runtime`;
it writes directives to Postgres when a database URL is configured and falls
back to JSONL for local/no-DB operation. Until the supervised Orc worker exists,
tmux injection or an explicit `orc-runtime` claim remains the execution bridge.

```
tmux send-keys -t <pane> -l '<directive>'; sleep 1; tmux send-keys -t <pane> Enter
```

- Directive **must be < 170 chars** (one visual line). Longer → terminal
  wrapping → codex reads it as multi-line → Enter adds a newline instead of
  submitting. For long instructions, **write them to a file and send a short
  pointer** to the file.
- Don't verify within ~4s of injecting; orcs take up to 60s to start working.
  Re-check on the next tick.
- Always target by tmux pane id (`%3`, `%4`), never auto-resolve.

## Tooling layers

**Orc-execution** (`reference_clients/python/orc_tooling/`, merged):

- `orcctl` — the orc's hands: `review next`, `review classify`,
  `request-followup`, `task ...`, `signal-user`, `close-followup`,
  `prioritize-network`. Generalized `--agent` so any allowlisted Codex orc can
  execute.
- `TaskNodeAgentClient` — signed Task Node actions; seed from env only,
  `submit=False` default, double-submit guard.
- `orc-runtime` (Phase 5) — durable directive mailbox replacing tmux
  injection. It uses the `orc_runtime_directives` Postgres queue
  (`server/db/migrations/068_orc_runtime_directives.sql`) when a DB URL is
  configured, with `SELECT ... FOR UPDATE SKIP LOCKED` claims, scoped stale
  claim recovery, ownership-checked completion, and a JSONL fallback for local
  operation. `run-once` is still claim-only; see `orc-durable-runtime.md`.

**Nazgûl-monitoring** (`orc_tooling/nazgul.py` → `nazgul` CLI):

- `nazgul status` / `watch` / `redirect` / `dispatch` / `dispatch-runtime` /
  `escalate`. The manager oversees via commands + shared DB state
  (`orc_agents`, `orc_activity`, `orc_run_journal`, `orc_operator_interactions`),
  not raw pane-scraping alone.
- Shared review work is read from `orc_task_review_queue`, now backed by
  `orc_task_review_items`: local `task_projections` rows remain the richest
  `local_projection` source, while public Directory rewarded-task packets can be
  ingested as `directory_public` rows so all orcs see the same public rewarded
  task population.
- Review rows carry a derived Network Task status packet
  (`allocationState`, `taskState`, `rewardMovement`, `repairRequired`). This is
  a read model over projections, allocation rows, generation jobs, refs, and
  events. It is not manually set and does not rewrite lifecycle state. The queue
  deliberately admits positive-paid, zero-closed, duplicate-guarded, and
  repair-required rows so Orcs do not confuse operational repair with reward
  outcome.
- Review rows can also carry ledger-adjacent integrity controls. Executable
  reward/clawback artifacts receive the signal
  `executable_reward_clawback_artifact` plus control marker
  `no_signing_no_fund_movement`, requiring independent Orc review before
  operational use. This is not a fraud accusation and it does not enforce,
  sign, claw back, ban, or move funds; Sauron owns those decisions.
- Actionable review rows carry follow-up linkage in `metadata_json`.
  `request-followup` records the Personal follow-up request id and task id when
  known; `orcctl status` surfaces stale closeable follow-ups once the linked
  task reaches `rewarded`, `refused`, or `cancelled`. Closure remains explicit:
  `status --close-stale` or `close-followup` must see terminal task evidence or
  a no-code-needed proof. Reviews never auto-close at request time.
- Nazgûl work assignment and closure also append linked rows to
  `orc_work_journal`. The table does not replace `orc_operator_interactions` or
  review state; it connects dispatch/redirect/escalation/close-followup events
  to the source task, follow-up request/task, event CID, tx hash, operator
  handle, blocker, and terminal outcome so `nazgul status` can account for what
  work was assigned and what actually closed.
- Reviewed outcomes feed back into Board Manager routing context through
  `orc_review_rollups`, a bounded view over `orc_task_review_states` joined to
  review items/projections by account, wallet, and task category. The source
  packet carries counts, repeated integrity-signal labels, last reviewed task
  id, and timestamps only. It does not carry raw review text, accusations,
  reward decisions, bans, or enforcement instructions.

## Guardrails — reserved actions (escalate to Sauron, never execute)

- **Enforcement against humans:** account blacklisting/bans, Sybil labels
  applied to live accounts. *Recommend only; Sauron executes.* **Clawback of
  paid PFT is not possible** — never recommend it; already-paid PFT is
  non-recoverable, and remediation for proven abuse is blacklisting the account,
  not fund recovery (Sauron ruling, 2026-06-19).
- **Real money / mainnet / payout policy:** any change to reward amounts, payout
  routing, or economic parameters. Task-Node real-reward/mainnet is gated.
- **Prod deploys:** merging to `main` is authorized for orc-tooling/docs under
  the autonomy grant, but **deploying to the live Task Node API is gated.**
- **Public-chain flags / secrets:** never flip a public-chain flag, never touch a
  secret/key/seed.

Everything else proceeds under the autonomy grant below.

## Autonomy grant

> Code decisions do **not** block on Sauron. The worst that can happen is we
> revert code — that is acceptable. Keep the loop running overnight; manage all
> orcs; do not arbitrarily stop. (Alex, 2026-06-19.)

The Nazgûl merges reviewed orc-tooling/docs PRs, redirects idle orcs to the
next priority, and escalates only the reserved actions above.

## Phase map

- **Phase 0–4 — tooling merge.** `orcctl` + `nazgul` CLI + monitoring/review/
  priority/reward-monitor tooling merged to main (PRs #81–#87). **Done.**
- **Phase 5 — durable runtime.** JSONL directive mailbox + `orc-runtime` CLI +
  `dispatch-runtime` (PR #88), plus the Postgres queue table
  `orc_runtime_directives` (migration `068_orc_runtime_directives.sql`),
  `SELECT ... FOR UPDATE SKIP LOCKED` claiming, stale-claim recovery, idempotent
  active-source enqueue, ownership-checked completion, and claim-only
  `run-once`. **Queue/claim primitive done.** Next: a supervised Orc worker
  process that claims directives, invokes `orcctl` capabilities end-to-end, and
  records completion/journal results.
- **Phase 6 — orc-accounting in the Hive Mind.** `orc_agents` + orc activity in
  the Board Manager source packet (migration `062_orc_agents_and_activity.sql`,
  PR #83), plus the linked `orc_work_journal` assignment/outcome ledger
  (migration `066_orc_work_journal.sql`) and review-outcome rollups for routing
  context (migration `067_orc_review_rollups.sql`). **Accounting primitives
  merged; ongoing work is operational coverage.** The Board Manager must reason
  about orc operators the same way it reasons about human contributors.

## Non-goals

- Not economic policy. Reward caps/payouts are Sauron's.
- Not enforcement. Bans are Sauron's.
- Not spec design. Implement what exists / what Alex rules; do not redesign the
  Board Manager unilaterally.
