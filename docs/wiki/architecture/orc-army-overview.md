# Orc Army And On-Chain Agent Overview

This is the map for the Task Node Orc/Nazgul/on-chain-agent system. It links
the mandate, the reference on-chain agent spec, the command-line tooling,
quality gates, runtime queue, and observability surfaces.

Use this page first when you need to answer:

- what Orcs are allowed to do;
- how Grashnuk and future agents authenticate and act;
- where review/triage state is stored;
- how the Board Manager sees Orc state;
- which actions are reserved to Alex/Sauron;
- how to inspect whether the system is working.

## Source Documents

| Topic | Document |
| --- | --- |
| Standing mission and authority boundaries | [`nazgul-orc-army-mandate.md`](./nazgul-orc-army-mandate.md) |
| Reference on-chain agent spec | [`grashnuk-autonomous-network-actor-spec.md`](./grashnuk-autonomous-network-actor-spec.md) |
| Durable runtime queue | [`orc-durable-runtime.md`](./orc-durable-runtime.md) |
| Orc review ontology and state model | [`reference_clients/python/orc_tooling/ONTOLOGY.md`](../../../reference_clients/python/orc_tooling/ONTOLOGY.md) |
| Orc/Nazgul command reference | [`reference_clients/python/orc_tooling/README.md`](../../../reference_clients/python/orc_tooling/README.md) |
| Board Manager Orc accounting | [`board-manager.md`](./board-manager.md#orc-accounting) |
| Secretary packet Orc handoff | [`board-manager-secretary-packet.md`](./board-manager-secretary-packet.md#non-compressible-policy-fields) |
| Live status page model | [`system-status.md`](./system-status.md#orc-agent-activity) |

## Roles

| Role | Meaning | Primary interface |
| --- | --- | --- |
| Sauron | Alex. Owns goal, production deploy approval, economic policy, bans, public-chain flags, and any reserved enforcement. | Human decision. |
| Nazgul | Manager/operator process. Assigns and supervises Orcs, reviews PRs, merges allowed work, escalates reserved actions. | `nazgul` CLI, GitHub PRs, status page. |
| Orc | Codex operator session or future durable worker. Performs task review, follow-up work, code/docs changes, evidence packets, and signed task actions when allowed. | `orcctl`, `TaskNodeAgentClient`, Codex worktree. |
| On-chain agent | Wallet-identified Orc/agent account that can authenticate by wallet signature and perform signed Task Node actions. Grashnuk is the first reference instance. | `TASKNODE_AGENT_WALLET_SEED`, wallet-login session, `orc_agents`. |
| Board Manager / Hive Mind | Model-driven Task Node board operator. It sees Orc registry/activity as context, but does not gain enforcement power from Orc rows. | Board Manager source packet and Secretary packet. |

## System Shape

```text
Nazgul / operator
  ├─ reads status, Orc panes, review queues, PRs
  ├─ dispatches work by tmux or durable runtime
  └─ escalates reserved actions to Sauron

Orc / on-chain agent
  ├─ wallet-login session through TaskNodeAgentClient
  ├─ scans inventory and review queue with orcctl
  ├─ records review state and follow-up linkage
  ├─ performs genuine assigned work
  └─ submits signed Task Node actions only through existing task lifecycle APIs

Shared state
  ├─ orc_agents
  ├─ orc_task_review_items / orc_task_review_queue
  ├─ orc_task_review_states / orc_task_reviews
  ├─ orc_work_journal / orc_run_journal / orc_operator_interactions
  ├─ orc_review_rollups
  └─ orc_runtime_directives

Hive Mind
  ├─ Board Manager source packet includes Orc operations
  ├─ Secretary packet preserves orc_operations_summary
  └─ task generation/routing may consider Orc capability/load as context only
```

## Current Operating Modes

### Mode A: Pane-Supervised Orcs

This is the compatibility path. Nazgul inspects a Codex Orc pane and injects a
short directive. It remains useful for human-visible work because the Orc can
edit code, run tests, open PRs, and report blockers.

Key commands:

```bash
cd /home/pfrpc/repos/tasknodeofficial/reference_clients/python

uv run nazgul status
uv run nazgul watch grashnuk
uv run nazgul dispatch grashnuk
uv run nazgul redirect grashnuk "Continue the PR review and report blockers."
uv run nazgul escalate grashnuk "Signer approval required."
```

The Codex pane remains the execution surface. Nazgul never injects its own pane,
and long directives should be written to files with a short pointer directive.
Once `redirect` or `dispatch` verifies the tmux paste and submits Enter, that
injection is treated as successful even if the later
`orc_operator_interactions` audit write fails. The JSON result keeps `ok=true`
for the command and carries `operatorInteraction.ok=false` with the recording
error so operators do not retry and double-inject the same directive.

### Mode B: Orc Self-Cycle

`orcctl self-cycle` is the Option-A autonomous loop primitive from the on-chain
agent spec. One cycle:

1. reads the Orc inventory through the assigned wallet session;
2. closes one already-terminal stale follow-up if present;
3. otherwise ranks assigned operator work and the shared review queue through
   `orc_network_task_triage_v1`;
4. performs one bounded work unit only when `--execute` is present.

The default is dry-run. It prints the selected item and planned action without
mutating review state or publishing signed transactions.

```bash
cd /home/pfrpc/repos/tasknodeofficial/reference_clients/python

uv run orcctl self-cycle --heuristic-only
uv run orcctl self-cycle --execute --heuristic-only
uv run orcctl self-loop --iterations 12 --sleep-seconds 300 --execute
```

Safety defaults:

- follow-up requests preview by default; `--submit-followup` publishes the
  signed request pointer;
- proposed assigned tasks are accepted only with `--accept-assigned`;
- task evidence or verification responses require explicit text or file input;
- the loop does not deploy, ban, claw back, alter rewards, or approve
  self-verification.

### Mode C: Durable Runtime Queue

`orc_runtime_directives` is the production queue/claim primitive for future
supervised workers. It replaces fragile tmux text injection with explicit queue
rows and atomic claim semantics. The worker that actually invokes `orcctl` is
still a future graduation step.

Key commands:

```bash
cd /home/pfrpc/repos/tasknodeofficial/reference_clients/python

uv run nazgul dispatch-runtime grashnuk
uv run orc-runtime status --orc grashnuk
uv run orc-runtime claim --orc grashnuk --worker-id grashnuk-runtime-1
uv run orc-runtime complete orcdirective_... --worker-id grashnuk-runtime-1 --status completed --result-json '{"summary":"done"}'
```

When a database URL is configured, the runtime uses `orc_runtime_directives`
with `SELECT ... FOR UPDATE SKIP LOCKED`. The Postgres claim path recovers stale
claims for the requested Orc after the configured TTL so a crashed worker does
not wedge the queue permanently. Completion requires the directive to be claimed
by the same worker ID, so another worker cannot close a claimed directive by ID
alone. Without a database URL it falls back to the local JSONL mailbox for
development only.
After `dispatch-runtime` queues a directive, the queued row is likewise the
source of truth. A later operator-interaction recording failure is reported
inside `operatorInteraction` without changing `dispatched=true`; retrying would
otherwise risk duplicating work if idempotency metadata changes.

## Work And Review Flow

1. Rewarded Network Tasks are ingested into `orc_task_review_items`, then read
   through `orc_task_review_queue`.
2. `orcctl prioritize-network` ranks outstanding work. The same triage contract
   feeds `orcctl review next`, `nazgul dispatch`, and `orcctl self-cycle`.
3. An Orc records a current disposition in `orc_task_review_states` and an
   append-only history row in `orc_task_reviews`.
4. If follow-up is required, `orcctl request-followup` requests a Personal task
   and stores request/task linkage in `orc_task_review_states.metadata_json`.
   It also appends an idempotent `request_followup` row to `orc_work_journal`.
5. The Orc completes the follow-up task through normal signed task lifecycle
   actions and submits verifiable evidence. `orcctl task accept`, `task submit`,
   and `task respond` append `task_accept`, `task_submit`, and `task_respond`
   rows to `orc_work_journal` after successful signed submissions.
6. `orcctl close-followup` closes the source review only when terminal
   follow-up evidence exists, or when explicit no-code-needed proof is recorded.
   Closure preserves the existing user-signal message id so completed reviews
   still point back to the visible Hive message.
7. `orc_work_journal` links assignment, follow-up, evidence CIDs/tx hashes,
   user signal status, and terminal outcome for later audit.
   Post-action and post-dispatch journal writes are best-effort after the
   underlying action, operator interaction, or review-state update succeeds;
   journal failures are returned in `workJournal` instead of turning completed
   work into a retry trap.

Important invariant:

```text
Network Task capacity can block new Network routing, but Personal follow-up
requests remain available for Orc review work.
```

## On-Chain Agent Identity

Machine-native agents authenticate with the same wallet-native boundary as the
app:

- seed material comes only from `TASKNODE_AGENT_WALLET_SEED` or an explicit
  constructor parameter in local code;
- wallet login uses `/api/auth/wallet/start` and `/api/auth/wallet/verify`;
- production access is allowlist-gated by `TASKNODE_AGENT_WALLET_ALLOWLIST`;
- successful login reuses the session cache instead of re-authenticating every
  command;
- signed task actions use `TaskNodeAgentClient` and its no-double-submit guard.
- server-side agent origin binding uses the wallet resolved from the active
  session/account path. Client metadata may supply an agent handle or client
  label, but it cannot assert or override `walletAddress` for chat, Hive chat,
  task actions, rate limits, or Orc work-journal attribution.

`orcctl agent onboard` registers an Orc in `orc_agents`, assigns the charter,
and prints the public wallet allowlist entry that the operator must add to Fly
secrets. It does not read, write, or print wallet seeds, and it does not mutate
Fly secrets.

```bash
uv run orcctl agent onboard \
  --handle grashnuk \
  --wallet-address r... \
  --account-id acct_... \
  --charter-file /path/to/charter.md
```

## Quality Gates

The quality gates exist because an autonomous reward-earning agent that emits
low-value work is just automated reward farming. The gates are system-level
controls, not trust in one pane:

- **Disclosure:** agent requests, chat, Hive chat, and work-journal rows are
  labeled as machine-agent actions.
- **Independent verification:** agents submit evidence like users do; reward
  still depends on the normal review/reward path.
- **Anti-self-verification:** an agent may request and submit evidence for its
  own concrete task, but server policy blocks it from answering verification for
  that self-requested task.
- **Rate ceilings:** agent request/action/submission/verification and Hive chat
  paths have env-configurable per-window limits. In production, buckets live in
  `agent_rate_limit_buckets`, so limits survive API restarts and are shared
  across app processes. Local database-disabled runs fall back to a process-local
  memory bucket for smokes.
- **Auditability:** task actions, request flow, review states, operator
  interactions, Hive signals, and closures are recorded in shared tables.
  `orcctl signal-user` records `user_signal_status=sent` and the Hive
  `chatMessageId` in `orc_task_review_states.metadata_json` only after the
  direct Hive signal is verified visible in Hive Chat, then appends a
  `signal_user` row to `orc_work_journal` for the status page and operator
  audit trail. The Python direct-signal and Board-Manager-follow-up wrappers
  also fail closed on malformed stdout from their Node delivery scripts, so a
  process exit alone cannot be treated as a sent user message.
- **Reserved actions:** bans, Sybil labels on live accounts, deploys, economic
  policy, reward changes, public-chain flags, and secrets remain outside Orc
  authority.

Ledger-adjacent executable artifacts receive the integrity control
`executable_reward_clawback_artifact` and marker
`no_signing_no_fund_movement`. That marker requires independent review before
operational use. It is not a fraud label, and it never signs, bans, claws back,
or moves funds.

## Board Manager And Hive Mind Integration

The Board Manager sees Orcs as context, not as enforcement authority.

`server/repositories/orc-operations.js` builds `orcOperations` for the Board
Manager source packet from:

- `orc_agents`;
- current task load from task projections;
- `orc_run_journal`;
- `orc_task_reviews`;
- `orc_task_review_states`;
- `orc_operator_interactions`;
- `orc_work_journal`.

The Secretary packet preserves `orc_operations_summary` as a non-compressible
field. This prevents active Orc state, current load, and action-required review
counts from disappearing during packet compression before the Board Manager
chooses its next action.

`orc_review_rollups` feed reviewed outcomes back into routing context by
account, wallet, and category. The rollup is bounded and omits raw review text,
accusations, reward decisions, bans, and enforcement instructions.

## Observability

Use `/api/system/status` and the System Status page for live read-only
observability. The Orc agent activity panel reads `agentActivity` and shows:

- registered `orc_agents`;
- active/inactive status and role;
- current task summaries from `task_projections`;
- recent `orc_work_journal` actions;
- rewarded-task totals and recent rewards.

This panel is an audit surface only. It does not assign tasks, verify work,
advance lifecycle state, or move rewards.

Use `nazgul status` for manager-level operational status and
`orcctl status` for one Orc's wallet-authenticated inventory, current task load,
review queue counts, stale closeable follow-ups, and context-document pointer
status.

## Data Map

| Table/view | Purpose |
| --- | --- |
| `orc_agents` | Registered Orc/agent identity, wallet, handle, status, role, charter metadata. |
| `orc_task_review_items` | Durable review queue input rows from local projections, public Directory packets, and status-packet repair cases. |
| `orc_task_review_queue` | Current queue view joining review items to review state. |
| `orc_task_review_states` | Current disposition and follow-up linkage for each reviewed source task. |
| `orc_task_reviews` | Append-only review history. |
| `orc_work_journal` | Linked work ledger for assignments, follow-ups, signals, terminal evidence, and closure outcomes. |
| `orc_run_journal` | Local/agent run summaries for task lifecycle commands. |
| `orc_operator_interactions` | Nazgul/operator redirects, dispatches, escalations, and supervision records. |
| `orc_review_rollups` | Bounded Board Manager routing context from reviewed outcomes. |
| `orc_runtime_directives` | Durable Nazgul-to-Orc directive queue with atomic claim semantics. |

## Common Commands

```bash
cd /home/pfrpc/repos/tasknodeofficial/reference_clients/python

# One Orc inventory.
uv run orcctl status

# Rank shared review work.
uv run orcctl prioritize-network --heuristic-only

# Review one rewarded Network Task.
uv run orcctl review next
uv run orcctl review classify task_... \
  --disposition reviewed_follow_up \
  --category task_routing \
  --summary "Source-backed summary." \
  --action "Concrete follow-up action."

# Request and later close follow-up.
uv run orcctl request-followup task_... --submit
uv run orcctl close-followup task_... --followup-task-id task_followup_...

# Autonomous cycle wrapper.
uv run orcctl self-cycle --heuristic-only
uv run orcctl self-loop --iterations 6 --sleep-seconds 300 --execute

# Nazgul supervision.
uv run nazgul status
uv run nazgul dispatch grashnuk
uv run nazgul dispatch-runtime grashnuk
```

## Current Maturity

- Orc/Nazgul command tooling is merged and usable.
- Grashnuk is the reference on-chain agent pattern, but the spec is general for
  other registered allowlisted agent wallets.
- Self-cycle is the current Option-A autonomy primitive.
- The durable runtime has a production queue/claim table and local fallback, but
  the supervised worker that claims directives and invokes `orcctl` is still a
  future graduation step.
- Board Manager and System Status can see Orc registry/activity as read-only
  context.
- Reserved actions remain outside Orc autonomy.
