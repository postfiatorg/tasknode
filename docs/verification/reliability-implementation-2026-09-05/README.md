# Reliability implementation evidence

Documentation and the evidence collected for the completed implementation are
finalized. The [implementation ledger](../../plans/tasknode-reliability-implementation-2026-09-05.md)
records production v706 and the scoped Kimi cutover. Earlier dated blockers in
that ledger are historical.

| Boundary | Recorded evidence | What it proves |
| --- | --- | --- |
| Receipts, queues and capacity | [Backend fixtures](backend-fixtures.json) | Concurrent retry identity, stale-attempt fencing, preserved payment uncertainty, shared intake and capacity races; synthetic providers. |
| Browser recovery | [Browser fixture](browser-request-recovery.json) | Actual React/IndexedDB lost-response recovery, reload, two-tab identity and account isolation. |
| Task-intent model | [Final live corpus](task-intent-live-evaluation.json), [first run](task-intent-live-evaluation-first.json) | Eight final synthetic cases pass on Vercel GLM 5.3; the initial seven-of-eight result is retained. This is not a production accuracy rate. |
| Spreadsheet assistants | [Coach](coach-sheet/sheet-results.json), [ODV](odv-sheet/results.json) | Deployed editor, large fixture replies, channel history, cell context and desktop/mobile containment; not live assistant-model quality. |
| Production recovery | [v706 read](production-v706-recovery.json), [recovery and latency](production-recovery-and-latency.json) | Recorded reward/rejection repairs and a real network offer; one sample does not establish latency percentiles. |
| Scoped Kimi API | [Production proof](scoped-production-proof.json) | Real committed Kimi journal command, supervisor commands, ready terminal and preserved thread. No nonempty duty round existed at cutover. |
| Documentation checks | [Final checks](documentation-final-checks.json) | API-reference consistency, public-help boundary, formatting and clean whitespace diff. |
| Source identity | [Source manifest](candidate-source-manifest.json) | Hashes of the changed Task Node files, including prior work; no commit or push is implied. |

The sibling CorbanuTerminal repository contains exact executable hashes and
real PTY recovery/resume evidence under
`qa/reliability/2026-09-05-tasknode-recovery/`: `candidate.json`,
`cli-recovery.json`, `tui-recovery.json`, `control-replay.json` and the `pty-*.txt`
checkpoints. Its source manifest was verified against all 25 recorded files.
The operator candidate is installed; a public versioned release was out of scope.

## Remaining observations and limitations

- The first naturally occurring nonempty scoped production round remains to be
  observed. Per-duty outcomes and partial resume passed PostgreSQL fixtures.
  PF-44 remains open for that observation; no artificial production task was made.
- Larger production latency and quality samples remain to collect.
- A historical 0.40-PFT payment is held because its recipient account does not
  exist. No activation transfer, retry or rescoring was performed.
- Corbanu's global sprint checker retains recorded duplicate-ID and shared-worktree
  conflicts. This is not presented as a passing global check.
