# Reliability audit documentation verification

Date: September 5, 2026.

Deliverable: [audit and implementation plan](../../plans/tasknode-reliability-audit-2026-09-05.md).

## Scope

This phase changed documentation and wrote sanitized audit evidence. It did not
change runtime code/configuration, deploy, submit tasks, invoke models, send
messages, restart agents or issue rewards. Existing uncommitted work in Task
Node and Corbanu Terminal was preserved. Corbanu was inspected read-only; no
Corbanu plan or implementation sprint was activated.

The Task Node skill's documentation checks apply. Corbanu's development skill
was used for read-only integration review and future implementation requirements.
Its product citation is “Shipping MVP — LIVE,” Task Node and identity:
“Tasks, evidence, verification, rewards, balances, chat, context, linked
identity, and live Task Node-linked Nostr identity.” Interactive proof,
release benchmarks and human release sign-off are not claimed in this phase.

## Evidence collection

- Public `/health` response: healthy web service; no broader workflow claim.
- One public `/api/system/status` read, reduced to counts/status/timestamps.
- Bounded production SQL inside `BEGIN READ ONLY`, followed by `ROLLBACK`:
  last five Task Manager run outcomes, 24-hour aggregate counts, completed
  request timing aggregates, and three response-shape summaries.
- Local tmux process-tree metadata and selected model flags; no pane content,
  prompts, environment dump or credential output.
- Local routing/supervision configuration and selected source-file SHA-256
  digests, retained in [observations.json](observations.json).

The timing sample contains 15 completed receipts and excludes failures. It is
not an end-to-end latency benchmark. Observed selector outputs violated the
requested field shape; no live repair or new task creation was attempted.
Potential request-ownership and concurrency defects are static findings, not
production exploit/fault-injection results.

## Documentation updated

- Current system, wiki authority/index, provider provenance and regex coverage.
- Task async engine, lifecycle/replay, generation and network preparation.
- Terminal API contract and Kimi/GLM/legacy board-management ownership.
- Tasks surface intake, readiness, storage and worker descriptions.
- User guide models and already-shipped Docs unlock/folder behavior.
- Context Refine, network profile, badge evaluation, secretary packet, database,
  deployment/bootup, Deathmarch and QA model references.
- Historical model inventory notice points to the current provider map.
- Three replaced architecture documents were preserved under
  `docs/archive/2026-09-05-task-architecture/`, labeled as historical snapshots.

No new private Markdown loader was added to `src/features/docs/docs-content.js`.
Its existing public source loaders already load the updated allowlisted pages;
the audit, new internal contract and raw evidence remain outside that list.

## Checks

- `npm run format-check`: passed.
- `npm run public-help-check`: passed; 26 explicitly allowlisted Markdown sources.
- `git diff --check`: passed.
- Focused Markdown newline/whitespace and local-link checks: passed for 24
  Markdown files and 85 local links; results are retained in `checks.json`.
- Source consistency: all 30 inspected runtime file hashes still matched at
  final verification.

The repository format checker does not include Markdown, so a separate focused
check covers the new plan/contracts and edited Markdown. Historical snapshots
retain their original content and historical references. No broad runtime
suite, browser sweep, Rust build or deployment check was run for documentation.
