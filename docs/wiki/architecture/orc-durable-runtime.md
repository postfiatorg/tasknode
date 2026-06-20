# Orc Durable Runtime

## Status

Phase 5 prototype, not deployed. The shipped Orc/Nazgul tooling can still use
tmux pane injection, but the durable-runtime boundary now has a production
Postgres queue/claim table plus a local JSONL fallback. It lets an Orc worker
claim and complete directives without Nazgul pasting text into a terminal. The
supervised worker process is still not implemented.

## Problem

The current Nazgul path controls Orcs by reading and writing tmux panes:

1. `nazgul dispatch` picks the next shared Orc review item.
2. `nazgul` builds a natural-language directive.
3. `inject_directive` writes the directive into a tmux pane with
   `tmux load-buffer`, `paste-buffer`, verifies one pasted-content chip, and
   sends Enter.

That is useful for supervising human-visible Codex panes, but it is not a
durable operator runtime. A pane can be closed, pasted text can be missed,
manager state is inferred from screen text, and the system has no first-class
queue claim that says which Orc owns which work item.

## Target Runtime

The durable runtime makes the handoff explicit:

1. Nazgul chooses work through the shared Network Task triage capability.
2. Nazgul enqueues a directive in the durable mailbox.
3. One Orc worker atomically claims the next queued directive.
4. The worker executes the directive through normal Orc tooling:
   `orcctl review next`, `orcctl review classify`, `orcctl request-followup`,
   `orcctl task ...`, `orcctl signal-user`, and `orcctl close-followup`.
5. The worker appends `directive_completed` with a concise result summary.

The production path stores queue state in Postgres table
`orc_runtime_directives`; the local fallback remains the append-only JSONL event
mailbox. The runtime is intentionally separate from wallet custody: seeds still
come only from the existing `TASKNODE_AGENT_WALLET_SEED` / session-cache path.

## Queue Backends

Runtime code lives in:

- `reference_clients/python/orc_tooling/runtime.py`
- `reference_clients/python/orc_tooling/runtime_cli.py`
- `reference_clients/python/orc_tooling/nazgul.py::dispatch_orc_runtime`

### Postgres Production Path

When `--database-url` is passed or one of the Task Node database URL environment
variables is configured, `orc-runtime` and `nazgul dispatch-runtime` use
`orc_runtime_directives` from migration
`server/db/migrations/068_orc_runtime_directives.sql`.

The table stores:

- `directive_id`, `orc`, `directive`, `task_id`, `source`;
- `status` enum: `queued`, `claimed`, `completed`, `failed`, `cancelled`;
- `worker_id`, `claimed_at`, `completed_at`, `attempt_count`;
- `metadata_json`, `result`, `created_at`, `updated_at`.

Claiming uses `SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1` inside a transaction
and updates the selected row to `claimed`. That makes concurrent workers safe:
two workers claiming the same Orc queue do not receive the same directive. A
partial unique index on active claimed `worker_id` prevents a worker from owning
multiple live claims at the same time.

Before each Postgres claim, the runtime can recover one stale `claimed` row for
the requested Orc when `claimed_at` is older than the configured TTL. The
default is six hours (`TASKNODE_ORC_RUNTIME_CLAIM_TTL_SECONDS=21600`), and `0`
disables the recovery pass. Recovery is scoped to the requested Orc queue; it
does not scan or steal other Orcs' active work. The previous worker and claim
timestamp are retained in `metadata_json.lastStaleClaimRecovery`.

### JSONL Local Fallback

Default local mailbox:

```text
~/.cache/tasknode/orc_runtime/orc_runtime_events.jsonl
```

Commands:

```bash
cd /home/pfrpc/repos/tasknodeofficial/reference_clients/python

uv run nazgul dispatch-runtime grashnuk
uv run orc-runtime status --orc grashnuk
uv run orc-runtime claim --orc grashnuk --worker-id grashnuk-runtime-1
uv run orc-runtime complete orcdirective_... --worker-id grashnuk-runtime-1 --status completed --result-json '{"summary":"done"}'
uv run orc-runtime run-once --orc grashnuk --worker-id grashnuk-runtime-1
```

`run-once` is deliberately a prototype claim helper. Without an embedded
executor it claims one directive and returns `result.mode =
prototype_claim_only` in the command output, but it does not mark the directive
completed. A real supervised worker must complete the directive after it
actually invokes the Orc capability. The command does not run Codex, submit task
transactions, spend rewards, or mutate Task Node board state.

## JSONL Event Contract

`directive_enqueued`:

- `directiveId`
- `orc`
- `directive`
- `taskId`
- `source`
- `metadata`
- `createdAt`

`directive_claimed`:

- `directiveId`
- `orc`
- `workerId`
- `claimedAt`

`directive_completed`:

- `directiveId`
- `orc`
- `workerId`
- `status`
- `result`
- `completedAt`

The JSONL fallback uses a file lock around reads and appends so one local worker
can claim a queued directive atomically. It is a local compatibility path, not
the production multi-host queue.

Completion is ownership-checked: a directive must be in `claimed` status, and
the `workerId` supplied to `orc-runtime complete` must match the worker that
claimed it. Terminal rows remain idempotent, but queued rows and rows claimed by
another worker are not completed by ID alone.
Both backends accept only terminal completion statuses: `completed`, `failed`,
or `cancelled`. The legacy `claimed_only` CLI status is normalized to
`completed` for compatibility with the prototype `run-once` flow; it is not
persisted as a fourth runtime state.

Enqueue is also idempotent for active source work. When `taskId` is present,
the runtime will not queue a second `queued` or `claimed` directive for the same
`orc + source + taskId`; it returns the existing directive with
`reason=active_directive_exists`. Once the existing directive reaches a terminal
status, the source task can be dispatched again if a new review pass is needed.

## Security And Secrets

- The mailbox must never store seeds, mnemonics, private keys, or session
  tokens.
- The runtime helpers pass all payloads through the existing secret redactor.
- The directive is an instruction, not an authority override. Actual task
  mutations still flow through `TaskNodeAgentClient` signed actions and the
  existing double-submit/session-store protections.
- Nazgul runtime dispatch records an `orc_operator_interactions` audit row when
  a database URL is available.

## Migration Plan

1. Keep tmux path as compatibility: `nazgul dispatch`.
2. Use `nazgul dispatch-runtime` to enqueue runtime directives.
3. Prefer Postgres `orc_runtime_directives` when a database URL is configured;
   fall back to JSONL only for local/no-DB operation.
4. Add a supervised Orc worker process that claims runtime directives, invokes
   the same `orcctl` capabilities, and writes `orc_run_journal`.
5. Update the Nazgul UI/CLI to prefer runtime dispatch once the worker is
   supervised and observable.
6. Retire tmux injection for normal operation; keep pane capture only as a
   debugging/inspection affordance.

## Verification

Focused tests:

```bash
cd /home/pfrpc/repos/tasknodeofficial/reference_clients/python
uv run python -m unittest tests/test_orc_tooling.py
uv run --with ruff ruff check orc_tooling tests/test_orc_tooling.py
```

The tests cover durable enqueue/claim/complete, stale-claim recovery, prototype
claim-only `run-once`, and `dispatch-runtime` queueing without tmux injection. Set
`TASKNODE_ORC_RUNTIME_POSTGRES_TEST_URL` to a disposable Postgres database URL
to exercise the SKIP LOCKED claim path with concurrent workers.
