# Orc Durable Runtime

## Status

Phase 5 prototype, not deployed. The shipped Orc/Nazgul tooling can still use
tmux pane injection, but the new prototype gives us the replacement boundary:
a durable directive mailbox that an Orc worker can claim and complete without
Nazgul pasting text into a terminal.

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
2. Nazgul appends a `directive_enqueued` event to a durable mailbox.
3. One Orc worker claims the directive with `directive_claimed`.
4. The worker executes the directive through normal Orc tooling:
   `orcctl review next`, `orcctl review classify`, `orcctl request-followup`,
   `orcctl task ...`, `orcctl signal-user`, and `orcctl close-followup`.
5. The worker appends `directive_completed` with a concise result summary.

The queue is append-only. State is reconstructed from events so process restarts
do not lose pending or claimed directives. The runtime is intentionally separate
from wallet custody: seeds still come only from the existing
`TASKNODE_AGENT_WALLET_SEED` / session-cache path.

## Prototype

Prototype code lives in:

- `reference_clients/python/orc_tooling/runtime.py`
- `reference_clients/python/orc_tooling/runtime_cli.py`
- `reference_clients/python/orc_tooling/nazgul.py::dispatch_orc_runtime`

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
uv run orc-runtime complete orcdirective_... --status completed --result-json '{"summary":"done"}'
uv run orc-runtime run-once --orc grashnuk --worker-id grashnuk-runtime-1
```

`run-once` is deliberately a prototype executor. It proves claim/complete
durability and records `claimed_only`; it does not run Codex, submit task
transactions, spend rewards, or mutate Task Node board state.

## Event Contract

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

The prototype uses a file lock around reads and appends so one local worker can
claim a queued directive atomically. Production should move the same event shape
to Postgres with `SELECT ... FOR UPDATE SKIP LOCKED` or an equivalent queue
claim table before running multiple hosts.

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
2. Use `nazgul dispatch-runtime` for local prototype testing.
3. Replace the JSONL mailbox with Postgres queue tables using the same event
   contract.
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

The tests cover durable enqueue/claim/complete, prototype `run-once`, and
`dispatch-runtime` queueing without tmux injection.
